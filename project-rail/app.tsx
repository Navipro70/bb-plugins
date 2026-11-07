// Project Rail — frontend.
//
// A rail navigation provider that draws bb's own rail (Home, plugin panels,
// More) with one icon per project under Home. Clicking a project icon focuses
// the sidebar thread list on that project; clicking it again shows every
// project. Cmd/Ctrl-click starts a new thread in that project. Drag icons to
// reorder (persisted as bb's project order); right-click for more options.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_SidebarNavigationIcon as NavIcon,
  experimental_useSidebarNavigation as useSidebarNavigation,
  experimental_useSidebarNavigationSplit as useSidebarNavigationSplit,
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  type ExperimentalSidebarHeaderProps,
  type ExperimentalSidebarNavigationItem,
  type PluginSidebarProject,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { ProjectIcon, RailState, rpcContract } from "./server";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

const NEW_THREAD_ID = "__bb__/new-thread";
const PERSONAL_PROJECT_ID = "proj_personal";

const RAIL_BUTTON = cn(
  "relative flex size-(--bb-sidebar-control-size) shrink-0 cursor-pointer items-center justify-center rounded-md p-0 text-muted-foreground ring-sidebar-ring outline-none",
  "hover:bg-state-hover hover:text-sidebar-foreground focus-visible:ring-2",
  "aria-[current=page]:bg-state-active aria-[current=page]:text-sidebar-foreground",
  "data-[state=open]:bg-state-active data-[state=open]:text-sidebar-foreground",
  "disabled:cursor-default disabled:opacity-70",
  "[&_[data-icon-root]]:size-(--bb-sidebar-control-icon-size)",
);

const PALETTE = [
  "#0f9d8a",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#ef4444",
  "#64748b",
];

