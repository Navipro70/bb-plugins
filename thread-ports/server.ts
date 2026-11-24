// bb-plugin-thread-ports — backend entry.
//
// Thread Ports does no scanning of its own. The Worktree Ports plugin already
// attributes every listening TCP port to the BB environment whose worktree
// holds the process; this backend asks it for that snapshot through
// `bb.sdk.plugins.callRpc`, keeps the one environment a thread asks about, and
// forwards "stop" requests back to it. app.tsx renders the result in the
// context row above the thread's composer.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SOURCE_PLUGIN_ID = "worktree-ports";
/** Several panes and segments ask at once; one upstream call serves them all. */
const SNAPSHOT_TTL_MS = 1_500;

const portSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int(),
  processName: z.string(),
  source: z.enum(["process", "docker"]),
  container: z.string().nullable(),
  service: z.string().nullable(),
  role: z.enum(["app", "service", "internal"]),
  label: z.string().nullable(),
  url: z.string(),
});
export type ThreadPort = z.infer<typeof portSchema>;

// Only the fields this plugin reads; zod drops the rest, so a newer Worktree
// Ports that adds fields keeps working.
const upstreamSnapshotSchema = z.object({
  groups: z.array(
    z.object({
      environmentId: z.string(),
      threads: z.array(z.object({ id: z.string(), title: z.string() })),
      ports: z.array(portSchema),
    }),
  ),
  scannedAt: z.number(),
});
type UpstreamSnapshot = z.infer<typeof upstreamSnapshotSchema>;

const releaseResultSchema = z.object({ released: z.boolean(), detail: z.string() });

const environmentPortsSchema = z.object({
  /** False when Worktree Ports is missing, disabled, or failed to answer. */
  available: z.boolean(),
  /** Why `available` is false; null otherwise. */
  reason: z.string().nullable(),
  ports: z.array(portSchema),
  /** Every BB thread working in this environment, this one included. */
  threads: z.array(z.object({ id: z.string(), title: z.string() })),
  scannedAt: z.number().nullable(),
});
export type EnvironmentPorts = z.infer<typeof environmentPortsSchema>;

const environmentInputSchema = z.object({ environmentId: z.string().min(1).max(200) });

export const rpcContract = defineRpcContract({
  environment_ports: {
    input: environmentInputSchema,
    output: environmentPortsSchema,
  },
  release_port: {
    input: environmentInputSchema.extend({ port: z.number().int().min(1).max(65535) }),
    output: releaseResultSchema,
  },
});

const ROLE_ORDER = { app: 0, service: 1, internal: 2 } as const;

export default function plugin(bb: BbPluginApi) {
  let cached: { at: number; value: Promise<UpstreamSnapshot> } | null = null;

  function snapshot(): Promise<UpstreamSnapshot> {
    const now = Date.now();
    if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.value;
    const value = bb.sdk.plugins.callRpc({
      pluginId: SOURCE_PLUGIN_ID,
      method: "ports_snapshot",
      input: null,
      outputSchema: upstreamSnapshotSchema,
    });
    cached = { at: now, value };
    // A failed call must not be served from the cache to the next caller.
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
    return value;
  }

  bb.rpc.register(rpcContract, {
    async environment_ports({ environmentId }) {
      let upstream: UpstreamSnapshot;
      try {
        upstream = await snapshot();
      } catch (error) {
        return {
          available: false,
          reason: `Worktree Ports did not answer: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ports: [],
          threads: [],
          scannedAt: null,
        };
      }
      const group = upstream.groups.find((entry) => entry.environmentId === environmentId);
      const ports = [...(group?.ports ?? [])].sort(
        (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.port - b.port,
      );
      return {
        available: true,
        reason: null,
        ports,
        threads: group?.threads ?? [],
        scannedAt: upstream.scannedAt,
      };
    },

    async release_port({ environmentId, port }) {
      // Worktree Ports re-scans before it stops anything and refuses a port
      // that is not listening in this environment's worktree.
      const result = await bb.sdk.plugins.callRpc({
        pluginId: SOURCE_PLUGIN_ID,
        method: "ports_release",
        input: { environmentId, port },
        outputSchema: releaseResultSchema,
      });
      cached = null;
      return result;
    },
  });
}
