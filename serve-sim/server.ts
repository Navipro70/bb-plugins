// bb-plugin-serve-sim — backend entry.
//
// Runs Evan Bacon's serve-sim (https://github.com/EvanBacon/serve-sim) as a
// child process on the Mac that hosts the BB server, and exposes its preview
// URL to the Simulator tab (app.tsx), the `bb serve-sim` CLI, and agents.
//
// serve-sim does the heavy lifting: it captures the booted iOS Simulator's
// framebuffer, streams it (H.264 / MJPEG) and forwards touch + keyboard input
// over a WebSocket. Its preview page is same-origin with that WebSocket, so the
// tab embeds the page itself instead of re-implementing the protocol.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { annotateMethods } from "./annotate/contract";
import { registerAnnotate } from "./annotate/server";
import { startProxy, type Proxy } from "./annotate/proxy";

const execFileAsync = promisify(execFile);

const SERVE_SIM_VERSION = "0.1.49";
const DEFAULT_COMMAND = `npx --yes serve-sim@${SERVE_SIM_VERSION}`;
const START_TIMEOUT_MS = 120_000;
const LOG_LINES = 200;

const statusSchema = z.object({
  state: z.enum(["stopped", "starting", "running", "error"]),
  url: z.string().nullable(),
  /** The preview through the plugin's proxy, with the Annotate button in it. */
  proxyUrl: z.string().nullable(),
  device: z.string().nullable(),
  pid: z.number().nullable(),
  startedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type ServeSimStatus = z.infer<typeof statusSchema>;

const deviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  runtime: z.string(),
  state: z.string(),
});
export type SimDevice = z.infer<typeof deviceSchema>;

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusSchema,
  },
  devices: {
    input: z.null(),
    output: z.object({ devices: z.array(deviceSchema), error: z.string().nullable() }),
  },
  start: {
    input: z.object({ device: z.string().trim().max(200).nullable() }),
    output: statusSchema,
  },
  stop: {
    input: z.null(),
    output: statusSchema,
  },
  logs: {
    input: z.null(),
    output: z.object({ lines: z.array(z.string()) }),
  },
  ...annotateMethods,
});

/** Realtime channel the Simulator tab listens on. */
export const STATUS_CHANNEL = "serve-sim-status";

