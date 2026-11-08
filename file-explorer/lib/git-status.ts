// Pure helpers for git decorations: parsing `git status --porcelain=v1 -z`
// and rolling file states up to their folders, as VS Code's Explorer does.

export type GitState =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileState {
  path: string;
  state: GitState;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function stateOf(code: string): GitState | null {
  if (CONFLICT_CODES.has(code)) return "conflict";
  if (code === "??") return "untracked";
  if (code === "!!") return null;
  const [index = " ", worktree = " "] = code;
  // The working tree wins: a staged add that was edited again is still new.
  if (index === "A") return "added";
  if (index === "R" || index === "C") return "renamed";
  if (worktree === "D" || index === "D") return "deleted";
  if (worktree === "M" || index === "M" || worktree === "T" || index === "T") {
    return "modified";
  }
  return null;
}

/** Parses NUL-separated `git status --porcelain=v1 -z` output. */
export function parsePorcelainZ(output: string): GitFileState[] {
  const files: GitFileState[] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    // Renames and copies carry the original path in the next record.
    if (code[0] === "R" || code[0] === "C") index += 1;
    const state = stateOf(code);
    if (state !== null && path !== "") {
      files.push({ path: path.replace(/\/$/, ""), state });
    }
  }
  return files;
}

/** Folder colors take the most important state among their files. */
const PRIORITY: Record<GitState, number> = {
  conflict: 6,
  modified: 5,
  deleted: 4,
  added: 3,
  renamed: 2,
  untracked: 1,
};

export interface GitDecorations {
  files: Map<string, GitState>;
  folders: Map<string, GitState>;
}

export function buildDecorations(files: readonly GitFileState[]): GitDecorations {
  const fileMap = new Map<string, GitState>();
  const folderMap = new Map<string, GitState>();
  for (const { path, state } of files) {
    fileMap.set(path, state);
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join("/");
      const current = folderMap.get(folder);
      if (current === undefined || PRIORITY[state] > PRIORITY[current]) {
        folderMap.set(folder, state);
      }
    }
  }
  return { files: fileMap, folders: folderMap };
}

/** The letter VS Code shows at the end of a decorated file row. */
export const STATE_LETTER: Record<GitState, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "!",
};
