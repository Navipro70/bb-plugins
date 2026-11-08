import { describe, expect, it } from "vitest";
import { buildDecorations, parsePorcelainZ } from "../git-status";
import { extensionCandidates, languageOf, setiIcon } from "../seti";
import { compareEntries, normalizeRelativeDir, visibleRows, type DirEntry } from "../tree";
import theme from "../seti-theme.json";

const icons = theme.icons as unknown as Record<string, [string, string | null]>;
const glyphOf = (id: string) => icons[id]?.[0];

describe("seti", () => {
  it("builds dotted suffixes like VS Code", () => {
    expect(extensionCandidates("eslint.config.js")).toEqual(["config.js", "js"]);
    expect(extensionCandidates(".nvmrc")).toEqual(["nvmrc"]);
    expect(extensionCandidates(".env.example")).toEqual(["env.example", "example"]);
    expect(extensionCandidates("Makefile")).toEqual([]);
  });

  it("maps names and extensions to languages", () => {
    expect(languageOf("App.tsx")).toBe("typescriptreact");
    expect(languageOf(".env")).toBe("dotenv");
    expect(languageOf(".gitignore")).toBe("ignore");
    expect(languageOf(".env.example")).toBeNull();
  });

  it("picks the icons the Explorer shows", () => {
    expect(setiIcon("app.config.ts", "dark").glyph).toBe(glyphOf(theme.languageIds.typescript));
    expect(setiIcon("CLAUDE.md", "dark").glyph).toBe(glyphOf(theme.languageIds.markdown));
    expect(setiIcon(".env", "dark").glyph).toBe(glyphOf(theme.languageIds.dotenv));
    expect(setiIcon("eslint.config.js", "dark").glyph).toBe(
      glyphOf(theme.fileNames["eslint.config.js"]),
    );
    expect(setiIcon(".nvmrc", "dark").glyph).toBe(glyphOf(theme.file));
  });

  it("uses the light variants in light mode", () => {
    const dark = setiIcon("index.ts", "dark");
    const light = setiIcon("index.ts", "light");
    expect(light.glyph).toBe(dark.glyph);
    expect(light.color).not.toBe(dark.color);
  });
});

describe("git status", () => {
  it("parses porcelain -z records", () => {
    const output = [
      " M src/a.ts",
      "A  src/new.ts",
      "AM docs/b.md",
      "?? scripts/c.ts",
      " D gone.txt",
      "UU conflict.ts",
      "R  new-name.ts",
      "old-name.ts",
      "",
    ].join("\0");
    expect(parsePorcelainZ(output)).toEqual([
      { path: "src/a.ts", state: "modified" },
      { path: "src/new.ts", state: "added" },
      { path: "docs/b.md", state: "added" },
      { path: "scripts/c.ts", state: "untracked" },
      { path: "gone.txt", state: "deleted" },
      { path: "conflict.ts", state: "conflict" },
      { path: "new-name.ts", state: "renamed" },
    ]);
  });

  it("rolls the strongest state up to every parent folder", () => {
    const { files, folders } = buildDecorations([
      { path: "src/lib/a.ts", state: "untracked" },
      { path: "src/b.ts", state: "modified" },
      { path: "docs/c.md", state: "added" },
    ]);
    expect(files.get("src/b.ts")).toBe("modified");
    expect(folders.get("src")).toBe("modified");
    expect(folders.get("src/lib")).toBe("untracked");
    expect(folders.get("docs")).toBe("added");
    expect(folders.has("src/b.ts")).toBe(false);
  });
});

describe("tree", () => {
  it("sorts folders first, then names naturally", () => {
    const entries: DirEntry[] = [
      { name: "b.ts", kind: "file", ignored: false },
      { name: "src", kind: "directory", ignored: false },
      { name: "a10.ts", kind: "file", ignored: false },
      { name: "a2.ts", kind: "file", ignored: false },
      { name: ".github", kind: "directory", ignored: false },
      { name: "App.tsx", kind: "file", ignored: false },
    ];
    expect(entries.sort(compareEntries).map((entry) => entry.name)).toEqual([
      ".github",
      "src",
      "a2.ts",
      "a10.ts",
      "App.tsx",
      "b.ts",
    ]);
  });

  it("confines folders to the workspace", () => {
    expect(normalizeRelativeDir("")).toBe("");
    expect(normalizeRelativeDir("./src//lib/")).toBe("src/lib");
    expect(normalizeRelativeDir("../etc")).toBeNull();
    expect(normalizeRelativeDir("src/../../x")).toBeNull();
    expect(normalizeRelativeDir("/etc")).toBeNull();
  });

  it("lists rows of open folders depth first and inherits ignored", () => {
    const children = new Map<string, DirEntry[]>([
      [
        "",
        [
          { name: "ios", kind: "directory", ignored: true },
          { name: "src", kind: "directory", ignored: false },
          { name: "a.ts", kind: "file", ignored: false },
        ],
      ],
      ["ios", [{ name: "Podfile", kind: "file", ignored: false }]],
      ["src", [{ name: "b.ts", kind: "file", ignored: false }]],
    ]);
    const rows = visibleRows(children, new Set(["ios"]));
    expect(rows.map((row) => [row.path, row.depth, row.ignored])).toEqual([
      ["ios", 0, true],
      ["ios/Podfile", 1, true],
      ["src", 0, false],
      ["a.ts", 0, false],
    ]);
  });
});
