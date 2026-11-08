// Pure helpers for the tree: entry order and path handling.

export type EntryKind = "file" | "directory";

export interface DirEntry {
  name: string;
  kind: EntryKind;
  /** Matched by .gitignore (shown dimmed, like VS Code). */
  ignored: boolean;
}

/** Names VS Code hides by default (`files.exclude`). */
export const HIDDEN_NAMES = new Set([".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"]);

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Folders first, then natural, case-insensitive name order. */
export function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/**
 * Normalizes a workspace-relative directory: "" is the root. Returns null for
 * absolute paths and anything that climbs out of the root.
 */
export function normalizeRelativeDir(dir: string): string | null {
  if (dir.startsWith("/") || dir.includes("\\") || dir.includes("\0")) return null;
  const parts: string[] = [];
  for (const part of dir.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.join("/");
}

export interface VisibleRow {
  path: string;
  name: string;
  kind: EntryKind;
  ignored: boolean;
  depth: number;
}

/**
 * The rows the tree shows: every entry of the root and, depth first, of each
 * expanded folder whose children are loaded.
 */
export function visibleRows(
  children: ReadonlyMap<string, readonly DirEntry[]>,
  expanded: ReadonlySet<string>,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (dir: string, depth: number, parentIgnored: boolean) => {
    for (const entry of children.get(dir) ?? []) {
      const path = joinPath(dir, entry.name);
      const ignored = parentIgnored || entry.ignored;
      rows.push({ path, name: entry.name, kind: entry.kind, ignored, depth });
      if (entry.kind === "directory" && expanded.has(path)) {
        walk(path, depth + 1, ignored);
      }
    }
  };
  walk("", 0, false);
  return rows;
}

export function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}
