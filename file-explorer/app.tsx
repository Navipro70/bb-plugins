// File Explorer frontend: a "Files" action in the thread side panel that shows
// the thread's workspace as a VS Code / Cursor style tree, with Seti file
// icons and git colors. Clicking a file previews it beside the tree (or opens
// it as a bb file tab when the panel is narrow).
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  definePluginApp,
  experimental_FilePreview as FilePreview,
  experimental_SourceCode as SourceCode,
  experimental_usePluginId,
  Markdown,
  useBbNavigate,
  useComposer,
  useRpc,
  type ExperimentalFilePreviewFile,
  type ExperimentalLiveFileTarget,
  type ExperimentalThreadActionTabProps,
  type PluginNewThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { newThreadRoot, rootKey, type Root, type SelectedEnvironment } from "@/lib/roots";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { SETI_FONT_BASE64 } from "@/lib/seti-font";
import { setiIcon } from "@/lib/seti";
import {
  buildDecorations,
  STATE_LETTER,
  type GitDecorations,
  type GitFileState,
  type GitState,
} from "@/lib/git-status";
import { parentDir, visibleRows, type DirEntry, type VisibleRow } from "@/lib/tree";

const SETI_FAMILY = "bb-file-explorer-seti";
const ROW_HEIGHT = 22;
const INDENT = 8;
const STATUS_POLL_MS = 3000;
const INLINE_PREVIEW_MIN_WIDTH = 560;

type Mode = "dark" | "light";

// Cursor Dark's git decoration colors; light mode uses VS Code Light's.
const GIT_COLORS: Record<Mode, Record<GitState, string>> = {
  dark: {
    modified: "#F1B467",
    added: "#70B489",
    deleted: "#FC6B83",
    renamed: "#70B489",
    untracked: "#88C0D0",
    conflict: "#FC6B83",
  },
  light: {
    modified: "#895503",
    added: "#587C0C",
    deleted: "#AD0707",
    renamed: "#007100",
    untracked: "#007100",
    conflict: "#AD0707",
  },
};

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** bb's light/dark mode, following live changes of the `dark` class. */
function useMode(): Mode {
  const read = (): Mode =>
    document.documentElement.classList.contains("dark") ? "dark" : "light";
  const [mode, setMode] = useState<Mode>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return mode;
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

interface SavedState {
  expanded: string[];
  selected: string | null;
  treeWidth: number;
}

function loadSaved(key: string): SavedState {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      const value = JSON.parse(raw) as Partial<SavedState>;
      return {
        expanded: Array.isArray(value.expanded)
          ? value.expanded.filter((item): item is string => typeof item === "string")
          : [],
        selected: typeof value.selected === "string" ? value.selected : null,
        treeWidth:
          typeof value.treeWidth === "number" && Number.isFinite(value.treeWidth)
            ? value.treeWidth
            : 260,
      };
    }
  } catch {
    // A corrupt entry starts fresh.
  }
  return { expanded: [], selected: null, treeWidth: 260 };
}

/** One folder's loaded children, keyed by workspace-relative folder ("" = root). */
type ChildrenState = Map<string, DirEntry[]>;

interface WorkspaceInfo {
  name: string;
  branch: string | null;
  hostId: string;
  path: string;
}

