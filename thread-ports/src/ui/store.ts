// One snapshot for the whole app window: the sidebar panel, every thread's
// context row and the thread-row markers read the same poller, which runs only
// while at least one of them is mounted.
import { useCallback, useSyncExternalStore } from "react";
import { useRpc, type PluginRpcClient } from "@get-bb/plugin-sdk/app";
import type { PortSnapshot, rpcContract } from "../../server";

export type Rpc = PluginRpcClient<typeof rpcContract>;

const POLL_MS = 3_000;

let value: PortSnapshot | null = null;
let error: string | null = null;
let client: Rpc | null = null;
let timer: number | null = null;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function refresh(): Promise<void> {
  if (client === null) return Promise.resolve();
  inFlight ??= client
    .call("snapshot")
    .then(
      (next) => {
        value = next;
        error = null;
      },
      (cause: unknown) => {
        error = cause instanceof Error ? cause.message : String(cause);
      },
    )
    .finally(() => {
      inFlight = null;
      emit();
    });
  return inFlight;
}

function schedule(): void {
  if (listeners.size === 0 || timer !== null) return;
  timer = window.setTimeout(async () => {
    timer = null;
    await refresh();
    schedule();
  }, POLL_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refresh();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
}

const read = () => value;
const readError = () => error;

/** The latest snapshot (null until the first answer) and the last error. */
export function usePorts(): { snapshot: PortSnapshot | null; error: string | null; rpc: Rpc } {
  const rpc = useRpc<typeof rpcContract>();
  client ??= rpc;
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const lastError = useSyncExternalStore(subscribe, readError, readError);
  return { snapshot, error: lastError, rpc };
}

/** Copy text, falling back to a hidden textarea where the async API is blocked. */
export function useCopy(): (text: string) => Promise<boolean> {
  return useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    }
  }, []);
}
