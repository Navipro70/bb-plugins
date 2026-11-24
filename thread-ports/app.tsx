// bb-plugin-thread-ports — frontend entry.
//
// Adds a "Ports" segment to the context row above a thread's composer (beside
// bb's pull request and changed-files segments). The summary names the
// servers listening in the thread's worktree; expanding it lists every port
// with Open (in the browser BB prefers) and Stop. The data comes from the
// Worktree Ports plugin through server.ts.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
  type PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type { EnvironmentPorts, ThreadPort, rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Rpc = PluginRpcClient<typeof rpcContract>;

const POLL_MS = 4_000;
/** A Stop click arms the button; a second click within this window stops. */
const CONFIRM_MS = 3_000;
/** App ports named in the summary before the rest fold into "+N". */
const SUMMARY_PORTS = 2;

// ---------------------------------------------------------------- shared store
//
// The summary, the details and `useVisible` of every open pane read the same
// environment, so one poller per environment serves them all while at least
// one of them is mounted.

interface Entry {
  value: EnvironmentPorts | null;
  listeners: Set<() => void>;
  timer: number | null;
  inFlight: boolean;
}

const entries = new Map<string, Entry>();
let rpcClient: Rpc | null = null;

function entryFor(environmentId: string): Entry {
  let entry = entries.get(environmentId);
  if (!entry) {
    entry = { value: null, listeners: new Set(), timer: null, inFlight: false };
    entries.set(environmentId, entry);
  }
  return entry;
}

async function refresh(environmentId: string): Promise<void> {
  const entry = entryFor(environmentId);
  if (rpcClient === null || entry.inFlight) return;
  entry.inFlight = true;
  try {
    entry.value = await rpcClient.call("environment_ports", { environmentId });
  } catch (error) {
    entry.value = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      ports: [],
      threads: [],
      scannedAt: null,
    };
  } finally {
    entry.inFlight = false;
  }
  for (const listener of entry.listeners) listener();
}

function schedule(environmentId: string): void {
  const entry = entryFor(environmentId);
  if (entry.listeners.size === 0) return;
  entry.timer = window.setTimeout(async () => {
    entry.timer = null;
    await refresh(environmentId);
    schedule(environmentId);
  }, POLL_MS);
}

function subscribe(environmentId: string, listener: () => void): () => void {
  const entry = entryFor(environmentId);
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) {
    void refresh(environmentId);
    schedule(environmentId);
  }
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.timer !== null) {
      window.clearTimeout(entry.timer);
      entry.timer = null;
    }
  };
}

const NO_ENVIRONMENT = "";
const noop = () => () => {};

/** Ports of an environment, kept current while any caller is mounted. */
function useEnvironmentPorts(environmentId: string | null): EnvironmentPorts | null {
  const rpc = useRpc<typeof rpcContract>();
  rpcClient ??= rpc;
  const id = environmentId ?? NO_ENVIRONMENT;
  const subscribeTo = useCallback(
    (listener: () => void) => (id === NO_ENVIRONMENT ? noop() : subscribe(id, listener)),
    [id],
  );
  const read = useCallback(() => (id === NO_ENVIRONMENT ? null : entryFor(id).value), [id]);
  return useSyncExternalStore(subscribeTo, read, read);
}

// ---------------------------------------------------------------- formatting

function portName(port: ThreadPort): string {
  return port.label ?? port.service ?? port.container ?? port.processName.toLowerCase();
}

function summaryText(ports: readonly ThreadPort[]): string {
  const apps = ports.filter((port) => port.role === "app");
  const lead = (apps.length > 0 ? apps : ports).slice(0, SUMMARY_PORTS);
  const rest = ports.length - lead.length;
  const parts = lead.map((port) => `${portName(port)} :${port.port}`);
  if (rest > 0) parts.push(`+${rest}`);
  return parts.join(" · ");
}

const ROLE_DOT: Record<ThreadPort["role"], string> = {
  app: "bg-emerald-500",
  service: "bg-sky-500",
  internal: "bg-muted-foreground/50",
};

