// The server side of Annotate mode: snapshots of the simulator, the notes'
// storage, and the mention provider that gives the agent each note.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PROVIDER, formatNote, noteSchema, type Note } from "./shared";
import { findIdb, listDevices, takeSnapshot } from "./simulator";

interface Row {
  thread_id: string;
  note: string;
  image_path: string | null;
}

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** Registers the storage and mention provider; returns the RPC handlers. */
export function registerAnnotate(bb: BbPluginApi, idbPath: string) {
  const idb = findIdb(idbPath);
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE notes (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, note TEXT NOT NULL, image_path TEXT)",
    "CREATE INDEX notes_thread ON notes(thread_id)",
  ]);
  // A note id belongs to the thread that stored it first.
  const upsert = db.prepare(
    `INSERT INTO notes (id, thread_id, note) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET note = excluded.note
      WHERE thread_id = excluded.thread_id`,
  );
  const select = db.prepare<[string], Row>(
    "SELECT thread_id, note, image_path FROM notes WHERE id = ?",
  );
  const setImage = db.prepare("UPDATE notes SET image_path = ? WHERE id = ?");
  const removeThread = db.prepare("DELETE FROM notes WHERE thread_id = ?");
  const parse = (row: Row): Note => noteSchema.parse(JSON.parse(row.note));
  const owned = (id: string, threadId: string) => {
    const row = select.get(id);
    return row?.thread_id === threadId ? row : undefined;
  };

  bb.ui.registerMentionProvider({
    id: PROVIDER,
    label: "Simulator notes",
    // Notes come from Annotate mode, never from the @ menu.
    search: () => [],
    resolve(id) {
      const row = select.get(id);
      if (!row)
        throw new Error(
          "A simulator note in this message no longer exists. Remove its pill and add the note again.",
        );
      const note = parse(row);
      return {
        context: formatNote(note),
        ...(row.image_path && {
          experimental_images: [
            {
              type: "localImage" as const,
              path: row.image_path,
              context: `Screenshot for simulator note ${note.number}: a blue outline and pin ${note.number} mark the element.`,
            },
          ],
        }),
      };
    },
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    removeThread.run(thread.id);
  });

  return {
    async annotateListSimulators() {
      try {
        return { devices: await listDevices(), error: null };
      } catch (error) {
        return {
          devices: [],
          error: `Could not list simulators: ${firstLine(error)}`,
        };
      }
    },
    async annotateSnapshot({ udid }: { udid: string }) {
      const device = (await listDevices()).find((item) => item.udid === udid);
      if (!device) throw new Error("This simulator is no longer booted.");
      return takeSnapshot(device, await idb);
    },
    annotateSaveNote({ threadId, note }: { threadId: string; note: Note }) {
      upsert.run(note.id, threadId, JSON.stringify(note));
      return null;
    },
    annotateGetNotes({ threadId, ids }: { threadId: string; ids: string[] }) {
      return ids.flatMap((id) => {
        const row = owned(id, threadId);
        return row ? [parse(row)] : [];
      });
    },
    async annotateSaveNoteImage({
      threadId,
      id,
      base64,
    }: {
      threadId: string;
      id: string;
      base64: string;
    }) {
      if (!owned(id, threadId)) throw new Error("This note no longer exists.");
      const bytes = Buffer.from(base64, "base64");
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
        throw new Error("The screenshot must be a JPEG.");
      const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({
        threadId,
      });
      const path = `${storageRootPath}/serve-sim-notes/${id}.jpg`;
      await bb.sdk.files.write({
        hostId,
        rootPath: storageRootPath,
        path,
        content: base64,
        contentEncoding: "base64",
        createParents: true,
      });
      setImage.run(path, id);
      return null;
    },
  };
}
