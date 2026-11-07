// The RPC methods of Annotate mode, merged into the plugin's contract in
// server.ts.
import { z } from "zod";
import {
  deviceSchema,
  noteIdSchema,
  noteSchema,
  snapshotSchema,
  udidSchema,
} from "./shared";

const threadId = z.string().min(1).max(200);
/** A JPEG of up to 4 MB, base64-encoded. */
const MAX_IMAGE_BASE64 = Math.ceil((4 * 1024 * 1024 * 4) / 3);

export const annotateMethods = {
  /** The booted simulators, and why there are none when listing fails. */
  annotateListSimulators: {
    input: z.null(),
    output: z.object({
      devices: z.array(deviceSchema),
      error: z.string().nullable(),
    }),
  },
  /** A screenshot of a simulator and its accessibility tree. */
  annotateSnapshot: {
    input: z.object({ udid: udidSchema }),
    output: snapshotSchema,
  },
  /** Stores a new note or a note's new comment. */
  annotateSaveNote: {
    input: z.object({ threadId, note: noteSchema }),
    output: z.null(),
  },
  /** The thread's stored notes among `ids`, for pills from an earlier window. */
  annotateGetNotes: {
    input: z.object({ threadId, ids: z.array(noteIdSchema).max(200) }),
    output: z.array(noteSchema),
  },
  /** Stores the screenshot the agent gets with a note. */
  annotateSaveNoteImage: {
    input: z.object({
      threadId,
      id: noteIdSchema,
      base64: z.string().max(MAX_IMAGE_BASE64),
    }),
    output: z.null(),
  },
};
