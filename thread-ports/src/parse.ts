// Pure parsing, naming and attribution. host.ts runs the commands; this half
// stays unit-testable without spawning anything.
import { sep } from "node:path";
import type { PortKind, ScanRoot } from "./contract";

export interface Listener {
  pid: number;
  processName: string;
  address: string;
  port: number;
}

/** `*:3000`, `127.0.0.1:3000`, `[::1]:3000`, `[::]:3000`. */
export function parseAddressPort(value: string): { address: string; port: number } | null {
  const match = value.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  if (match === null) return null;
  const port = Number.parseInt(match[3] as string, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = match[1] ?? match[2] ?? "*";
  return { address: host === "*" ? "0.0.0.0" : host, port };
}

/**
 * Columnar `lsof -nP -iTCP -sTCP:LISTEN` output. lsof escapes spaces in the
 * COMMAND column as `\x20`, so splitting on whitespace is safe.
 */
export function parseListeners(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split("\n").slice(1)) {
    if (line.trim() === "") continue;
    const columns = line.split(/\s+/);
    if (columns.length < 9) continue;
    const pid = Number.parseInt(columns[1] as string, 10);
    // NAME sits before the trailing "(LISTEN)" state.
    const parsed = parseAddressPort(columns[columns.length - 2] as string);
    if (!Number.isInteger(pid) || parsed === null) continue;
    listeners.push({ pid, processName: (columns[0] as string).replace(/\\x20/g, " "), ...parsed });
  }
  return listeners;
}

export function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address === "localhost";
}

/** One row per pid and port: IPv4 and IPv6 sockets fold, the widest bind wins. */
export function foldListeners(listeners: Listener[]): Listener[] {
  const byKey = new Map<string, Listener>();
  for (const listener of listeners) {
    const key = `${listener.pid}:${listener.port}`;
    const existing = byKey.get(key);
    if (existing === undefined || (isLoopback(existing.address) && !isLoopback(listener.address))) {
      byKey.set(key, listener);
    }
  }
  return [...byKey.values()];
}

/** Field-mode `lsof -a -p <pids> -d cwd -Fn` output: `p<pid>`, `fcwd`, `n<path>`. */
export function parseCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) ? parsed : null;
    } else if (line.startsWith("n") && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

export interface ProcessRow {
  pid: number;
  startedAt: number | null;
  command: string;
}

/** `ps -ww -o pid=,lstart=,command= -p …`: lstart is always five tokens. */
export function parseProcessRows(output: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    if (match === null) continue;
    const pid = Number.parseInt(match[1] as string, 10);
    const started = Date.parse(match[2] as string);
    rows.set(pid, {
      pid,
      startedAt: Number.isNaN(started) ? null : started,
      command: (match[3] as string).slice(0, 300),
    });
  }
  return rows;
}

const THREAD_ID = /(?:^|\s|\0)BB_THREAD_ID=(thr_[A-Za-z0-9_-]{1,64})/g;
const ENVIRONMENT_ID = /(?:^|\s|\0)BB_ENVIRONMENT_ID=(env_[A-Za-z0-9_-]{1,64})/g;

function lastMatch(pattern: RegExp, text: string): string | null {
  let value: string | null = null;
  for (const match of text.matchAll(pattern)) value = match[1] ?? value;
  return value;
}

/**
 * BB ids from a process environment: `ps -wwwE` on macOS appends it after the
 * command, `/proc/<pid>/environ` on Linux separates entries with NUL. The last
 * occurrence wins, since the environment comes after any argument that merely
 * mentions the variable.
 */
export function parseBbIds(text: string): { threadId: string | null; environmentId: string | null } {
  return { threadId: lastMatch(THREAD_ID, text), environmentId: lastMatch(ENVIRONMENT_ID, text) };
}

/** `ps -wwwE -o pid=,command= -p …`, one process per line. */
export function parseEnvironmentRows(output: string): Map<number, ReturnType<typeof parseBbIds>> {
  const rows = new Map<number, ReturnType<typeof parseBbIds>>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match === null) continue;
    rows.set(Number.parseInt(match[1] as string, 10), parseBbIds(match[2] as string));
  }
  return rows;
}

/** The workspace owning a path; the longest root wins for nested worktrees. */
export function attribute(path: string, roots: readonly ScanRoot[]): string | null {
  let best: ScanRoot | null = null;
  for (const root of roots) {
    const base = root.path.replace(/\/+$/, "");
    if (path !== base && !path.startsWith(base + sep)) continue;
    if (best === null || root.path.length > best.path.length) best = root;
  }
  return best === null ? null : best.environmentId;
}

function basename(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? value;
}

/** A short name for a listener from its command line. */
export function friendlyName(command: string, processName: string): string {
  const lower = command.toLowerCase();
  // A null name uses the matched word itself.
  const known: [RegExp, string | null][] = [
    [/\bvite\b/, "vite"],
    [/\bnext(\s+dev|-server|\/dist)/, "next"],
    [/\bnuxt\b/, "nuxt"],
    [/\bastro\b/, "astro"],
    [/\bwebpack\b/, "webpack"],
    [/\b(expo|metro)\b/, "metro"],
    [/\bstorybook\b/, "storybook"],
    [/serve-sim/, "serve-sim"],
    [/-m\s+http\.server/, "python http.server"],
    [/\b(uvicorn|gunicorn|flask|django)\b/, null],
    [/maestro.*\bmcp\b/, "maestro mcp"],
    [/\badb\b.*\bfork-server\b/, "adb server"],
    [/\bpostgres\b/, "postgres"],
    [/\bredis-server\b/, "redis"],
  ];
  for (const [pattern, name] of known) {
    const match = lower.match(pattern);
    if (match) return name ?? match[0];
  }
  // node/bun/deno/python running a script: name the script.
  const script = command.match(/^\S*\/?(?:node|bun|deno|python3?|ruby)\S*\s+(?:-\S+\s+)*([^\s-][^\s]*\.(?:m?js|cjs|ts|py|rb))/);
  if (script) return basename(script[1] as string);
  return processName.toLowerCase();
}

/** What a listener is for, so the panel can lead with what to open. */
export function classify(command: string, address: string, port: number): PortKind {
  if (/\bmcp\b|--stdio\b|language[-_ ]?server|\blsp\b|\badb\b.*\bfork-server\b/i.test(command)) return "tool";
  if (isLoopback(address) && port >= 49152) return "internal";
  return "web";
}
