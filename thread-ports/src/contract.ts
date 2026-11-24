// Shared between server.ts (which groups and names) and host.ts (which scans).
// Every field crossing the host RPC boundary is validated by these schemas.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** A workspace directory the scanner attributes listeners to by cwd. */
export const scanRootSchema = z.object({
  environmentId: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
});
export type ScanRoot = z.infer<typeof scanRootSchema>;

export const portKindSchema = z.enum(["web", "tool", "internal"]);
export type PortKind = z.infer<typeof portKindSchema>;

export const scannedPortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  /** The widest address the port is bound on: `0.0.0.0` beats `127.0.0.1`. */
  address: z.string(),
  /** Reachable from other machines on the network, not only this one. */
  exposed: z.boolean(),
  pid: z.number().int(),
  processName: z.string(),
  /** Short human name: `vite`, `python http.server`, `server.mjs`. */
  name: z.string(),
  /** Command line, capped at 300 characters. */
  command: z.string(),
  cwd: z.string().nullable(),
  /** Milliseconds since epoch; also guards Stop against a reused pid. */
  startedAt: z.number().nullable(),
  /** `BB_THREAD_ID` from the process environment: the thread that started it. */
  threadId: z.string().nullable(),
  /** `BB_ENVIRONMENT_ID`, or the root its cwd sits in. */
  environmentId: z.string().nullable(),
  /** web: something to open; tool: an agent's MCP or language server; internal: an ephemeral loopback port. */
  kind: portKindSchema,
});
export type ScannedPort = z.infer<typeof scannedPortSchema>;

export const hostContract = defineRpcContract({
  scan: {
    input: z.object({ roots: z.array(scanRootSchema).max(500) }),
    output: z.object({
      ports: z.array(scannedPortSchema),
      /** This machine's non-internal IPv4 addresses, for LAN URLs. */
      lanAddresses: z.array(z.string()),
      scannedAt: z.number(),
    }),
  },
  stop: {
    input: z.object({
      pid: z.number().int().min(2),
      port: z.number().int().min(1).max(65535),
      startedAt: z.number().nullable(),
      force: z.boolean(),
    }),
    output: z.object({ stopped: z.boolean(), detail: z.string() }),
  },
});
