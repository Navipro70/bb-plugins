// bb-plugin-thread-ports — frontend entry.
//
// Three views of one snapshot (src/ui/store.ts):
// - a "Ports" panel in the sidebar footer: every thread that serves a port,
//   with Go to thread, Open, Copy and Stop on each row;
// - a segment in the context row above a thread's composer with that thread's
//   own ports, expanding into the same rows;
// - a glyph on the sidebar rows of threads that serve something.
import {
  definePluginApp,
  useBbNavigate,
  type ExperimentalSidebarFooterDisclosureProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import type { PortGroup, PortRow, PortSnapshot } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { PortList, useNotice } from "./src/ui/port-list";
import { usePorts } from "./src/ui/store";

const PLUGIN_ID = "thread-ports";
const SNAPSHOT_URL = `/api/v1/plugins/${PLUGIN_ID}/http/snapshot`;
const ROW_POLL_MS = 5_000;

function webPorts(ports: readonly PortRow[]): PortRow[] {
  return ports.filter((port) => port.kind === "web");
}

/** `vite :5173 · python http.server :8060`, or the tools when nothing else listens. */
function summaryText(ports: readonly PortRow[]): string {
  const lead = webPorts(ports).length > 0 ? webPorts(ports) : [...ports];
  const shown = lead.slice(0, 2).map((port) => `${port.name} :${port.port}`);
  if (lead.length > 2) shown.push(`+${lead.length - 2}`);
  return shown.join(" · ");
}

// ---------------------------------------------------------------- sidebar panel

function GroupCard({ group, onNotice }: { group: PortGroup; onNotice: (text: string) => void }) {
  const navigate = useBbNavigate();
  const threadId = group.threadExists ? group.threadId : null;
  return (
    <section className="rounded-lg border border-border/70 bg-background/40 p-1.5">
      <header className="flex min-w-0 items-start gap-1 px-1.5 pb-1 pt-0.5">
        <div className="min-w-0 flex-1">
          {threadId ? (
            <button
              type="button"
              onClick={() => navigate.toThread(threadId)}
              title="Go to the thread that started these servers"
              className="block max-w-full truncate text-left text-sm font-medium hover:underline"
            >
              {group.title}
            </button>
          ) : (
            <span className="block truncate text-sm font-medium text-muted-foreground">{group.title}</span>
          )}
          <span className="block truncate text-xs text-muted-foreground">
            {group.subtitle}
            {group.archived && " · archived thread"}
          </span>
        </div>
        {threadId && (
          <button
            type="button"
            onClick={() => navigate.toThread(threadId)}
            aria-label={`Go to ${group.title}`}
            title="Go to thread"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            Thread
            <Icon name="ArrowRight" className="size-3.5" aria-hidden />
          </button>
        )}
      </header>
      <PortList ports={group.ports} onNotice={onNotice} />
    </section>
  );
}

function PortsPanel(_props: ExperimentalSidebarFooterDisclosureProps) {
  const { snapshot, error } = usePorts();
  const [notice, setNotice] = useNotice();
  const groups = snapshot?.groups ?? [];
  const servers = groups.reduce((total, group) => total + webPorts(group.ports).length, 0);
  return (
    <div className="flex max-h-[60vh] w-full flex-col gap-2 overflow-y-auto p-2">
      <div className="flex items-baseline justify-between px-1">
        <span className="text-sm font-medium">Ports</span>
        <span className="text-xs text-muted-foreground">
          {snapshot === null
            ? "scanning…"
            : `${servers} ${servers === 1 ? "server" : "servers"} · ${groups.length} ${groups.length === 1 ? "thread" : "threads"}`}
        </span>
      </div>
      {snapshot !== null && groups.length === 0 && (
        <p className="px-1 text-xs text-muted-foreground">No BB thread is serving a port right now.</p>
      )}
      {groups.map((group) => (
        <GroupCard key={group.key} group={group} onNotice={setNotice} />
      ))}
      {(notice ?? error ?? snapshot?.errors[0]) && (
        <p className={cn("px-1 text-xs", notice ? "text-muted-foreground" : "text-destructive")}>
          {notice ?? error ?? snapshot?.errors[0]}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- context row

function threadPorts(snapshot: PortSnapshot | null, threadId: string): PortRow[] {
  return snapshot?.groups.find((group) => group.threadId === threadId)?.ports ?? [];
}

function useVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const { snapshot } = usePorts();
  return threadPorts(snapshot, threadId).length > 0;
}

function SegmentSummary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const { snapshot } = usePorts();
  const ports = threadPorts(snapshot, threadId);
  if (ports.length === 0) return null;
  const live = webPorts(ports).length > 0;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      title="Servers this thread started"
      className={cn(
        "flex min-h-6 min-w-0 max-w-72 items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-xs",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        isExpanded && "text-foreground",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", live ? "bg-emerald-500" : "bg-muted-foreground/40")} />
      <span className="truncate">{summaryText(ports)}</span>
    </button>
  );
}

function SegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { snapshot } = usePorts();
  const [notice, setNotice] = useNotice();
  if (!isExpanded) return null;
  const ports = threadPorts(snapshot, threadId);
  return (
    <div className="px-2 pb-2 pt-0.5">
      <PortList ports={ports} onNotice={setNotice} />
      {notice && <p className="px-1.5 pt-1 text-xs text-muted-foreground">{notice}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- registration

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "ports",
    label: "Ports",
    icon: "ElectricPlugs",
    component: PortsPanel,
  });

  app.slots.experimental_threadContextSegment({
    id: "ports",
    title: "Ports",
    // After bb's thread (1_) and git (3_) groups: right of PR / Uncommitted.
    group: "4_ports",
    summary: SegmentSummary,
    details: SegmentDetails,
    useVisible,
  });

  // Content scripts have no hooks, so the row markers poll the snapshot over
  // plain fetch and mark every thread that serves something.
  app.contentScripts.register({
    id: "thread-row-ports",
    mount({ signal, experimental_setThreadRowStatus: setStatus }) {
      if (setStatus === undefined) return;
      const painted = new Set<string>();
      let timer: number | null = null;
      const paint = (snapshot: PortSnapshot) => {
        const next = new Set<string>();
        for (const group of snapshot.groups) {
          if (group.threadId === null) continue;
          const web = webPorts(group.ports);
          if (web.length === 0) continue;
          next.add(group.threadId);
          setStatus(group.threadId, {
            icon: "ElectricPlugs",
            label: `Serving ${web.map((port) => `${port.name} :${port.port}`).join(", ")}`,
            tone: "success",
          });
        }
        for (const threadId of painted) if (!next.has(threadId)) setStatus(threadId, null);
        painted.clear();
        for (const threadId of next) painted.add(threadId);
      };
      const poll = async () => {
        if (signal.aborted) return;
        try {
          const response = await fetch(SNAPSHOT_URL, { signal });
          if (response.ok && !signal.aborted) paint((await response.json()) as PortSnapshot);
        } catch {
          // Keep the previous markers; the next poll reconciles.
        }
        if (!signal.aborted) timer = window.setTimeout(poll, ROW_POLL_MS);
      };
      void poll();
      return () => {
        if (timer !== null) window.clearTimeout(timer);
      };
    },
  });
});
