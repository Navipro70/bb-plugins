// Annotate mode of the Simulator panel: a snapshot of the simulator's screen
// over the live stream, a picker for its elements, and note pills in the
// thread's composer.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import "./annotate.css";
import type { rpcContract } from "../server";
import {
  PROVIDER,
  climb,
  describeNode,
  hitTest,
  noteIds,
  pillLabel,
  withoutNote,
  type Device,
  type Note,
  type Snapshot,
  type UiNode,
} from "./shared";

const warn = (error: unknown) => console.warn("[serve-sim annotate]", error);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const LAST_DEVICE = "serve-sim:annotate-udid";

const newId = () =>
  `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** The screenshot with the element outlined and pinned, as a base64 JPEG. */
async function markedShot(snapshot: Snapshot, note: Note): Promise<string | null> {
  const image = new Image();
  image.src = `data:image/jpeg;base64,${snapshot.image.base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const scale = image.naturalWidth / note.element.screen.width;
  const { x, y, width, height } = note.element.frame;
  context.lineWidth = Math.max(2, 2 * scale);
  context.strokeStyle = "#007aff";
  context.fillStyle = "rgba(0, 122, 255, 0.12)";
  context.beginPath();
  context.roundRect(x * scale, y * scale, width * scale, height * scale, 3 * scale);
  context.fill();
  context.stroke();
  const radius = 10 * scale;
  const cx = Math.max(radius, x * scale);
  const cy = Math.max(radius, y * scale);
  context.fillStyle = "#007aff";
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#fff";
  context.font = `600 ${11 * scale}px -apple-system, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(note.number), cx, cy + 0.5 * scale);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? null;
}

export function AnnotateIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20 14.5a2 2 0 0 1-2 2H8.5L4 20V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
      <path d="M8.5 8.5h7M8.5 12h4.5" />
    </svg>
  );
}

/** The size of an element's content box, kept current. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

type Editing =
  | { kind: "new"; path: UiNode[] }
  | { kind: "edit"; id: string };

/** The note editor beside its element, in stage pixels. */
function Editor({
  title,
  initial,
  anchor,
  stage,
  onSave,
  onCancel,
  onDelete,
}: {
  title: string;
  initial: string;
  anchor: { x: number; y: number; width: number; height: number };
  stage: { width: number; height: number };
  onSave(comment: string): void;
  onCancel(): void;
  onDelete?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const width = Math.min(280, Math.max(160, stage.width - 16));
  const height = 140;
  const below = anchor.y + anchor.height + 8;
  const top =
    below + height <= stage.height ? below : Math.max(8, anchor.y - height - 8);
  const left = Math.min(Math.max(8, anchor.x), Math.max(8, stage.width - width - 8));
  const save = () => {
    const comment = value.trim();
    if (comment) onSave(comment);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      save();
    }
  };
  return (
    <form
      className="sa-editor"
      style={{ left, top, width }}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <p className="sa-editor-title">{title}</p>
      <textarea
        ref={input}
        value={value}
        maxLength={4000}
        placeholder="A note for the agent"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="sa-editor-row">
        {onDelete && (
          <button type="button" className="sa-delete" onClick={onDelete}>
            Delete
          </button>
        )}
        <span />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="sa-save" disabled={!value.trim()}>
          {onDelete ? "Save" : "Add"}
        </button>
      </div>
    </form>
  );
}

/**
 * Annotate mode: it takes a fresh snapshot and turns on the picker; the
 * element under the pointer gets a blue box, ↑ selects its parent, and a
 * click opens a note. A note puts a pill in the thread's composer and a
 * numbered pin on the snapshot, and the panel goes back to the live stream.
 * `device` is the name or UDID serve-sim streams, when it was given one.
 * With `frame`, the panel's rectangle of the live screen, Annotate draws
 * the snapshot exactly over it and adds no toolbar of its own.
 */
export function AnnotateView({
  threadId,
  device: streamed,
  frame,
  onExit,
}: {
  threadId: string;
  device: string | null;
  frame?: { x: number; y: number; width: number; height: number } | null;
  onExit(): void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [udid, setUdid] = useState<string | null>(() =>
    localStorage.getItem(LAST_DEVICE),
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState<UiNode[]>([]);
  const [levels, setLevels] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notes, setNotes] = useState<ReadonlyMap<string, Note>>(new Map());
  // Notes whose pills are not in the draft yet.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [stageRef, stage] = useSize<HTMLDivElement>();
  const ids = noteIds(composer.draft);
  const idsKey = ids.join(" ");
  const remember = (note: Note) =>
    setNotes((current) => new Map(current).set(note.id, note));
  const forget = (id: string) =>
    setPending((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  const latest = useRef({ snapshot });
  latest.current = { snapshot };
  // Notes deleted from their pin before their pill landed. A ref, not state:
  // the view closes right after a note is added, before it renders again.
  const dropped = useRef(new Set<string>());

  /** The chosen simulator, else the one serve-sim streams, else the first booted one. */
  const isStreamed = (item: Device) => streamed !== null && (item.udid === streamed || item.name === streamed);
  // Over the live screen, the streamed device wins; otherwise the user's pick.
  const pick = (list: Device[]) =>
    (frame ? list.find(isStreamed) : undefined) ??
    list.find((item) => item.udid === udid) ??
    list.find(isStreamed) ??
    list[0];
  const device = devices ? (pick(devices) ?? null) : null;

  const loadDevices = useCallback(async () => {
    const result = await rpc.call("annotateListSimulators", null);
    setDevices(result.devices);
    if (result.error) setError(result.error);
    return result.devices;
  }, [rpc]);

  const refresh = useCallback(async (): Promise<Snapshot | null> => {
    setLoading(true);
    try {
      const list = await loadDevices();
      const target = pick(list);
      if (!target) {
        setSnapshot(null);
        setError("No booted simulator. Run your Expo app with `npx expo run:ios` or `npx expo start --ios`.");
        return null;
      }
      const next = await rpc.call("annotateSnapshot", { udid: target.udid });
      setSnapshot(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(message(cause));
      return null;
    } finally {
      setLoading(false);
    }
  }, [rpc, udid, streamed, loadDevices]);

  const stop = useCallback(() => {
    setPicking(false);
    setHover([]);
    setLevels(0);
  }, []);
  const start = useCallback(async () => {
    setEditing(null);
    const next = await refresh();
    if (next?.tree) setPicking(true);
  }, [refresh]);
  const toggle = useCallback(() => {
    if (picking) stop();
    else void start();
  }, [picking, start, stop]);

  // Annotate mode starts with a pick on a fresh snapshot, also on another device.
  useEffect(() => {
    if (!editing) void start();
  }, [udid]);

  // Pills from before this panel mounted, such as after a reload.
  useEffect(() => {
    const missing = ids.filter((id) => !notes.has(id));
    if (!missing.length) return;
    let live = true;
    rpc
      .call("annotateGetNotes", { threadId, ids: missing })
      .then((found) => {
        if (live) found.forEach(remember);
      })
      .catch(warn);
    return () => {
      live = false;
    };
  }, [idsKey, threadId]);

  useEffect(() => composer.onSubmitted(onExit), [composer, onExit]);

  // Escape goes back to live, and ↑ ↓ move the pick, wherever the focus is.
  // The note editor handles its own keys.
  useEffect(() => {
    if (editing) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const editable =
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key === "Escape") onExit();
      else if (picking && event.key === "ArrowUp" && !editable) setLevels((level) => level + 1);
      else if (picking && event.key === "ArrowDown" && !editable)
        setLevels((level) => Math.max(0, level - 1));
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [editing, picking, onExit]);

  const drafted = [...new Set([...ids, ...pending])].flatMap(
    (id) => notes.get(id) ?? [],
  );
  const next = Math.max(0, ...drafted.map((note) => note.number)) + 1;

  // Points on the device → pixels on the stage.
  const screen = snapshot?.screen ?? (snapshot && { width: snapshot.image.width, height: snapshot.image.height });
  const scale = !screen
    ? 0
    : frame
      ? frame.width / screen.width
      : Math.min(stage.width / screen.width, stage.height / screen.height) || 0;
  const shown = screen && { width: screen.width * scale, height: screen.height * scale };
  const toStage = (box: { x: number; y: number; width: number; height: number }) => ({
    x: box.x * scale,
    y: box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  });

  const pointAt = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  };
  const onMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!picking || !snapshot?.tree || !scale) return;
    const { x, y } = pointAt(event);
    const path = hitTest(snapshot.tree, x, y);
    const last = path[path.length - 1];
    if (last !== hover[hover.length - 1]) {
      setHover(path);
      setLevels(0);
    }
  };
  const selected = climb(hover, levels);
  const target = selected[selected.length - 1];

  const onPick = (event: ReactPointerEvent<HTMLElement>) => {
    if (!picking || !target) return;
    event.preventDefault();
    setEditing({ kind: "new", path: selected });
    stop();
  };

  const add = (path: UiNode[], comment: string) => {
    const shot = latest.current.snapshot;
    const element = path[path.length - 1];
    if (!shot?.screen || !element) return;
    const note: Note = {
      id: newId(),
      number: next,
      comment,
      device: shot.device,
      app: shot.app,
      element: {
        type: element.type,
        label: element.label,
        identifier: element.identifier,
        value: element.value,
        frame: element.frame,
        ancestors: path.slice(0, -1).map(describeNode).slice(-20),
        screen: shot.screen,
      },
    };
    remember(note);
    setPending((current) => new Set(current).add(note.id));
    setEditing(null);
    // Back to the live stream; the pill still lands after the screenshot.
    onExit();
    void (async () => {
      await rpc.call("annotateSaveNote", { threadId, note });
      // The screenshot comes before the pill, so a message sent at once has
      // it too; a slow one gives up after 5 seconds.
      const image = (async () => {
        const base64 = await markedShot(shot, note);
        if (base64) await rpc.call("annotateSaveNoteImage", { threadId, id: note.id, base64 });
      })().catch(warn);
      await Promise.race([image, new Promise((resolve) => setTimeout(resolve, 5000))]);
      // A note deleted from its pin in the meantime gets no pill.
      if (!dropped.current.has(note.id))
        composer.insert([{ provider: PROVIDER, id: note.id, label: pillLabel(note) }, " "], {
          at: "end",
        });
    })()
      .catch((cause) => setError(message(cause)))
      .finally(() => forget(note.id));
  };

  const edit = (id: string, comment: string) => {
    const note = notes.get(id);
    setEditing(null);
    if (!note) return;
    const edited = { ...note, comment };
    remember(edited);
    rpc.call("annotateSaveNote", { threadId, note: edited }).catch(warn);
  };

  const remove = (id: string) => {
    dropped.current.add(id);
    setEditing(null);
    forget(id);
    composer.replace((draft) => withoutNote(draft, id));
  };

  const pins = snapshot ? drafted.filter((note) => note.device.udid === snapshot.device.udid) : [];
  const editNote = editing?.kind === "edit" ? notes.get(editing.id) : undefined;
  const editTarget =
    editing?.kind === "new" ? editing.path[editing.path.length - 1]?.frame : editNote?.element.frame;

  const screenView = snapshot && shown ? (
          <div
            className={picking ? "sa-screen sa-picking" : "sa-screen"}
            style={{ width: shown.width, height: shown.height }}
            onPointerMove={onMove}
            onPointerLeave={() => picking && setHover([])}
            onPointerDown={onPick}
          >
            <img
              src={`data:image/jpeg;base64,${snapshot.image.base64}`}
              alt={`Screen of ${snapshot.device.name}`}
              draggable={false}
            />
            {pins.map((note) => {
              const box = toStage(note.element.frame);
              return (
                <div key={note.id}>
                  <div className="sa-outline" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
                  <button
                    type="button"
                    className="sa-pin"
                    style={{ left: Math.max(0, box.x - 9), top: Math.max(0, box.y - 9) }}
                    title={note.comment}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      stop();
                      setEditing({ kind: "edit", id: note.id });
                    }}
                  >
                    {note.number}
                  </button>
                </div>
              );
            })}
            {picking && target && (() => {
              const box = toStage(target.frame);
              const tipAbove = box.y >= 24;
              return (
                <>
                  <div className="sa-box" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
                  <div
                    className="sa-tip"
                    style={{
                      left: Math.min(box.x, Math.max(0, shown.width - 220)),
                      top: tipAbove ? box.y - 22 : box.y + box.height + 4,
                    }}
                  >
                    {describeNode(target)}
                    {target.identifier && <b> #{target.identifier}</b>} {Math.round(target.frame.width)}×
                    {Math.round(target.frame.height)}
                  </div>
                </>
              );
            })()}
            {editing && editTarget && (
              <>
                {editing.kind === "new" && (
                  <div className="sa-box" style={(() => { const b = toStage(editTarget); return { left: b.x, top: b.y, width: b.width, height: b.height }; })()} />
                )}
                <Editor
                  key={editing.kind === "edit" ? editing.id : "new"}
                  title={
                    editing.kind === "new"
                      ? `${next} · ${describeNode(editing.path[editing.path.length - 1]!)}`
                      : `${editNote!.number} · ${describeNode(editNote!.element)}`
                  }
                  initial={editNote?.comment ?? ""}
                  anchor={toStage(editTarget)}
                  stage={shown}
                  onCancel={() => setEditing(null)}
                  onSave={(comment) =>
                    editing.kind === "new" ? add(editing.path, comment) : edit(editing.id, comment)
                  }
                  onDelete={editing.kind === "edit" ? () => remove(editing.id) : undefined}
                />
              </>
            )}
          </div>
  ) : null;
  const notice = error ?? snapshot?.treeError ?? null;

  if (frame) {
    return (
      <div className="sa-panel sa-anchored">
        {screenView && (
          <div
            className="sa-anchor"
            style={{
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
              borderRadius: frame.width * 0.13,
            }}
          >
            {screenView}
          </div>
        )}
        <p className="sa-float" style={{ left: frame.x + frame.width / 2, top: frame.y + 6 }}>
          {notice ??
            (loading
              ? "Taking a snapshot…"
              : picking
                ? "Click an element · ↑ parent · Esc back to live"
                : "Click a pin to edit it · Esc back to live")}
        </p>
      </div>
    );
  }

  return (
    <div className="sa-panel">
      <div className="sa-toolbar">
        {devices && devices.length > 1 ? (
          <select
            className="sa-device"
            value={device?.udid ?? ""}
            onChange={(event) => {
              setUdid(event.target.value);
              localStorage.setItem(LAST_DEVICE, event.target.value);
            }}
            aria-label="Simulator"
          >
            {devices.map((item) => (
              <option key={item.udid} value={item.udid}>
                {item.name} · {item.runtime}
              </option>
            ))}
          </select>
        ) : (
          <span className="sa-device-name">
            {device ? `${device.name} · ${device.runtime}` : "No booted simulator"}
          </span>
        )}
        <span className="sa-spacer" />
        <button
          type="button"
          className="sa-icon-button"
          aria-label="Take a new snapshot"
          title="Take a new snapshot"
          disabled={loading || picking}
          onClick={() => void refresh()}
        >
          <Icon name="ArrowReloadHorizontal" className="size-3.5" />
        </button>
        <button
          type="button"
          className="sa-annotate"
          aria-pressed={picking}
          disabled={loading || (!picking && !device)}
          title={
            picking
              ? "Click an element to add a note. ↑ selects its parent; Esc cancels."
              : "Take a snapshot and pick an element"
          }
          onClick={toggle}
        >
          <AnnotateIcon />
          <span>{picking ? "Cancel" : loading ? "Snapshot…" : "Annotate"}</span>
        </button>
        <button
          type="button"
          className="sa-annotate"
          title="Back to the live simulator (Esc)"
          onClick={onExit}
        >
          <Icon name="Play" className="size-3.5" />
          <span>Live</span>
        </button>
      </div>
      {(error || snapshot?.treeError) && (
        <p className="sa-message">{error ?? snapshot?.treeError}</p>
      )}
      <div className="sa-stage" ref={stageRef}>
        {screenView}
        {!snapshot && !error && <p className="sa-empty">{loading ? "Taking a snapshot…" : ""}</p>}
      </div>
      <p className="sa-footer">
        {picking
          ? "Click an element · ↑ parent · Esc cancel"
          : snapshot
            ? `Snapshot ${new Date(snapshot.takenAt).toLocaleTimeString()}${snapshot.app ? ` · ${snapshot.app}` : ""}`
            : ""}
      </p>
    </div>
  );
}

