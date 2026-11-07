// bb-plugin-serve-sim — frontend entry.
//
// Registers a "Simulator (serve-sim)" tab for the thread side panel plus a header button
// that toggles it. The tab starts serve-sim through the server (server.ts) and
// embeds serve-sim's own preview page, which streams the simulator and sends
// touches/keys back over its same-origin WebSocket.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, ServeSimStatus, SimDevice } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { AnnotateIcon, AnnotateView } from "./annotate/view";
import { PAGE_SOURCE, PARENT_SOURCE } from "./annotate/inject";

const STATUS_CHANNEL = "serve-sim-status";
const TAB = { id: "simulator", context: { kind: "thread" }, availability: "action" } as const;
const TITLE = "Simulator (serve-sim)";

/** Mounted panels by thread, so the Annotate command reaches the one on screen. */
const panels = new Map<string, { annotate(): void }>();
/** Threads whose panel should open in Annotate mode when it mounts. */
const annotateOnMount = new Set<string>();

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useServeSim() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<ServeSimStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("status").then(
      (next) => {
        setStatus(next);
        setError(null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(STATUS_CHANNEL, refetch);
  return { rpc, status, error, setError, refetch };
}

function useDevices(enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [devices, setDevices] = useState<SimDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    rpc.call("devices").then(
      (result) => {
        setDevices(result.devices);
        setError(result.error);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);
  return { devices, error, reload };
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">{children}</div>
    </div>
  );
}

function Logs() {
  const rpc = useRpc<typeof rpcContract>();
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      rpc.call("logs").then(
        (result) => alive && setLines(result.lines.slice(-12)),
        () => undefined,
      );
    load();
    const timer = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [rpc]);
  if (lines.length === 0) return null;
  return (
    <pre className="max-h-48 w-full overflow-auto rounded-md border border-border bg-muted/40 p-2 text-left font-mono text-[11px] leading-snug text-muted-foreground">
      {lines.join("\n")}
    </pre>
  );
}

function StartScreen({
  status,
  onStart,
  pending,
}: {
  status: ServeSimStatus;
  onStart: (device: string | null) => void;
  pending: boolean;
}) {
  const { devices, error, reload } = useDevices(true);
  const [device, setDevice] = useState<string>("");
  const booted = devices?.filter((d) => d.state === "Booted") ?? [];
  const starting = status.state === "starting" || pending;

  return (
    <Centered>
      <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40">
        <Icon name="Smartphone" className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-medium">iOS Simulator</h2>
        <p className="text-sm text-muted-foreground">
          Streams a simulator into this panel with{" "}
          <a
            className="underline underline-offset-2"
            href="https://github.com/EvanBacon/serve-sim"
            target="_blank"
            rel="noreferrer"
          >
            serve-sim
          </a>
          . Click to tap, drag to swipe, type to send keys.
        </p>
      </div>

      <div className="flex w-full items-center gap-2">
        <select
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          value={device}
          disabled={starting}
          onChange={(event) => setDevice(event.target.value)}
          aria-label="Simulator"
        >
          <option value="">
            {booted.length > 0 ? `Booted simulator (${booted.map((d) => d.name).join(", ")})` : "Auto (boot default)"}
          </option>
          {devices?.map((d) => (
            <option key={d.udid} value={d.udid}>
              {d.state === "Booted" ? "● " : ""}
              {d.name} — {d.runtime}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="icon" className="size-9" onClick={reload} aria-label="Refresh devices">
          <Icon name="ArrowReloadHorizontal" className="size-4" />
        </Button>
      </div>

      <Button className="w-full" disabled={starting} onClick={() => onStart(device === "" ? null : device)}>
        <Icon name={starting ? "Spinner" : "Play"} className={cn("size-4", starting && "animate-spin")} />
        {starting ? "Starting serve-sim…" : "Start simulator"}
      </Button>

      {status.state === "starting" ? (
        <p className="text-xs text-muted-foreground">
          The first run downloads serve-sim with npx and can take a minute.
        </p>
      ) : null}
      {status.state === "error" && status.error ? (
        <p role="alert" className="text-sm text-destructive">
          {status.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {status.state !== "stopped" ? <Logs /> : null}
    </Centered>
  );
}

function LivePanel({
  onAnnotate,
  frameRef,
}: {
  onAnnotate(): void;
  frameRef: RefObject<HTMLIFrameElement | null>;
}) {
  const { rpc, status, error, setError, refetch } = useServeSim();
  const [pending, setPending] = useState(false);
  const [frameKey, setFrameKey] = useState(0);

  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    try {
      await action();
      refetch();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  if (status === null) {
    return <Centered>{error ? <p className="text-sm text-destructive">{error}</p> : <p className="text-sm text-muted-foreground">Loading…</p>}</Centered>;
  }

  if (status.state !== "running" || status.url === null) {
    return (
      <StartScreen
        status={status}
        pending={pending}
        onStart={(device) => void run(() => rpc.call("start", { device }))}
      />
    );
  }

  // Through the proxy the page has an Annotate button in its own toolbar.
  const url = status.proxyUrl ?? status.url;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-xs text-muted-foreground">
        <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono">{url.replace(/^http:\/\//, "")}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-label="Annotate: pick an element and send a note to the agent (⌥⌘A)"
          onClick={onAnnotate}
        >
          <AnnotateIcon />
          Annotate
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Reload preview"
          onClick={() => setFrameKey((key) => key + 1)}
        >
          <Icon name="ArrowReloadHorizontal" className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Open in browser"
          onClick={() => window.open(url, "_blank", "noopener")}
        >
          <Icon name="ExternalLink" className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Stop serve-sim"
          disabled={pending}
          onClick={() => void run(() => rpc.call("stop"))}
        >
          <Icon name="Square" className="size-3.5" />
        </Button>
      </div>
      <iframe
        ref={frameRef}
        key={frameKey}
        src={url}
        title="iOS Simulator"
        className="min-h-0 w-full flex-1 border-0 bg-background"
        allow="clipboard-read; clipboard-write; fullscreen; autoplay"
      />
    </div>
  );
}

/**
 * The Simulator tab: the live stream, with Annotate mode over it. The stream
 * stays mounted under Annotate, so going back to live is instant.
 */
function SimulatorPanel({ threadId }: { threadId: string; params: unknown }) {
  const { status } = useServeSim();
  const [annotating, setAnnotating] = useState(() => annotateOnMount.delete(threadId));
  const exit = useCallback(() => setAnnotating(false), []);
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Where the page draws the live screen, in the page and then in the panel.
  const [inner, setInner] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [pageUdid, setPageUdid] = useState<string | null>(null);
  const [frame, setFrame] = useState<typeof inner>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; rect?: typeof inner; udid?: string | null };
      if (!data || data.source !== PAGE_SOURCE || event.source !== frameRef.current?.contentWindow) return;
      if (data.type === "toggle") setAnnotating((on) => !on);
      else if (data.type === "exit") setAnnotating(false);
      else if (data.type === "screen") {
        setInner(data.rect ?? null);
        setPageUdid(data.udid ?? null);
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, []);

  // Tell the page whether Annotate is on, so its button shows it.
  useEffect(() => {
    const post = () =>
      frameRef.current?.contentWindow?.postMessage({ source: PARENT_SOURCE, type: "state", active: annotating }, "*");
    post();
    const timer = setInterval(post, 1000);
    return () => clearInterval(timer);
  }, [annotating]);

  // The page's rectangle, moved by the iframe's place in the panel.
  useEffect(() => {
    const measure = () => {
      const root = rootRef.current?.getBoundingClientRect();
      const box = frameRef.current?.getBoundingClientRect();
      if (!inner || !root || !box) return setFrame(null);
      setFrame({ x: box.left - root.left + inner.x, y: box.top - root.top + inner.y, width: inner.width, height: inner.height });
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [inner, annotating]);
  useEffect(() => {
    const control = { annotate: () => setAnnotating(true) };
    panels.set(threadId, control);
    return () => {
      if (panels.get(threadId) === control) panels.delete(threadId);
    };
  }, [threadId]);
  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-1 flex-col">
      <LivePanel onAnnotate={() => setAnnotating((on) => !on)} frameRef={frameRef} />
      {annotating ? (
        <AnnotateView
          threadId={threadId}
          device={pageUdid ?? status?.device ?? null}
          frame={status?.proxyUrl ? frame : null}
          onExit={exit}
        />
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...TAB,
    title: "Simulator (serve-sim)",
    icon: "Smartphone",
    tooltip: "iOS Simulator (serve-sim)",
    layout: "flush",
    component: SimulatorPanel,
  });

  app.slots.experimental_threadAction({
    id: "open-simulator",
    title: "Simulator (serve-sim)",
    icon: "Smartphone",
    group: experimental_THREAD_ACTION_GROUPS.open,
    placement: "header",
    item: ({ experimental_panel }) => ({
      label: "Simulator (serve-sim)",
      icon: "Smartphone",
      run: () => {
        experimental_panel.toggleTab({ tab: TAB, title: TITLE });
      },
    }),
  });

  app.commands.register({
    id: "annotate",
    title: "Simulator (serve-sim): Annotate an element",
    defaultShortcut: { key: "a", mod: true, alt: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId, experimental_panel }) => {
      if (!threadId) return;
      const panel = panels.get(threadId);
      if (!panel) annotateOnMount.add(threadId);
      experimental_panel.openTab({ tab: TAB, title: TITLE });
      panel?.annotate();
    },
  });
});