// Strip ANSI colour codes serve-sim prints around its URLs.
const ANSI = /\u001b\[[0-9;]*m/g;
const LOCAL_URL = /Local:\s+(http:\/\/(?:localhost|127\.0\.0\.1):\d+)/;

/** Run a command line through the user's login shell so PATH matches their terminal (nvm, Homebrew, …). */
function loginShell(): string {
  return process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/zsh";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function listDevices(): Promise<{ devices: SimDevice[]; error: string | null }> {
  try {
    const { stdout } = await execFileAsync(
      loginShell(),
      ["-lc", "xcrun simctl list devices available --json"],
      { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
    );
    const parsed = JSON.parse(stdout) as {
      devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>>;
    };
    const devices: SimDevice[] = [];
    for (const [runtimeId, list] of Object.entries(parsed.devices ?? {})) {
      // com.apple.CoreSimulator.SimRuntime.iOS-26-5 → iOS 26.5
      const runtime = runtimeId
        .replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")
        .replace(/-(\d+)-(\d+)$/, " $1.$2")
        .replace(/-(\d+)$/, " $1");
      for (const device of list) {
        if (device.isAvailable === false) continue;
        devices.push({ udid: device.udid, name: device.name, runtime, state: device.state });
      }
    }
    // Booted first, then iPhones, then newest runtime, then name.
    const rank = (d: SimDevice) => (d.state === "Booted" ? 0 : 2) + (d.name.startsWith("iPhone") ? 0 : 1);
    devices.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        b.runtime.localeCompare(a.runtime, undefined, { numeric: true }) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    return { devices, error: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { devices: [], error: `xcrun simctl failed: ${message.split("\n")[0]}` };
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    command: {
      type: "string",
      label: "serve-sim command",
      description:
        "Command line used to start serve-sim, run through your login shell. " +
        "Point it at a local checkout or a global install to skip npx.",
      default: DEFAULT_COMMAND,
    },
    port: {
      type: "number",
      label: "Preview port",
      description:
        "Port for the preview. Leave at 3200 to let serve-sim scan upward when it is busy; any other value is pinned.",
      default: 3200,
    },
    extraArgs: {
      type: "string",
      label: "Extra arguments",
      description: "Appended to the command, e.g. `--codec mjpeg` or `--theme dark`.",
      default: "",
    },
    idbPath: {
      type: "string",
      label: "idb path (Annotate)",
      description:
        "Full path to the idb binary that Annotate uses to read the screen's elements. " +
        "Leave empty to find it in ~/.local/bin, Homebrew, or your login shell's PATH.",
      default: "",
    },
  });

  const annotate = registerAnnotate(bb, (await settings.get()).idbPath ?? "");

  let child: ChildProcess | null = null;
  let status: ServeSimStatus = {
    state: "stopped",
    url: null,
    proxyUrl: null,
    device: null,
    pid: null,
    startedAt: null,
    error: null,
  };
  const logLines: string[] = [];
  let startWaiters: Array<() => void> = [];

  function setStatus(next: Partial<ServeSimStatus>) {
    status = { ...status, ...next };
    bb.realtime.publish(STATUS_CHANNEL, { state: status.state });
    if (status.state !== "starting") {
      const waiters = startWaiters;
      startWaiters = [];
      for (const resolve of waiters) resolve();
    }
    syncProxy();
  }

  // The proxy follows serve-sim: one per running preview URL.
  let proxy: Proxy | null = null;
  let proxyFor: string | null = null;
  let proxyQueue = Promise.resolve();
  let disposed = false;
  function syncProxy() {
    proxyQueue = proxyQueue.then(async () => {
      const want = !disposed && status.state === "running" ? status.url : null;
      if (want === proxyFor) return;
      const old = proxy;
      proxy = null;
      proxyFor = want;
      if (old) await old.close().catch(() => undefined);
      if (want) {
        try {
          proxy = await startProxy(want);
          bb.log.info(`Annotate proxy for ${want} at ${proxy.url}`);
        } catch (cause) {
          bb.log.warn(`Annotate proxy failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      status = { ...status, proxyUrl: proxy?.url ?? null };
      bb.realtime.publish(STATUS_CHANNEL, { state: status.state });
    });
  }

  function pushLog(chunk: string) {
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.replace(ANSI, "").trimEnd();
      if (line === "") continue;
      logLines.push(line);
      if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES);
      const match = LOCAL_URL.exec(line);
      if (match && status.state === "starting") {
        setStatus({ state: "running", url: match[1] ?? null, error: null });
        bb.log.info(`serve-sim ready at ${match[1]}`);
      }
    }
  }

  /** Kill the whole process group: npx → node → helper. */
  function killChild(target: ChildProcess, signal: NodeJS.Signals) {
    if (target.pid === undefined) return;
    try {
      process.kill(-target.pid, signal);
    } catch {
      try {
        target.kill(signal);
      } catch {
        // already gone
      }
    }
  }

  async function stop(): Promise<ServeSimStatus> {
    const target = child;
    child = null;
    if (target && target.exitCode === null && target.signalCode === null) {
      const exited = new Promise<void>((resolve) => target.once("exit", () => resolve()));
      killChild(target, "SIGTERM");
      const timer = setTimeout(() => killChild(target, "SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    }
    setStatus({ state: "stopped", url: null, pid: null, startedAt: null, device: null, error: null });
    return status;
  }

  /** Start serve-sim. `wait` resolves once the preview URL is known (CLI); the tab follows realtime instead. */
  async function start(device: string | null, wait: boolean): Promise<ServeSimStatus> {
    if (child && (status.state === "running" || status.state === "starting")) {
      if (device === null || device === status.device) {
        if (wait && status.state === "starting") await waitForStart();
        return status;
      }
      await stop();
    }
    const { command, port, extraArgs } = await settings.get();
    const parts = [command.trim() || DEFAULT_COMMAND];
    if (device) parts.push(shellQuote(device));
    // serve-sim pins any explicit --port, so pass it only when the user changed it.
    if (Number.isInteger(port) && port > 0 && port < 65536 && port !== 3200) parts.push("--port", String(port));
    if (extraArgs.trim() !== "") parts.push(extraArgs.trim());
    // `exec` replaces the shell so the process group is just serve-sim.
    const line = `exec ${parts.join(" ")}`;

    logLines.length = 0;
    pushLog(`$ ${parts.join(" ")}`);
    bb.log.info(`starting: ${line}`);

    const proc = spawn(loginShell(), ["-lc", line], {
      detached: true, // own process group so stop() reaches the helper too
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    child = proc;
    setStatus({
      state: "starting",
      url: null,
      device,
      pid: proc.pid ?? null,
      startedAt: new Date().toISOString(),
      error: null,
    });

    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", pushLog);
    proc.stderr?.on("data", pushLog);
    proc.on("error", (error) => {
      pushLog(`spawn error: ${error.message}`);
      if (child === proc) {
        child = null;
        setStatus({ state: "error", url: null, pid: null, error: error.message });
      }
    });
    proc.on("exit", (code, signal) => {
      pushLog(`serve-sim exited (${signal ?? `code ${code}`})`);
      if (child !== proc) return;
      child = null;
      const tail = logLines.slice(-3).join(" · ");
      setStatus({
        state: code === 0 || signal === "SIGTERM" ? "stopped" : "error",
        url: null,
        pid: null,
        error: code === 0 || signal === "SIGTERM" ? null : `serve-sim exited (${signal ?? `code ${code}`}): ${tail}`,
      });
    });

    const started = waitForStart();
    if (wait) await started;
    return status;
  }

  function waitForStart(): Promise<void> {
    if (status.state !== "starting") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (status.state === "starting") {
          setStatus({ state: "error", error: "Timed out waiting for serve-sim to print its preview URL." });
        }
        resolve();
      }, START_TIMEOUT_MS);
      startWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // A reload or update unloads this instance: stop what it started, so no
  // preview or proxy outlives it.
  bb.onDispose(async () => {
    disposed = true;
    await stop().catch(() => undefined);
    await proxyQueue;
  });

  bb.rpc.register(rpcContract, {
    status: async () => status,
    devices: async () => listDevices(),
    start: async ({ device }) => start(device, false),
    stop: async () => stop(),
    logs: async () => ({ lines: [...logLines] }),
    ...annotate,
  });

  // ── CLI ─────────────────────────────────────────────────────────────────
  const usage = [
    "Usage:",
    "  bb serve-sim status [--json]          Show whether the simulator preview is running",
    "  bb serve-sim start [device] [--json]  Start serve-sim (device = name or UDID; default: booted)",
    "  bb serve-sim stop [--json]            Stop serve-sim",
    "  bb serve-sim devices [--json]         List available simulators",
    "  bb serve-sim logs                     Print recent serve-sim output",
  ].join("\n");

  function describe(s: ServeSimStatus): string {
    switch (s.state) {
      case "running":
        return `running at ${s.url}${s.device ? ` (${s.device})` : ""} — pid ${s.pid}`;
      case "starting":
        return "starting…";
      case "error":
        return `error: ${s.error ?? "unknown"}`;
      default:
        return "stopped";
    }
  }

  bb.cli.register({
    name: "serve-sim",
    summary: "Stream the iOS Simulator into BB's side panel with serve-sim",
    commands: [
      { name: "status", summary: "Show preview status", usage: "bb serve-sim status [--json]" },
      { name: "start", summary: "Start serve-sim", usage: "bb serve-sim start [device] [--json]" },
      { name: "stop", summary: "Stop serve-sim", usage: "bb serve-sim stop [--json]" },
      { name: "devices", summary: "List available simulators", usage: "bb serve-sim devices [--json]" },
      { name: "logs", summary: "Print recent serve-sim output", usage: "bb serve-sim logs" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown, text: string, exitCode = 0) => ({
        exitCode,
        stdout: json ? JSON.stringify(value) : text,
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status":
          return reply(status, describe(status));
        case "start": {
          const device = args.join(" ").trim() || null;
          const result = await start(device, true);
          return reply(result, describe(result), result.state === "running" ? 0 : 1);
        }
        case "stop": {
          const result = await stop();
          return reply(result, describe(result));
        }
        case "devices": {
          const result = await listDevices();
          if (result.error) return { exitCode: 1, stderr: result.error };
          const text =
            result.devices.length === 0
              ? "No simulators found."
              : result.devices
                  .slice(0, 60)
                  .map((d) => `${d.state === "Booted" ? "●" : " "} ${d.name} — ${d.runtime}  ${d.udid}`)
                  .join("\n");
          return reply(result.devices, text);
        }
        case "logs":
          return { exitCode: 0, stdout: logLines.slice(-80).join("\n") || "(no output yet)" };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(async () => {
    await stop();
  });
}