function useWorkspaceTree(root: Root, storageKey: string) {
  const rpc = useRpc<typeof rpcContract>();
  const saved = useRef(loadSaved(storageKey)).current;
  const [children, setChildren] = useState<ChildrenState>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set(saved.expanded));
  const [selected, setSelected] = useState<string | null>(saved.selected);
  const [treeWidth, setTreeWidth] = useState(saved.treeWidth);
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitDecorations>(() => buildDecorations([]));
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useEffect(() => {
    const value: SavedState = { expanded: [...expanded], selected, treeWidth };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the tree still works for this session.
    }
  }, [storageKey, expanded, selected, treeWidth]);

  const loadDir = useCallback(
    async (dir: string) => {
      setLoading((current) => new Set(current).add(dir));
      try {
        const result = await rpc.call("list_dir", { root, dir });
        setChildren((current) => new Map(current).set(dir, result.entries));
        setError(null);
      } catch (cause) {
        if (dir === "") setError(errorText(cause));
        else {
          // A folder that vanished collapses quietly.
          setExpanded((current) => {
            const next = new Set(current);
            next.delete(dir);
            return next;
          });
        }
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(dir);
          return next;
        });
      }
    },
    [rpc, root],
  );

  /** Reloads the root and every expanded folder whose parents are open. */
  const refreshAll = useCallback(async () => {
    const dirs = [""];
    for (const dir of expandedRef.current) dirs.push(dir);
    await Promise.all(dirs.map((dir) => loadDir(dir)));
  }, [loadDir]);

  useEffect(() => {
    rpc.call("workspace", { root }).then(
      (result) => setWorkspace(result),
      (cause: unknown) => setError(errorText(cause)),
    );
    void refreshAll();
    // Only on mount: Explorer remounts when the root changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Git status poll; a change in the set of changed files also reloads the
  // open folders so new and deleted files appear.
  const statusSignature = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const result = await rpc.call("git_status", { root });
          if (cancelled) return;
          const files: GitFileState[] = result.files;
          const signature = files.map((file) => `${file.state}:${file.path}`).join("\n");
          if (signature !== statusSignature.current) {
            const first = statusSignature.current === null;
            statusSignature.current = signature;
            setGit(buildDecorations(files));
            if (!first) void refreshAll();
          }
        } catch {
          // Status is decoration only; the tree keeps working without it.
        }
      }
      if (!cancelled) timer = setTimeout(poll, STATUS_POLL_MS);
    };
    void poll();
    const onFocus = () => void refreshAll();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [rpc, root, refreshAll]);

  const toggle = useCallback(
    (path: string, open?: boolean) => {
      const willOpen = open ?? !expandedRef.current.has(path);
      setExpanded((current) => {
        const next = new Set(current);
        if (willOpen) next.add(path);
        else next.delete(path);
        return next;
      });
      if (willOpen && !childrenRef.current.has(path)) void loadDir(path);
    },
    [loadDir],
  );

  // Load children of folders restored as expanded.
  useEffect(() => {
    for (const dir of expanded) {
      if (!children.has(dir) && !loading.has(dir) && children.has(parentDir(dir))) {
        void loadDir(dir);
      }
    }
  }, [children, expanded, loading, loadDir]);

  return {
    children,
    expanded,
    selected,
    setSelected,
    treeWidth,
    setTreeWidth,
    loading,
    error,
    git,
    workspace,
    toggle,
    collapseAll: () => setExpanded(new Set()),
    refreshAll,
  };
}

function SetiGlyph({ name, mode }: { name: string; mode: Mode }) {
  const icon = setiIcon(name, mode);
  return (
    <span
      aria-hidden
      className="fe-seti inline-flex w-4 shrink-0 items-center justify-center"
      style={{
        fontFamily: SETI_FAMILY,
        fontSize: 20,
        lineHeight: 1,
        color: icon.color ?? "inherit",
      }}
    >
      {icon.glyph}
    </span>
  );
}

function TreeRow({
  row,
  isExpanded,
  isSelected,
  isFocused,
  state,
  mode,
  onClick,
  onDoubleClick,
}: {
  row: VisibleRow;
  isExpanded: boolean;
  isSelected: boolean;
  isFocused: boolean;
  state: GitState | undefined;
  mode: Mode;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const color = state !== undefined ? GIT_COLORS[mode][state] : undefined;
  const style: CSSProperties = {
    height: ROW_HEIGHT,
    paddingLeft: 8 + row.depth * INDENT * 2,
    color: color ?? (row.ignored ? undefined : "var(--foreground)"),
  };
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.kind === "directory" ? isExpanded : undefined}
      aria-selected={isSelected}
      data-path={row.path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "fe-row relative flex cursor-pointer select-none items-center gap-1.5 pr-2 text-[13px]",
        row.ignored && state === undefined && "text-muted-foreground opacity-70",
        isSelected ? "bg-[var(--state-active)]" : "hover:bg-[var(--state-hover)]",
        isFocused && "outline outline-1 -outline-offset-1 outline-[var(--ring)]",
      )}
      style={style}
    >
      {Array.from({ length: row.depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="fe-guide pointer-events-none absolute top-0 h-full w-px bg-[var(--border-hairline)]"
          style={{ left: 8 + level * INDENT * 2 + 7 }}
        />
      ))}
      {row.kind === "directory" ? (
        <Icon
          name="ChevronRight"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
        />
      ) : (
        <SetiGlyph name={row.name} mode={mode} />
      )}
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
      {state === undefined ? null : row.kind === "directory" ? (
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />
      ) : (
        <span className="shrink-0 text-[11px] font-medium" style={{ color }}>
          {STATE_LETTER[state]}
        </span>
      )}
    </div>
  );
}

function HeaderButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-[var(--state-hover)] hover:text-foreground"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

function FilesTab({ threadId, environment }: ExperimentalThreadActionTabProps) {
  if (environment === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        This thread has no workspace to show.
      </div>
    );
  }
  const root: Root = { kind: "environment", environmentId: environment.id };
  return <Explorer key={rootKey(root)} root={root} threadId={threadId} note={null} />;
}

function NewThreadFilesTab({ projectId }: PluginNewThreadPanelProps) {
  const composer = useComposer();
  const selectedProject = composer.selection?.projectId ?? projectId;
  const resolved = newThreadRoot(
    selectedProject ?? null,
    composer.selection?.environment as SelectedEnvironment | undefined,
  );
  if (resolved === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Pick a project to see its files.
      </div>
    );
  }
  return (
    <Explorer
      key={rootKey(resolved.root)}
      root={resolved.root}
      threadId={null}
      note={resolved.note}
    />
  );
}

function Explorer({
  root,
  threadId,
  note,
}: {
  root: Root;
  threadId: string | null;
  note: string | null;
}) {
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const mode = useMode();
  const key = rootKey(root);
  const tree = useWorkspaceTree(root, `${pluginId}:tree:${key}`);
  const workspace = tree.workspace;
  const fileTarget = (path: string): ExperimentalLiveFileTarget | null => {
    if (root.kind === "environment") {
      return { kind: "workspace", environmentId: root.environmentId, path };
    }
    if (workspace === null) return null;
    return { kind: "host", hostId: workspace.hostId, path: `${workspace.path}/${path}` };
  };
  const { ref: frameRef, width } = useElementWidth<HTMLDivElement>();
  const [focused, setFocused] = useState<string | null>(null);
  const rows = visibleRows(tree.children, tree.expanded);
  const inlinePreview = width >= INLINE_PREVIEW_MIN_WIDTH;
  const previewPath =
    inlinePreview && tree.selected !== null && rows.some((row) => row.path === tree.selected)
      ? tree.selected
      : null;

  const openInTab = (path: string) => {
    const target = fileTarget(path);
    if (target !== null) navigate.experimental_openFilePreview({ target, location: null });
  };

  const activate = (row: VisibleRow) => {
    setFocused(row.path);
    if (row.kind === "directory") {
      tree.toggle(row.path);
      return;
    }
    tree.setSelected(row.path);
    if (!inlinePreview) openInTab(row.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const index = Math.max(
      0,
      rows.findIndex((row) => row.path === (focused ?? tree.selected)),
    );
    const row = rows[index];
    if (row === undefined) return;
    const focus = (next: VisibleRow | undefined) => {
      if (next === undefined) return;
      setFocused(next.path);
      document
        .querySelector(`[data-fe-tree="${CSS.escape(key)}"] [data-path="${CSS.escape(next.path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    switch (event.key) {
      case "ArrowDown":
        focus(rows[Math.min(rows.length - 1, index + 1)]);
        break;
      case "ArrowUp":
        focus(rows[Math.max(0, index - 1)]);
        break;
      case "ArrowRight":
        if (row.kind === "directory") {
          if (!tree.expanded.has(row.path)) tree.toggle(row.path, true);
          else focus(rows[index + 1]);
        }
        break;
      case "ArrowLeft":
        if (row.kind === "directory" && tree.expanded.has(row.path)) {
          tree.toggle(row.path, false);
        } else {
          const parent = parentDir(row.path);
          focus(rows.find((candidate) => candidate.path === parent));
        }
        break;
      case "Enter":
      case " ":
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = tree.treeWidth;
    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(Math.max(160, startWidth + moveEvent.clientX - startX), width - 240);
      tree.setTreeWidth(Math.round(next));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const previewTarget = previewPath === null ? null : fileTarget(previewPath);

  const treeColumn = (
    <div
      className="flex min-h-0 min-w-0 flex-col"
      style={previewTarget === null ? { flex: 1 } : { width: tree.treeWidth, flexShrink: 0 }}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <span
          className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          title={tree.workspace?.branch ? `Branch ${tree.workspace.branch}` : undefined}
        >
          {tree.workspace?.name ?? "Files"}
          {tree.workspace?.branch ? (
            <span className="ml-1.5 font-normal normal-case tracking-normal">
              {tree.workspace.branch}
            </span>
          ) : null}
        </span>
        {previewPath === null ? null : (
          <>
            <HeaderButton
              icon="ExternalLink"
              label="Open the previewed file as a panel tab"
              onClick={() => openInTab(previewPath)}
            />
            <HeaderButton icon="X" label="Close preview" onClick={() => tree.setSelected(null)} />
          </>
        )}
        <HeaderButton icon="ArrowReloadHorizontal" label="Refresh" onClick={() => void tree.refreshAll()} />
        <HeaderButton icon="FolderMinus" label="Collapse folders" onClick={tree.collapseAll} />
      </div>
      {note === null ? null : (
        <p className="shrink-0 px-3 pb-1 text-[11px] text-muted-foreground">{note}</p>
      )}
      <div
        role="tree"
        tabIndex={0}
        data-fe-tree={key}
        aria-label="Workspace files"
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto pb-4 outline-none"
      >
        {tree.error !== null ? (
          <p role="alert" className="px-3 py-2 text-sm text-destructive-text">
            {tree.error}
          </p>
        ) : !tree.children.has("") ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>
        ) : (
          rows.map((row) => (
            <TreeRow
              key={row.path}
              row={row}
              mode={mode}
              isExpanded={tree.expanded.has(row.path)}
              isSelected={tree.selected === row.path}
              isFocused={focused === row.path}
              state={
                row.kind === "directory" ? tree.git.folders.get(row.path) : tree.git.files.get(row.path)
              }
              onClick={() => activate(row)}
              onDoubleClick={() => {
                if (row.kind === "file") openInTab(row.path);
              }}
            />
          ))
        )}
      </div>
    </div>
  );

  return (
    <div ref={frameRef} className="flex h-full min-h-0 w-full">
      {treeColumn}
      {previewTarget === null ? null : (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            onPointerDown={startResize}
            className="w-1 shrink-0 cursor-col-resize border-l border-[var(--border-seam)] hover:bg-[var(--state-hover)]"
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <FilePreview
              key={previewPath}
              target={previewTarget}
              renderPreview={(file) => (
                <PreviewBody
                  threadId={threadId}
                  target={previewTarget}
                  path={previewPath ?? ""}
                  file={file}
                />
              )}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** The Preview-mode body bb asks plugins to draw for Markdown, HTML and CSV. */
function PreviewBody({
  threadId,
  target,
  path,
  file,
}: {
  threadId: string | null;
  target: ExperimentalLiveFileTarget;
  path: string;
  file: ExperimentalFilePreviewFile;
}) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx")) {
    return (
      <div className="h-full overflow-auto px-5 py-4">
        <Markdown
          content={file.content}
          experimental_document={
            threadId !== null && target.kind === "workspace"
              ? { threadId, rootPath: parentDir(path), target }
              : undefined
          }
        />
      </div>
    );
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return (
      <iframe
        title={path}
        src={file.url}
        sandbox="allow-scripts"
        className="size-full border-0 bg-white"
      />
    );
  }
  return <SourceCode content={file.content} path={path} className="h-full" />;
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export default definePluginApp((app) => {
  // The Seti icon font, added from memory so no font URL or CSP rule is
  // needed, and removed again when the plugin unloads.
  app.contentScripts.register({
    id: "seti-font",
    mount: () => {
      const face = new FontFace(SETI_FAMILY, base64ToBytes(SETI_FONT_BASE64));
      document.fonts.add(face);
      void face.load().catch(() => {});
      return () => {
        document.fonts.delete(face);
      };
    },
  });

  // The same tree on the New thread screen, for the project folder or the
  // environment its composer has selected.
  app.slots.experimental_newThreadPanelAction({
    id: "files",
    title: "Files",
    icon: "FolderOpen",
    layout: "flush",
    component: NewThreadFilesTab,
  });

  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "files",
    title: "Files",
    tooltip: "Browse the workspace's files",
    icon: "FolderOpen",
    layout: "flush",
    component: FilesTab,
  });
});
