// bb-plugin-thread-ports — backend entry.
//
// Each machine's host worker (host.ts) lists listening TCP ports with the
// `BB_THREAD_ID` its process inherited from the agent that started it. This
// backend names them — thread title, project, branch — groups them by thread
// and serves the result to the sidebar panel, the context row above each
// composer, thread-row markers, `bb thread-ports` and agents.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, portKindSchema, type ScanRoot, type ScannedPort } from "./src/contract";

const SNAPSHOT_TTL_MS = 1_500;
const FACTS_TTL_MS = 30_000;
const THREAD_LIMIT = 500;

const portSchema = z.object({
  hostId: z.string(),
  port: z.number().int(),
  address: z.string(),
  exposed: z.boolean(),
  pid: z.number().int(),
  processName: z.string(),
  name: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  startedAt: z.number().nullable(),
  kind: portKindSchema,
  url: z.string(),
  /** `http://<lan-ip>:<port>` when the port is reachable from the network. */
  lanUrl: z.string().nullable(),
});
export type PortRow = z.infer<typeof portSchema>;

const groupSchema = z.object({
  /** `thread:<id>` or `environment:<id>`. */
  key: z.string(),
  /** The thread that started these servers; null when no agent did. */
  threadId: z.string().nullable(),
  title: z.string(),
  /** `GTGS · godot-port`, `Personal workspace`. */
  subtitle: z.string(),
  environmentId: z.string().nullable(),
  archived: z.boolean(),
  /** False when the thread was deleted: its servers outlived it. */
  threadExists: z.boolean(),
  ports: z.array(portSchema),
});
export type PortGroup = z.infer<typeof groupSchema>;

const snapshotSchema = z.object({
  groups: z.array(groupSchema),
  scannedAt: z.number(),
  errors: z.array(z.string()),
});
export type PortSnapshot = z.infer<typeof snapshotSchema>;

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  stop: {
    input: z.object({
      hostId: z.string().min(1).max(200),
      pid: z.number().int().min(2),
      port: z.number().int().min(1).max(65535),
      startedAt: z.number().nullable(),
      force: z.boolean().default(false),
    }),
    output: z.object({ stopped: z.boolean(), detail: z.string() }),
  },
});

interface ThreadFacts {
  title: string;
  projectId: string;
  environmentId: string | null;
  archived: boolean;
}

interface EnvironmentFacts {
  hostId: string;
  path: string | null;
  branchName: string | null;
  name: string | null;
  projectId: string;
}

function cached<T>(ttl: number) {
  const store = new Map<string, { at: number; value: T }>();
  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      return entry && Date.now() - entry.at < ttl ? entry.value : undefined;
    },
    set(key: string, value: T): void {
      store.set(key, { at: Date.now(), value });
    },
  };
}