function colorFor(project: PluginSidebarProject, icon: ProjectIcon | undefined) {
  if (icon?.color) return icon.color;
  let hash = 0;
  for (const char of project.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function initialsFor(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0] ?? name;
  return word.slice(0, 2).toUpperCase();
}

/** Shared rail state: focused project and icons, kept live by realtime. */
function useRailState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<RailState>({
    focusedProjectId: null,
    icons: {},
    hiddenProjectIds: [],
    position: "top",
    homes: {},
    homeStyle: "grouped",
  });
  const [loaded, setLoaded] = useState(false);
  const refetch = useCallback(() => {
    rpc.call("state_get", null).then((next) => {
      setState(next);
      setLoaded(true);
    }, () => {});
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("rail-changed", refetch);
  const setFocus = useCallback(
    (projectId: string | null) => {
      setState((previous) => ({ ...previous, focusedProjectId: projectId }));
      rpc.call("focus_set", { projectId }).then(setState, refetch);
    },
    [rpc, refetch],
  );
  const setLayout = useCallback(
    (change: {
      hiddenProjectIds?: string[];
      position?: "top" | "bottom";
      homes?: Record<string, string>;
      homeStyle?: "grouped" | "badges";
    }) => {
      setState((previous) => ({ ...previous, ...change }));
      rpc.call("layout_set", change).then(setState, refetch);
    },
    [rpc, refetch],
  );
  return { state, loaded, setFocus, setLayout };
}

/**
 * Projects in bb's saved order with a local optimistic override while a
 * reorder is in flight. Moves persist through `projects.reorder`, the same
 * order the thread list uses when organized by project.
 */
function useProjectOrder(projects: readonly PluginSidebarProject[]) {
  const sdk = useSdk();
  const [override, setOverride] = useState<string[] | null>(null);
  const serverIds = projects.map((project) => project.id).join("|");
  useEffect(() => setOverride(null), [serverIds]);
  const ordered = useMemo(() => {
    if (override === null) return projects;
    const byId = new Map(projects.map((project) => [project.id, project]));
    const result = override
      .map((id) => byId.get(id))
      .filter((project): project is PluginSidebarProject => project !== undefined);
    for (const project of projects) if (!override.includes(project.id)) result.push(project);
    return result;
  }, [projects, override]);
  const move = useCallback(
    (projectId: string, toIndex: number) => {
      const ids = ordered.map((project) => project.id);
      const from = ids.indexOf(projectId);
      if (from === -1) return;
      const target = Math.max(0, Math.min(ids.length - 1, toIndex));
      if (target === from) return;
      ids.splice(from, 1);
      ids.splice(target, 0, projectId);
      setOverride(ids);
      const index = ids.indexOf(projectId);
      sdk.projects
        .reorder({
          projectId,
          previousProjectId: ids[index - 1] ?? null,
          nextProjectId: ids[index + 1] ?? null,
        })
        .catch((error: unknown) => {
          setOverride(null);
          toast.error(
            `Could not move the project: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    },
    [ordered, sdk],
  );
  return { ordered, move };
}

/**
 * Set right before any deliberate trip to the new-thread screen (our header,
 * menus, bb's New thread shortcut) so the home redirect leaves it alone.
 */
let composeIntentAt = 0;
function markComposeIntent() {
  composeIntentAt = Date.now();
}

function matchesShortcut(event: KeyboardEvent, ariaKeyShortcuts: string): boolean {
  return ariaKeyShortcuts.split(" ").some((combo) => {
    const parts = combo.split("+");
    const key = parts.pop()?.toLowerCase();
    if (key === undefined || event.key.toLowerCase() !== key) return false;
    const mods = new Set(parts.map((part) => part.toLowerCase()));
    return (
      mods.has("meta") === event.metaKey &&
      mods.has("control") === event.ctrlKey &&
      mods.has("shift") === event.shiftKey &&
      mods.has("alt") === event.altKey
    );
  });
}

const THREAD_ROUTE = /\/threads\/[^/]+/;
const COMPOSE_ROUTE = /^\/(projects\/[^/]+\/?)?$/;

/**
 * When the focused project has a home panel, leaving a thread for the bare
 * new-thread screen (closing or archiving the open chat) lands on that home
 * instead. Deliberate New thread clicks and the New thread shortcut are left
 * alone.
 */
function useHomeRedirect(
  homeItemId: string | null,
  activate: (itemId: string) => void,
  newThreadShortcut: string | null,
) {
  useEffect(() => {
    if (newThreadShortcut === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (matchesShortcut(event, newThreadShortcut)) markComposeIntent();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [newThreadShortcut]);

  useEffect(() => {
    if (homeItemId === null) return;
    let previous = window.location.pathname;
    const timer = window.setInterval(() => {
      const current = window.location.pathname;
      if (current === previous) return;
      const leftThread = THREAD_ROUTE.test(previous) && COMPOSE_ROUTE.test(current);
      previous = current;
      if (leftThread && Date.now() - composeIntentAt > 1500) activate(homeItemId);
    }, 200);
    return () => window.clearInterval(timer);
  }, [homeItemId, activate]);
}

type Attention = "waiting" | "error" | "unread" | "working" | null;

function attentionFor(threads: readonly PluginSidebarThread[]): Attention {
  let result: Attention = null;
  const rank = { waiting: 4, error: 3, unread: 2, working: 1 } as const;
  for (const thread of threads) {
    let next: Attention = null;
    if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") next = "waiting";
    else if (thread.indicator === "unread-error" || thread.indicator === "queued-failed") next = "error";
    else if (thread.indicator === "unread-success") next = "unread";
    else if (thread.indicator !== "none" && thread.indicator !== "draft") next = "working";
    if (next !== null && (result === null || rank[next] > rank[result])) result = next;
  }
  return result;
}

const ATTENTION_DOT: Record<Exclude<Attention, null>, string> = {
  waiting: "bg-amber-500",
  error: "bg-red-500",
  unread: "bg-sky-500",
  working: "bg-emerald-500 animate-pulse",
};
const ATTENTION_LABEL: Record<Exclude<Attention, null>, string> = {
  waiting: "needs your input",
  error: "failed",
  unread: "unread",
  working: "working",
};

const BADGE_ATTR = "data-project-rail-badge";

/** A 14px project glyph as plain DOM, for rows bb's thread list owns. */
function buildBadge(project: PluginSidebarProject, icon: ProjectIcon | undefined): HTMLElement {
  const badge = document.createElement("span");
  badge.setAttribute(BADGE_ATTR, `${project.id}|${icon?.image ? "i" : icon?.emoji ?? ""}|${icon?.color ?? ""}|${project.name}`);
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", project.name);
  badge.title = project.name;
  Object.assign(badge.style, {
    display: "inline-flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    marginRight: "6px",
    borderRadius: "4px",
    overflow: "hidden",
    pointerEvents: "auto",
    position: "relative",
    zIndex: "31",
  });
  if (icon?.image) {
    const img = document.createElement("img");
    img.src = icon.image;
    img.alt = "";
    img.draggable = false;
    Object.assign(img.style, { width: "100%", height: "100%", objectFit: "cover" });
    badge.append(img);
  } else if (icon?.emoji) {
    badge.textContent = icon.emoji;
    Object.assign(badge.style, { fontSize: "11px", lineHeight: "1" });
  } else {
    badge.textContent = initialsFor(project.name).slice(0, 1);
    Object.assign(badge.style, {
      backgroundColor: colorFor(project, icon),
      color: "#fff",
      fontSize: "8.5px",
      fontWeight: "600",
      lineHeight: "1",
    });
  }
  return badge;
}

const NO_PROJECT_KEY = "none";

/** Threads outside any project: a hollow circle in the same 14px slot. */
function buildEmptyBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.setAttribute(BADGE_ATTR, NO_PROJECT_KEY);
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", "No project");
  badge.title = "No project";
  Object.assign(badge.style, {
    display: "inline-flex",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    marginRight: "6px",
    pointerEvents: "auto",
    position: "relative",
    zIndex: "31",
  });
  const ring = document.createElement("span");
  Object.assign(ring.style, {
    width: "10px",
    height: "10px",
    borderRadius: "9999px",
    border: "1.5px solid light-dark(rgba(0, 0, 0, 0.55), rgba(255, 255, 255, 0.9))",
    boxSizing: "border-box",
  });
  badge.append(ring);
  return badge;
}

/**
 * Home in "badges" style: put the thread's project icon before its agent icon
 * on every row of bb's thread list. bb has no slot for that, so this decorates
 * the rows it renders and keeps up with them; turning it off removes every badge.
 */
function useProjectBadges(
  enabled: boolean,
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
  icons: Record<string, ProjectIcon>,
) {
  useEffect(() => {
    const clear = () => document.querySelectorAll(`[${BADGE_ATTR}]`).forEach((node) => node.remove());
    if (!enabled) {
      clear();
      return;
    }
    const projectOf = new Map(threads.map((thread) => [thread.id, thread.projectId]));
    const byId = new Map(projects.filter((p) => !p.isPersonal).map((p) => [p.id, p]));
    let frame = 0;
    const apply = () => {
      frame = 0;
      for (const link of Array.from(document.querySelectorAll<HTMLElement>("a[data-sidebar-thread-id]"))) {
        const row = link.parentElement;
        const provider = row?.querySelector<HTMLElement>("[data-sidebar-thread-provider]");
        if (!row || !provider) continue;
        const existing = row.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
        const project = byId.get(projectOf.get(link.dataset.sidebarThreadId ?? "") ?? "");
        if (project === undefined) {
          if (existing?.getAttribute(BADGE_ATTR) === NO_PROJECT_KEY && existing.nextElementSibling === provider) continue;
          existing?.remove();
          provider.before(buildEmptyBadge());
          continue;
        }
        const icon = icons[project.id];
        const key = `${project.id}|${icon?.image ? "i" : icon?.emoji ?? ""}|${icon?.color ?? ""}|${project.name}`;
        if (existing?.getAttribute(BADGE_ATTR) === key && existing.nextElementSibling === provider) continue;
        existing?.remove();
        provider.before(buildBadge(project, icon));
      }
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(apply);
    };
    apply();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
      clear();
    };
  }, [enabled, threads, projects, icons]);
}

function ProjectGlyph({
  project,
  icon,
}: {
  project: PluginSidebarProject;
  icon: ProjectIcon | undefined;
}) {
  if (icon?.image) {
    return (
      <img
        src={icon.image}
        alt=""
        draggable={false}
        className="size-5 rounded-[5px] object-cover"
      />
    );
  }
  if (icon?.emoji) {
    return <span className="text-[15px] leading-none">{icon.emoji}</span>;
  }
  return (
    <span
      className="flex size-5 items-center justify-center rounded-[5px] text-[9px] font-semibold tracking-tight text-white"
      style={{ backgroundColor: colorFor(project, icon) }}
    >
      {initialsFor(project.name)}
    </span>
  );
}

const MENU_ITEM =
  "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0";
const MENU_CONTENT =
  "z-50 min-w-44 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md";

type DropMark = { projectId: string; after: boolean } | null;

function ProjectButton({
  project,
  icon,
  isFocused,
  attention,
  index,
  count,
  position,
  dropMark,
  onActivate,
  onNewThread,
  onOpenPage,
  onMove,
  onHide,
  onTogglePosition,
  homeItemId,
  panels,
  onSetHome,
  onDragStartProject,
  onDragOverProject,
  onDropProject,
  onDragEndProject,
}: {
  project: PluginSidebarProject;
  icon: ProjectIcon | undefined;
  isFocused: boolean;
  attention: Attention;
  index: number;
  count: number;
  position: "top" | "bottom";
  dropMark: DropMark;
  onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
  onNewThread: () => void;
  onOpenPage: () => void;
  onMove: (toIndex: number) => void;
  onHide: () => void;
  onTogglePosition: () => void;
  homeItemId: string | null;
  panels: readonly ExperimentalSidebarNavigationItem[];
  onSetHome: (itemId: string | null) => void;
  onDragStartProject: () => void;
  onDragOverProject: (after: boolean) => void;
  onDropProject: () => void;
  onDragEndProject: () => void;
}) {
  const portalProps = usePortalScopeProps();
  const label =
    attention === null
      ? project.name
      : `${project.name}, ${ATTENTION_LABEL[attention]}`;
  const mark = dropMark?.projectId === project.id ? dropMark : null;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <button
          type="button"
          draggable
          aria-label={label}
          aria-current={isFocused ? "page" : undefined}
          title={
            isFocused
              ? `${project.name} — click to show all projects`
              : `${project.name} — drag to reorder, right-click for options`
          }
          data-project-rail-item={project.id}
          className={cn(RAIL_BUTTON, isFocused && "ring-1 ring-sidebar-foreground/30")}
          onClick={onActivate}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/x-project-rail", project.id);
            onDragStartProject();
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("text/x-project-rail")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const rect = event.currentTarget.getBoundingClientRect();
            onDragOverProject(event.clientY > rect.top + rect.height / 2);
          }}
          onDrop={(event) => {
            event.preventDefault();
            onDropProject();
          }}
          onDragEnd={onDragEndProject}
        >
          {isFocused ? (
            <span
              aria-hidden="true"
              className="absolute -left-1.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-sidebar-foreground"
            />
          ) : null}
          {mark ? (
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-sky-500",
                mark.after ? "-bottom-1" : "-top-1",
              )}
            />
          ) : null}
          <ProjectGlyph project={project} icon={icon} />
          {attention !== null ? (
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute right-0 top-0 size-2 rounded-full ring-2 ring-sidebar",
                ATTENTION_DOT[attention],
              )}
            />
          ) : null}
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content {...portalProps} className={MENU_CONTENT} aria-label={`${project.name} options`}>
          <ContextMenu.Label className="px-2 py-[0.3125rem] text-xs font-medium text-muted-foreground">
            {project.name}
          </ContextMenu.Label>
          <ContextMenu.Item className={MENU_ITEM} onSelect={onNewThread}>
            <Icon name="Plus" aria-hidden="true" />
            New thread here
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={onOpenPage}>
            <Icon name="FolderOpen" aria-hidden="true" />
            Open project page
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={MENU_ITEM}>
              <Icon name="LayoutDashboard" aria-hidden="true" />
              Home page
              <span className="ml-auto max-w-24 truncate pl-3 text-muted-foreground">
                {panels.find((panel) => panel.id === homeItemId)?.label ?? "Threads"}
              </span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent {...portalProps} className={MENU_CONTENT} sideOffset={4}>
                <ContextMenu.RadioGroup
                  value={homeItemId ?? ""}
                  onValueChange={(value) => onSetHome(value === "" ? null : value)}
                >
                  <ContextMenu.RadioItem className={MENU_ITEM} value="">
                    <Icon name={homeItemId === null ? "Check" : "MessageSquare"} aria-hidden="true" />
                    Thread list
                  </ContextMenu.RadioItem>
                  {panels.map((panel) => (
                    <ContextMenu.RadioItem key={panel.id} className={MENU_ITEM} value={panel.id}>
                      {homeItemId === panel.id ? (
                        <Icon name="Check" aria-hidden="true" />
                      ) : (
                        <NavIcon icon={panel.icon} />
                      )}
                      {panel.label}
                    </ContextMenu.RadioItem>
                  ))}
                </ContextMenu.RadioGroup>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
          <ContextMenu.Item className={MENU_ITEM} disabled={index === 0} onSelect={() => onMove(index - 1)}>
            <Icon name="ChevronUp" aria-hidden="true" />
            Move up
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} disabled={index === count - 1} onSelect={() => onMove(index + 1)}>
            <Icon name="ChevronDown" aria-hidden="true" />
            Move down
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} disabled={index === 0} onSelect={() => onMove(0)}>
            <Icon name="ArrowUp" aria-hidden="true" />
            Move to top
          </ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={onTogglePosition}>
            <Icon name="ArrowUpDown" aria-hidden="true" />
            {position === "top" ? "Put projects below panels" : "Put projects above panels"}
          </ContextMenu.Item>
          <ContextMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
          <ContextMenu.Item className={MENU_ITEM} onSelect={onHide}>
            <Icon name="EyeOff" aria-hidden="true" />
            Hide from rail
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function RailButton({
  label,
  active = false,
  children,
  ...props
}: {
  label: string;
  active?: boolean;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={RAIL_BUTTON}
      {...props}
    >
      {children}
    </button>
  );
}

function NavItemButton({ item }: { item: ExperimentalSidebarNavigationItem }) {
  const { activeItemId, actions } = useSidebarNavigation();
  const split = useSidebarNavigationSplit(item.id);
  const label = item.badge ? `${item.label}, ${item.badge.label}` : item.label;
  return (
    <span className="flex" data-nav-rail-item={item.id}>
    <RailButton
      label={item.shortcut ? `${label} (${item.shortcut.label})` : label}
      active={item.id === activeItemId}
      disabled={item.isDisabled}
      aria-busy={item.isLoading || undefined}
      aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
      className={cn(RAIL_BUTTON, item.isLoading && "opacity-60")}
      {...split.splitProps}
      onClick={(event) =>
        actions.activate(item.id, {
          target: event.metaKey || event.ctrlKey ? "split" : "current",
        })
      }
    >
      <NavIcon icon={item.icon} />
      {item.badge ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-sky-500"
        />
      ) : null}
    </RailButton>
    </span>
  );
}

function MoreMenu({
  hidden,
  hiddenProjects,
  onShowProject,
  homeStyle,
  onHomeStyle,
}: {
  hidden: readonly ExperimentalSidebarNavigationItem[];
  hiddenProjects: readonly PluginSidebarProject[];
  onShowProject: (projectId: string) => void;
  homeStyle: "grouped" | "badges";
  onHomeStyle: (style: "grouped" | "badges") => void;
}) {
  const { actions } = useSidebarNavigation();
  const portalProps = usePortalScopeProps();
  const itemClass =
    "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs outline-none focus:bg-state-hover focus:text-foreground data-[disabled]:opacity-50 [&_[data-icon-root]]:size-4";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label="More" title="More" className={RAIL_BUTTON}>
          <Icon name="MoreHorizontal" aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...portalProps}
          side="right"
          align="start"
          sideOffset={12}
          className="z-50 min-w-40 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {hidden.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              disabled={item.isDisabled || item.isLoading}
              className={itemClass}
              onSelect={() => actions.activate(item.id, { target: "current" })}
            >
              <NavIcon icon={item.icon} />
              {item.label}
            </DropdownMenu.Item>
          ))}
          {hidden.length > 0 ? (
            <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
          ) : null}
          {hiddenProjects.length > 0 ? (
            <>
              <DropdownMenu.Label className="px-2 py-[0.3125rem] text-xs font-medium text-muted-foreground">
                Hidden projects
              </DropdownMenu.Label>
              {hiddenProjects.map((project) => (
                <DropdownMenu.Item
                  key={project.id}
                  className={itemClass}
                  onSelect={() => onShowProject(project.id)}
                >
                  <Icon name="Eye" aria-hidden="true" />
                  Show {project.name}
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
            </>
          ) : null}
          <DropdownMenu.Label className="px-2 py-[0.3125rem] text-xs font-medium text-muted-foreground">
            Home thread list
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={homeStyle}
            onValueChange={(value) => onHomeStyle(value === "badges" ? "badges" : "grouped")}
          >
            <DropdownMenu.RadioItem className={itemClass} value="grouped">
              <Icon name={homeStyle === "grouped" ? "Check" : "Rows3"} aria-hidden="true" />
              Grouped by project
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem className={itemClass} value="badges">
              <Icon name={homeStyle === "badges" ? "Check" : "Tag"} aria-hidden="true" />
              One list, project icons
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-muted" />
          <DropdownMenu.Item className={itemClass} onSelect={() => actions.openCustomize()}>
            <Icon name="SlidersHorizontal" aria-hidden="true" />
            Customize navigation
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Divider() {
  return <span aria-hidden="true" className="my-0.5 h-px w-5 shrink-0 bg-sidebar-border" />;
}

function ProjectRail() {
  const { items, activeItemId, isHomeActive, actions } = useSidebarNavigation();
  const { projects, threads } = useSidebarThreads();
  const navigate = useBbNavigate();
  const { state, loaded, setFocus, setLayout } = useRailState();

  const navItems = items.filter((item) => item.action.kind !== "new-thread");
  const visible = navItems.filter((item) => item.isVisible);
  const hidden = navItems.filter((item) => !item.isVisible);
  const realProjects = useMemo(
    () => projects.filter((project) => !project.isPersonal),
    [projects],
  );
  const { ordered, move } = useProjectOrder(realProjects);
  const hiddenIds = new Set(state.hiddenProjectIds);
  const shownProjects = ordered.filter((project) => !hiddenIds.has(project.id));
  const hiddenProjects = ordered.filter((project) => hiddenIds.has(project.id));

  const panels = navItems.filter((item) => item.action.kind === "open-plugin-panel");
  const homeFor = (projectId: string | null): string | null => {
    if (projectId === null) return null;
    const home = state.homes[projectId];
    return home !== undefined && panels.some((panel) => panel.id === home) ? home : null;
  };
  const focusedHome = homeFor(state.focusedProjectId);
  const activateHome = useCallback(
    (itemId: string) => actions.activate(itemId, { target: "current" }),
    [actions],
  );
  const newThreadItem = items.find((item) => item.id === NEW_THREAD_ID);
  useHomeRedirect(
    focusedHome,
    activateHome,
    newThreadItem?.shortcut?.ariaKeyShortcuts ?? null,
  );

  // Opening any other rail destination (a plugin panel, Plugins, Skills,
  // Automations) drops the project focus. A panel that is some project's home
  // focuses that project instead, so the thread list shows its threads only —
  // even when the project's own icon is hidden from the rail.
  // Thread-list routes (a thread, the new-thread screen, a project page) keep
  // the focus: New thread in a focused project must not bounce back to Home.
  const lastActiveItemId = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (activeItemId === lastActiveItemId.current) return;
    lastActiveItemId.current = activeItemId;
    if (activeItemId === null || isHomeActive || activeItemId === NEW_THREAD_ID) return;
    const linked =
      Object.entries(state.homes).find(
        ([projectId, home]) =>
          home === activeItemId && projects.some((project) => project.id === projectId),
      )?.[0] ?? null;
    if (linked !== state.focusedProjectId) setFocus(linked);
  }, [activeItemId, isHomeActive, loaded, state.homes, state.focusedProjectId, projects, setFocus]);

  useProjectBadges(
    loaded && state.homeStyle === "badges" && state.focusedProjectId === null,
    threads,
    projects,
    state.icons,
  );

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<DropMark>(null);

  const attentionByProject = useMemo(() => {
    const grouped = new Map<string, PluginSidebarThread[]>();
    for (const thread of threads) {
      const list = grouped.get(thread.projectId);
      if (list) list.push(thread);
      else grouped.set(thread.projectId, [thread]);
    }
    const result = new Map<string, Attention>();
    for (const [projectId, list] of grouped) result.set(projectId, attentionFor(list));
    return result;
  }, [threads]);

  // A focused project that was deleted would hide everything; drop the focus.
  useEffect(() => {
    if (
      state.focusedProjectId !== null &&
      projects.length > 0 &&
      !projects.some((project) => project.id === state.focusedProjectId)
    ) {
      setFocus(null);
    }
  }, [projects, state.focusedProjectId, setFocus]);

  /** Move within the full order so hidden projects keep their place. */
  const moveShown = (projectId: string, shownIndex: number) => {
    const clamped = Math.max(0, Math.min(shownProjects.length - 1, shownIndex));
    const anchor = shownProjects[clamped];
    if (anchor === undefined) return;
    move(projectId, ordered.findIndex((project) => project.id === anchor.id));
  };

  const drop = () => {
    if (dragId === null || dropMark === null || dragId === dropMark.projectId) {
      setDragId(null);
      setDropMark(null);
      return;
    }
    const without = shownProjects.filter((project) => project.id !== dragId);
    let target = without.findIndex((project) => project.id === dropMark.projectId);
    if (dropMark.after) target += 1;
    const anchorAfter = without[target];
    const anchorBefore = without[target - 1];
    const ids = ordered.map((project) => project.id).filter((id) => id !== dragId);
    const insertAt =
      anchorAfter !== undefined
        ? ids.indexOf(anchorAfter.id)
        : anchorBefore !== undefined
          ? ids.indexOf(anchorBefore.id) + 1
          : 0;
    move(dragId, insertAt);
    setDragId(null);
    setDropMark(null);
  };

  const projectBlock =
    shownProjects.length > 0 ? (
      <>
        <Divider />
        {shownProjects.map((project, index) => (
          <ProjectButton
            key={project.id}
            project={project}
            icon={state.icons[project.id]}
            isFocused={project.id === state.focusedProjectId}
            attention={attentionByProject.get(project.id) ?? null}
            index={index}
            count={shownProjects.length}
            position={state.position}
            dropMark={dragId !== null && dragId !== project.id ? dropMark : null}
            onActivate={(event) => {
              if (event.metaKey || event.ctrlKey) {
                markComposeIntent();
                navigate.toCompose({ projectId: project.id, focusPrompt: true });
                return;
              }
              const home = homeFor(project.id);
              if (project.id !== state.focusedProjectId) {
                setFocus(project.id);
                if (home !== null) activateHome(home);
                else if (!isHomeActive) actions.goHome();
                return;
              }
              // Already focused: first bring its home back, then show all.
              if (home !== null && activeItemId !== home) {
                activateHome(home);
                return;
              }
              setFocus(null);
              if (!isHomeActive) actions.goHome();
            }}
            homeItemId={homeFor(project.id)}
            panels={panels}
            onSetHome={(itemId) => {
              const homes = { ...state.homes };
              if (itemId === null) delete homes[project.id];
              else homes[project.id] = itemId;
              setLayout({ homes });
              if (itemId !== null && project.id === state.focusedProjectId) activateHome(itemId);
            }}
            onNewThread={() => {
              markComposeIntent();
              navigate.toCompose({ projectId: project.id, focusPrompt: true });
            }}
            onOpenPage={() => navigate.toProject(project.id)}
            onMove={(toIndex) => moveShown(project.id, toIndex)}
            onHide={() => {
              if (state.focusedProjectId === project.id) setFocus(null);
              setLayout({ hiddenProjectIds: [...state.hiddenProjectIds, project.id] });
            }}
            onTogglePosition={() =>
              setLayout({ position: state.position === "top" ? "bottom" : "top" })
            }
            onDragStartProject={() => setDragId(project.id)}
            onDragOverProject={(after) => {
              if (dropMark?.projectId !== project.id || dropMark.after !== after) {
                setDropMark({ projectId: project.id, after });
              }
            }}
            onDropProject={drop}
            onDragEndProject={() => {
              setDragId(null);
              setDropMark(null);
            }}
          />
        ))}
        <Divider />
      </>
    ) : null;

  return (
    <div data-testid="project-rail" className="flex min-h-0 flex-1 flex-col items-center pb-2">
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto py-0.5 [scrollbar-width:none]">
        <RailButton
          label="Home"
          active={isHomeActive && state.focusedProjectId === null}
          onClick={(event) => {
            const target = event.metaKey || event.ctrlKey ? "tab" : "current";
            // Home is the unfiltered view: drop any project focus first.
            if (target === "current") setFocus(null);
            actions.goHome({ target });
          }}
        >
          <Icon name="Home" aria-hidden="true" />
        </RailButton>
        {state.position === "top" ? projectBlock : null}
        {visible.map((item) => (
          <NavItemButton key={item.id} item={item} />
        ))}
        {state.position === "bottom" ? projectBlock : null}
        <MoreMenu
          homeStyle={state.homeStyle}
          onHomeStyle={(homeStyle) => setLayout({ homeStyle })}
          hidden={hidden}
          hiddenProjects={hiddenProjects}
          onShowProject={(projectId) =>
            setLayout({
              hiddenProjectIds: state.hiddenProjectIds.filter((id) => id !== projectId),
            })
          }
        />
      </div>
    </div>
  );
}

/**
 * Header: New thread, filed in the focused project when there is one, and in
 * Personal (no project) from Home instead of bb's last-used project.
 */
function RailHeader(_props: ExperimentalSidebarHeaderProps) {
  const { items, actions, isShortcutModifierHeld } = useSidebarNavigation();
  const { projects } = useSidebarThreads();
  const navigate = useBbNavigate();
  const { state } = useRailState();
  const split = useSidebarNavigationSplit(NEW_THREAD_ID);
  const item = items.find((candidate) => candidate.id === NEW_THREAD_ID);
  if (item === undefined) return null;
  const focused = projects.find((project) => project.id === state.focusedProjectId);
  const label = focused ? `New in ${focused.name}` : item.label;
  return (
    <button
      type="button"
      disabled={item.isDisabled}
      aria-keyshortcuts={item.shortcut?.ariaKeyShortcuts}
      aria-label={item.shortcut ? `${label} (${item.shortcut.label})` : label}
      className="flex h-(--bb-sidebar-control-size) min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 text-sm font-normal text-sidebar-foreground ring-sidebar-ring outline-none hover:bg-state-hover focus-visible:ring-2 disabled:cursor-default disabled:opacity-70 [&_[data-icon-root]]:size-4 [&_[data-icon-root]]:shrink-0"
      {...split.splitProps}
      onClick={(event) => {
        const target = event.metaKey || event.ctrlKey ? "split" : "current";
        markComposeIntent();
        if (target === "current") {
          const personal = projects.find((project) => project.isPersonal);
          navigate.toCompose({
            projectId: focused?.id ?? personal?.id ?? PERSONAL_PROJECT_ID,
            focusPrompt: true,
          });
        } else {
          actions.activate(item.id, { target });
        }
      }}
    >
      <NavIcon icon={item.icon} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {isShortcutModifierHeld && item.shortcut ? (
        <span className="ml-auto text-xs opacity-60">{item.shortcut.label}</span>
      ) : null}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_sidebarNavigation({
    id: "rail",
    title: "Project Rail",
    description: "bb's rail with an icon per project; click one to focus the thread list",
    placement: "rail",
    component: ProjectRail,
    headerComponent: RailHeader,
  });
});