// ---------------------------------------------------------------- components

function useVisible({ environment }: ExperimentalThreadContextSegmentInput): boolean {
  const value = useEnvironmentPorts(environment?.id ?? null);
  return value !== null && value.available && value.ports.length > 0;
}

function PortsSummary({ environment, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const value = useEnvironmentPorts(environment?.id ?? null);
  if (value === null || value.ports.length === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      title="Ports this thread's worktree is serving"
      className={cn(
        "flex min-h-6 min-w-0 max-w-72 items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-xs",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        isExpanded && "text-foreground",
      )}
    >
      <span className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full rounded-full bg-emerald-500 opacity-40" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      <span className="truncate">{summaryText(value.ports)}</span>
    </button>
  );
}

function StopButton({ onStop }: { onStop: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (!armed) return setArmed(true);
        setBusy(true);
        void onStop().finally(() => {
          setBusy(false);
          setArmed(false);
        });
      }}
      className={cn(
        "rounded px-2 py-0.5 text-xs transition-colors",
        armed ? "bg-destructive text-white" : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {busy ? "Stopping…" : armed ? "Confirm stop" : "Stop"}
    </button>
  );
}

function PortRow({
  port,
  onOpen,
  onStop,
}: {
  port: ThreadPort;
  onOpen: () => void;
  onStop: () => Promise<void>;
}) {
  const canOpen = port.role !== "internal" || port.url.startsWith("http");
  return (
    <li className="flex items-center gap-2 py-1 text-sm">
      <span className={cn("size-1.5 shrink-0 rounded-full", ROLE_DOT[port.role])} />
      <span className="w-14 shrink-0 font-mono tabular-nums">:{port.port}</span>
      <span className="min-w-0 flex-1 truncate">
        {portName(port)}
        <span className="text-muted-foreground"> · {port.role} · pid {port.pid}</span>
      </span>
      {canOpen && (
        <button
          type="button"
          onClick={onOpen}
          title={port.url}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="ExternalLink" className="size-3" />
          Open
        </button>
      )}
      <StopButton onStop={onStop} />
    </li>
  );
}

function PortsDetails({ threadId, environment, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const environmentId = environment?.id ?? null;
  const value = useEnvironmentPorts(environmentId);
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [message, setMessage] = useState<string | null>(null);
  if (!isExpanded || environmentId === null || value === null) return null;

  const stop = async (port: number) => {
    try {
      const result = await rpc.call("release_port", { environmentId, port });
      setMessage(result.detail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
    await refresh(environmentId);
  };

  const others = value.threads.filter((thread) => thread.id !== threadId);
  return (
    <div className="px-3 pb-2 pt-1">
      <ul className="divide-y divide-border/60">
        {value.ports.map((port) => (
          <PortRow
            key={`${port.source}:${port.port}`}
            port={port}
            onOpen={() => navigate.openUrl(port.url)}
            onStop={() => stop(port.port)}
          />
        ))}
      </ul>
      {message && <p className="pt-1 text-xs text-muted-foreground">{message}</p>}
      {others.length > 0 && (
        <p className="pt-1.5 text-xs text-muted-foreground">
          Ports belong to the worktree, which {others.length === 1 ? "another thread shares" : `${others.length} other threads share`}:{" "}
          {others.slice(0, 6).map((thread, index) => (
            <span key={thread.id}>
              {index > 0 && ", "}
              <button
                type="button"
                onClick={() => navigate.toThread(thread.id)}
                className="underline hover:text-foreground decoration-dotted underline-offset-2"
              >
                {thread.title}
              </button>
            </span>
          ))}
          {others.length > 6 && ` and ${others.length - 6} more`}
        </p>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "ports",
    title: "Ports",
    // After bb's thread (1_) and git (3_) groups: right of PR / Uncommitted.
    group: "4_ports",
    summary: PortsSummary,
    details: PortsDetails,
    useVisible,
  });
});
