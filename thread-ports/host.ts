// Full-trust host entry: the only place that runs lsof/ps and signals
// processes. One worker per enrolled machine, so a thread's servers are found
// on the machine where they actually run.
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { networkInterfaces, platform } from "node:os";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type ScanRoot, type ScannedPort } from "./src/contract.js";
import {
  attribute,
  classify,
  foldListeners,
  isLoopback,
  parseBbIds,
  parseCwds,
  parseEnvironmentRows,
  parseListeners,
  parseProcessRows,
  friendlyName,
  type Listener,
} from "./src/parse.js";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const STOP_WAIT_MS = 2_500;

/** lsof exits non-zero when any file is inaccessible; partial stdout is still the answer. */
async function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      ...(signal ? { signal } : {}),
    });
    return stdout;
  } catch (cause) {
    const stdout = (cause as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && stdout.trim() !== "") return stdout;
    if ((cause as { code?: unknown }).code === 1) return "";
    throw cause;
  }
}

interface ProcessFacts {
  startedAt: number | null;
  command: string;
  cwd: string | null;
  threadId: string | null;
  environmentId: string | null;
}

/**
 * Facts never change for a live process, so each pid is read once. The start
 * time is re-read cheaply on every pass and a mismatch drops the entry, which
 * keeps a reused pid from inheriting another process's thread.
 */
const factsCache = new Map<number, ProcessFacts>();

async function readFactsDarwin(pids: number[], signal: AbortSignal): Promise<Map<number, ProcessFacts>> {
  const list = pids.join(",");
  const [rowsOut, envOut, cwdOut] = await Promise.all([
    run("ps", ["-ww", "-o", "pid=,lstart=,command=", "-p", list], signal),
    run("ps", ["-wwwE", "-o", "pid=,command=", "-p", list], signal),
    run("lsof", ["-a", "-p", list, "-d", "cwd", "-Fn"], signal),
  ]);
  const rows = parseProcessRows(rowsOut);
  const ids = parseEnvironmentRows(envOut);
  const cwds = parseCwds(cwdOut);
  const facts = new Map<number, ProcessFacts>();
  for (const pid of pids) {
    const row = rows.get(pid);
    if (row === undefined) continue;
    const bbIds = ids.get(pid) ?? { threadId: null, environmentId: null };
    facts.set(pid, { startedAt: row.startedAt, command: row.command, cwd: cwds.get(pid) ?? null, ...bbIds });
  }
  return facts;
}

async function readFactsLinux(pids: number[], signal: AbortSignal): Promise<Map<number, ProcessFacts>> {
  const rows = parseProcessRows(await run("ps", ["-ww", "-o", "pid=,lstart=,command=", "-p", pids.join(",")], signal));
  const facts = new Map<number, ProcessFacts>();
  await Promise.all(
    pids.map(async (pid) => {
      const row = rows.get(pid);
      if (row === undefined) return;
      let environ = "";
      let cwd: string | null = null;
      try {
        environ = await readFile(`/proc/${pid}/environ`, "utf8");
      } catch {
        // Another user's process: no thread attribution, cwd may still work.
      }
      try {
        cwd = await readlink(`/proc/${pid}/cwd`);
      } catch {
        // Exited between passes.
      }
      facts.set(pid, { startedAt: row.startedAt, command: row.command, cwd, ...parseBbIds(environ) });
    }),
  );
  return facts;
}

async function processFacts(pids: number[], signal: AbortSignal): Promise<Map<number, ProcessFacts>> {
  if (pids.length === 0) return new Map();
  // Cheap start-time check for cached pids; anything new or changed is re-read.
  const starts = parseProcessRows(await run("ps", ["-ww", "-o", "pid=,lstart=,command=", "-p", pids.join(",")], signal));
  const stale = pids.filter((pid) => {
    const cached = factsCache.get(pid);
    return cached === undefined || cached.startedAt !== (starts.get(pid)?.startedAt ?? null);
  });
  if (stale.length > 0) {
    const fresh = platform() === "linux" ? await readFactsLinux(stale, signal) : await readFactsDarwin(stale, signal);
    for (const pid of stale) {
      const value = fresh.get(pid);
      if (value === undefined) factsCache.delete(pid);
      else factsCache.set(pid, value);
    }
  }
  // Forget processes that stopped listening.
  const live = new Set(pids);
  for (const pid of factsCache.keys()) if (!live.has(pid)) factsCache.delete(pid);
  const result = new Map<number, ProcessFacts>();
  for (const pid of pids) {
    const value = factsCache.get(pid);
    if (value !== undefined) result.set(pid, value);
  }
  return result;
}

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

async function listeners(signal?: AbortSignal): Promise<Listener[]> {
  return foldListeners(parseListeners(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], signal)));
}

async function scan(roots: ScanRoot[], signal: AbortSignal): Promise<ScannedPort[]> {
  const found = await listeners(signal);
  const facts = await processFacts([...new Set(found.map((row) => row.pid))], signal);
  const ports: ScannedPort[] = [];
  for (const listener of found) {
    const fact = facts.get(listener.pid);
    if (fact === undefined) continue;
    const environmentId = fact.environmentId ?? (fact.cwd === null ? null : attribute(fact.cwd, roots));
    // Only what a BB thread started or what runs inside a BB workspace: the
    // machine's own services (AirPlay, bb itself, editors) stay out.
    if (fact.threadId === null && environmentId === null) continue;
    ports.push({
      port: listener.port,
      address: listener.address,
      exposed: !isLoopback(listener.address),
      pid: listener.pid,
      processName: listener.processName,
      name: friendlyName(fact.command, listener.processName),
      command: fact.command,
      cwd: fact.cwd,
      startedAt: fact.startedAt,
      threadId: fact.threadId,
      environmentId,
      kind: classify(fact.command, listener.address, listener.port),
    });
  }
  return ports.sort((left, right) => left.port - right.port);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stillListening(pid: number, port: number): Promise<boolean> {
  return (await listeners()).some((row) => row.pid === pid && row.port === port);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async scan({ roots }, context) {
      if (platform() !== "darwin" && platform() !== "linux") {
        return { ports: [], lanAddresses: [], scannedAt: Date.now() };
      }
      return { ports: await scan(roots, context.signal), lanAddresses: lanAddresses(), scannedAt: Date.now() };
    },

    // The target is re-checked here rather than trusted from the caller: the
    // pid must still hold the port and still be the process that started at
    // `startedAt`, so a recycled pid is never signalled.
    async stop({ pid, port, startedAt, force }) {
      if (!(await stillListening(pid, port))) {
        return { stopped: true, detail: `nothing listens on :${port} any more` };
      }
      const current = parseProcessRows(await run("ps", ["-ww", "-o", "pid=,lstart=,command=", "-p", String(pid)])).get(pid);
      if (current === undefined) return { stopped: true, detail: `process ${pid} already exited` };
      if (startedAt !== null && current.startedAt !== startedAt) {
        return { stopped: false, detail: `pid ${pid} now belongs to another process; refresh and try again` };
      }
      const signal = force ? "SIGKILL" : "SIGTERM";
      try {
        process.kill(pid, signal);
      } catch (cause) {
        return { stopped: false, detail: `could not signal ${pid}: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      const deadline = Date.now() + STOP_WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (!alive(pid) || !(await stillListening(pid, port))) {
          return { stopped: true, detail: `stopped :${port} (${signal} to ${pid})` };
        }
      }
      return { stopped: false, detail: `:${port} still listening after ${signal}; force it to kill` };
    },
  },
});