const KIND_ORDER = { web: 0, tool: 1, internal: 2 } as const;

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const threadCache = cached<ThreadFacts | null>(FACTS_TTL_MS);
  const environmentCache = cached<EnvironmentFacts | null>(FACTS_TTL_MS);
  const projectNames = cached<Map<string, string>>(FACTS_TTL_MS);
  let current: { at: number; value: Promise<PortSnapshot> } | null = null;

  async function listThreads(): Promise<Map<string, ThreadFacts>> {
    const rows = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: THREAD_LIMIT });
    const threads = new Map<string, ThreadFacts>();
    for (const row of rows) {
      const facts = {
        title: row.title ?? row.titleFallback ?? "Untitled thread",
        projectId: row.projectId,
        environmentId: row.environmentId ?? null,
        archived: false,
      };
      threads.set(row.id, facts);
      threadCache.set(row.id, facts);
    }
    return threads;
  }

  /** A thread outside the live list (archived, or past the limit). */
  async function threadFacts(threadId: string, live: Map<string, ThreadFacts>): Promise<ThreadFacts | null> {
    const known = live.get(threadId) ?? threadCache.get(threadId);
    if (known !== undefined) return known;
    let facts: ThreadFacts | null = null;
    try {
      const { thread } = (await bb.sdk.threads.get({ threadId })) as unknown as {
        thread: { title: string | null; titleFallback: string | null; projectId: string; environmentId: string | null; archivedAt?: string | null };
      };
      facts = {
        title: thread.title ?? thread.titleFallback ?? "Untitled thread",
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        archived: Boolean(thread.archivedAt),
      };
    } catch {
      // Deleted thread: the port still shows, under its raw id.
    }
    threadCache.set(threadId, facts);
    return facts;
  }

  async function environmentFacts(environmentId: string): Promise<EnvironmentFacts | null> {
    const known = environmentCache.get(environmentId);
    if (known !== undefined) return known;
    let facts: EnvironmentFacts | null = null;
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      facts = {
        hostId: environment.hostId,
        path: environment.status === "ready" ? environment.path : null,
        branchName: environment.branchName,
        name: environment.name,
        projectId: environment.projectId,
      };
    } catch {
      // Destroyed environment.
    }
    environmentCache.set(environmentId, facts);
    return facts;
  }

  async function projectName(projectId: string): Promise<string | null> {
    let names = projectNames.get("all");
    if (names === undefined) {
      names = new Map();
      try {
        for (const project of (await bb.sdk.projects.list()) as { id: string; name: string }[]) {
          names.set(project.id, project.name);
        }
      } catch {
        // Names are decoration; ids still group correctly.
      }
      projectNames.set("all", names);
    }
    return names.get(projectId) ?? null;
  }

  async function subtitleFor(projectId: string | null, environmentId: string | null): Promise<string> {
    const environment = environmentId === null ? null : await environmentFacts(environmentId);
    const project = projectId ?? environment?.projectId ?? null;
    const projectLabel = project === null || project === "proj_personal" ? null : await projectName(project);
    const place = environment?.branchName ?? environment?.name ?? null;
    if (projectLabel === null) return place === null ? "Personal workspace" : `Personal · ${place}`;
    return place === null ? projectLabel : `${projectLabel} · ${place}`;
  }

  async function build(): Promise<PortSnapshot> {
    const threads = await listThreads();
    // Roots let a server someone started by hand inside a workspace show too.
    const rootsByHost = new Map<string, ScanRoot[]>();
    const environmentIds = new Set<string>();
    for (const facts of threads.values()) if (facts.environmentId) environmentIds.add(facts.environmentId);
    await Promise.all(
      [...environmentIds].map(async (environmentId) => {
        const facts = await environmentFacts(environmentId);
        if (facts?.path == null) return;
        const roots = rootsByHost.get(facts.hostId) ?? [];
        roots.push({ environmentId, path: facts.path });
        rootsByHost.set(facts.hostId, roots);
      }),
    );
    const hostIds = new Set(rootsByHost.keys());
    try {
      for (const entry of await bb.sdk.hosts.list()) hostIds.add(entry.id);
    } catch {
      // Fall back to the hosts that own a workspace.
    }

    const errors: string[] = [];
    const ports: (ScannedPort & { hostId: string; lan: string[] })[] = [];
    await Promise.all(
      [...hostIds].map(async (hostId) => {
        try {
          const result = await host.call("scan", { roots: rootsByHost.get(hostId) ?? [] }, { hostId });
          for (const port of result.ports) ports.push({ ...port, hostId, lan: result.lanAddresses });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          // An offline machine is routine; only report real scan failures.
          if (!/offline|not connected|unavailable|no worker/i.test(message)) errors.push(`${hostId}: ${message}`);
        }
      }),
    );

    const groups = new Map<string, PortGroup>();
    for (const port of ports) {
      const thread = port.threadId === null ? null : await threadFacts(port.threadId, threads);
      const key = port.threadId !== null ? `thread:${port.threadId}` : `environment:${port.environmentId}`;
      let group = groups.get(key);
      if (group === undefined) {
        const environmentId = thread?.environmentId ?? port.environmentId;
        group = {
          key,
          threadId: port.threadId,
          title: thread?.title ?? (port.threadId === null ? "Started outside an agent" : "Deleted thread"),
          subtitle: await subtitleFor(thread?.projectId ?? null, environmentId),
          environmentId,
          archived: thread?.archived ?? false,
          threadExists: thread !== null,
          ports: [],
        };
        groups.set(key, group);
      }
      const lanHost = port.exposed ? port.lan[0] : undefined;
      group.ports.push({
        hostId: port.hostId,
        port: port.port,
        address: port.address,
        exposed: port.exposed,
        pid: port.pid,
        processName: port.processName,
        name: port.name,
        command: port.command,
        cwd: port.cwd,
        startedAt: port.startedAt,
        kind: port.kind,
        url: `http://localhost:${port.port}`,
        lanUrl: lanHost === undefined ? null : `http://${lanHost}:${port.port}`,
      });
    }
    const list = [...groups.values()];
    for (const group of list) group.ports.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.port - b.port);
    // Threads with something to open first, then by their first port.
    const score = (group: PortGroup) => (group.ports.some((port) => port.kind === "web") ? 0 : 1);
    list.sort((a, b) => score(a) - score(b) || (a.ports[0]?.port ?? 0) - (b.ports[0]?.port ?? 0));
    return { groups: list, scannedAt: Date.now(), errors };
  }

  function snapshot(): Promise<PortSnapshot> {
    if (current && Date.now() - current.at < SNAPSHOT_TTL_MS) return current.value;
    const value = build();
    current = { at: Date.now(), value };
    value.catch(() => {
      if (current?.value === value) current = null;
    });
    return value;
  }

  async function stop(input: { hostId: string; pid: number; port: number; startedAt: number | null; force: boolean }) {
    // Only a port this plugin currently lists can be stopped from here.
    const listed = (await snapshot()).groups.some((group) =>
      group.ports.some((port) => port.hostId === input.hostId && port.pid === input.pid && port.port === input.port),
    );
    if (!listed) return { stopped: false, detail: `:${input.port} is not a port Thread Ports lists` };
    const result = await host.call(
      "stop",
      { pid: input.pid, port: input.port, startedAt: input.startedAt, force: input.force },
      { hostId: input.hostId },
    );
    current = null;
    return result;
  }

  // Content scripts have no hooks or RPC client; the row markers read this.
  bb.http.route("GET", "/snapshot", async () => Response.json(await snapshot()));

  bb.rpc.register(rpcContract, {
    snapshot: () => snapshot(),
    stop: (input) => stop(input),
  });

  function format(value: PortSnapshot): string {
    if (value.groups.length === 0) return "No BB thread is serving a port.";
    const lines: string[] = [];
    for (const group of value.groups) {
      lines.push(`${group.title}  (${group.subtitle}${group.threadId ? `, ${group.threadId}` : ""})`);
      for (const port of group.ports) {
        const where = port.lanUrl ? `${port.url}  ${port.lanUrl}` : port.url;
        lines.push(`  ${String(port.port).padEnd(6)} ${port.name.padEnd(20)} ${where}  pid ${port.pid}${port.kind === "web" ? "" : `  [${port.kind}]`}`);
      }
    }
    return lines.join("\n");
  }

  const usage = "Usage: bb thread-ports [list] [--json] | bb thread-ports stop <port> [--force]";
  bb.cli.register({
    name: "thread-ports",
    summary: "Show the ports BB threads are serving, and stop one",
    commands: [
      { name: "list", summary: "List listening ports per thread", usage: "bb thread-ports list [--json]" },
      { name: "stop", summary: "Stop the server on a listed port", usage: "bb thread-ports stop <port> [--force]" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const force = argv.includes("--force");
      const [command, ...args] = argv.filter((arg) => arg !== "--json" && arg !== "--force");
      if (command === undefined || command === "list") {
        const value = await snapshot();
        return { exitCode: 0, stdout: json ? JSON.stringify(value) : format(value) };
      }
      if (command === "stop") {
        const port = Number.parseInt(args[0] ?? "", 10);
        const matches = (await snapshot()).groups.flatMap((group) => group.ports).filter((row) => row.port === port);
        if (matches.length !== 1) {
          return { exitCode: 1, stderr: matches.length === 0 ? `:${args[0] ?? "?"} is not listed` : `:${port} is listed on several machines` };
        }
        const target = matches[0] as PortRow;
        const result = await stop({ hostId: target.hostId, pid: target.pid, port, startedAt: target.startedAt, force });
        return { exitCode: result.stopped ? 0 : 1, ...(result.stopped ? { stdout: result.detail } : { stderr: result.detail }) };
      }
      return { exitCode: command === "help" || command === "--help" ? 0 : 1, stdout: usage };
    },
  });
}
