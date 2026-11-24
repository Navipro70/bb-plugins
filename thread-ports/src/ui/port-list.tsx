// A thread's ports as rows with every action visible: Open, Copy (localhost
// and, for a port reachable on the network, LAN), and Stop with a confirm step.
import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PortRow, rpcContract } from "../../server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { refresh, useCopy } from "./store";

const CONFIRM_MS = 4_000;

function since(startedAt: number | null): string | null {
  if (startedAt === null) return null;
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

function IconButton({
  icon,
  fallback,
  label,
  onClick,
  className,
  children,
}: {
  icon: string;
  fallback?: string;
  label: string;
  onClick: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors",
        "hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
    >
      <Icon name={icon} fallback={fallback} className="size-3.5" aria-hidden />
      {children}
    </button>
  );
}

type StopState = "idle" | "armed" | "busy" | "failed";

function PortLine({ port, onNotice }: { port: PortRow; onNotice: (text: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const copy = useCopy();
  const [stop, setStop] = useState<StopState>("idle");

  useEffect(() => {
    if (stop !== "armed") return;
    const timer = window.setTimeout(() => setStop("idle"), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [stop]);

  const runStop = async (force: boolean) => {
    setStop("busy");
    try {
      const result = await rpc.call("stop", {
        hostId: port.hostId,
        pid: port.pid,
        port: port.port,
        startedAt: port.startedAt,
        force,
      });
      onNotice(result.detail);
      setStop(result.stopped ? "idle" : "failed");
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : String(cause));
      setStop("failed");
    }
    await refresh();
  };

  const copyText = async (text: string) => onNotice((await copy(text)) ? `Copied ${text}` : "Copy failed");
  const age = since(port.startedAt);
  const muted = port.kind !== "web";

  return (
    <li className="group/port rounded-md px-1.5 py-1 hover:bg-state-hover/40">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn("size-2 shrink-0 rounded-full", muted ? "bg-muted-foreground/40" : "bg-emerald-500")}
          aria-hidden
        />
        <span className={cn("shrink-0 font-mono text-sm tabular-nums", muted && "text-muted-foreground")}>
          :{port.port}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm" title={port.command}>
          {port.name}
        </span>
        {port.kind === "web" && (
          <IconButton icon="ExternalLink" fallback="Globe" label={`Open ${port.url}`} onClick={() => navigate.openUrl(port.url)} />
        )}
        <IconButton icon="Copy" label={`Copy ${port.url}`} onClick={() => void copyText(port.url)} />
        {stop === "idle" && (
          <IconButton icon="Square" fallback="X" label={`Stop :${port.port}`} onClick={() => setStop("armed")} />
        )}
        {stop === "armed" && (
          <button
            type="button"
            onClick={() => void runStop(false)}
            className="h-6 shrink-0 rounded bg-destructive px-2 text-xs font-medium text-white"
          >
            Stop?
          </button>
        )}
        {stop === "busy" && <span className="h-6 shrink-0 px-2 text-xs leading-6 text-muted-foreground">Stopping…</span>}
        {stop === "failed" && (
          <button
            type="button"
            onClick={() => void runStop(true)}
            className="h-6 shrink-0 rounded border border-destructive px-2 text-xs text-destructive"
          >
            Force kill
          </button>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-4 text-xs text-muted-foreground">
        <span className="truncate">
          {port.kind === "tool" ? "agent tool · " : port.kind === "internal" ? "internal · " : ""}pid {port.pid}
          {age && ` · ${age}`}
        </span>
        {port.lanUrl && (
          <button
            type="button"
            title={`Reachable from your network (phone, other machines). Click to copy ${port.lanUrl}`}
            onClick={() => void copyText(port.lanUrl as string)}
            className="shrink-0 rounded border border-border px-1 font-mono text-[10px] leading-4 hover:bg-state-hover hover:text-foreground"
          >
            LAN
          </button>
        )}
      </div>
    </li>
  );
}

/** Web ports first; agent tools and internal listeners fold behind a toggle. */
export function PortList({ ports, onNotice }: { ports: readonly PortRow[]; onNotice: (text: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const main = ports.filter((port) => port.kind === "web");
  const rest = ports.filter((port) => port.kind !== "web");
  const shown = main.length === 0 || showAll ? ports : main;
  return (
    <>
      <ul className="flex flex-col">
        {shown.map((port) => (
          <PortLine key={`${port.hostId}:${port.pid}:${port.port}`} port={port} onNotice={onNotice} />
        ))}
      </ul>
      {main.length > 0 && rest.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((open) => !open)}
          className="ml-5 mt-0.5 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          {showAll ? "Hide agent tools" : `+ ${rest.length} agent ${rest.length === 1 ? "tool" : "tools"}`}
        </button>
      )}
    </>
  );
}

/** A one-line message that clears itself. */
export function useNotice(): [string | null, (text: string) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}
