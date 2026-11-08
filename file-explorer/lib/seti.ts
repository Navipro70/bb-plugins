// Resolves a file name to its Seti icon the way VS Code's file icon themes
// do: exact file name, then the longest dotted extension, then the language
// the extension belongs to, then the default file icon.
import theme from "./seti-theme.json";

export interface SetiIcon {
  /** The glyph in the Seti font. */
  glyph: string;
  /** Icon color, or null to inherit the text color. */
  color: string | null;
}

interface IconMaps {
  file: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  languageIds: Record<string, string>;
}

const icons = theme.icons as unknown as Record<string, [string, string | null]>;
const dark: IconMaps = theme;
const light: IconMaps = theme.light;

// The languages VS Code assigns by file name or extension, for the ones Seti
// draws. Extensions are lower case and without the leading dot.
const LANGUAGE_BY_NAME: Record<string, string> = {
  ".env": "dotenv",
  ".gitignore": "ignore",
  ".gitattributes": "properties",
  ".prettierignore": "ignore",
  ".eslintignore": "ignore",
  ".npmignore": "ignore",
  ".dockerignore": "ignore",
  ".easignore": "ignore",
  ".vscodeignore": "ignore",
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  podfile: "ruby",
  rakefile: "ruby",
  fastfile: "ruby",
  appfile: "ruby",
  ".prettierrc": "json",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".swcrc": "json",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "jsonc",
  json5: "json",
  jsonl: "jsonl",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  pcss: "postcss",
  html: "html",
  htm: "html",
  xml: "xml",
  plist: "xml",
  xsd: "xml",
  storyboard: "xml",
  xib: "xml",
  yml: "yaml",
  yaml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  py: "python",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  java: "java",
  gradle: "gradle",
  groovy: "groovy",
  properties: "properties",
  env: "dotenv",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  go: "go",
  rs: "rust",
  php: "php",
  lua: "lua",
  dart: "dart",
  vue: "vue",
  sql: "sql",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  r: "r",
  tf: "terraform",
  tex: "latex",
};

/**
 * Lower-cased dotted suffixes of a file name, longest first, as VS Code
 * builds them: "eslint.config.js" → ["config.js", "js"], ".nvmrc" → ["nvmrc"].
 */
export function extensionCandidates(fileName: string): string[] {
  const segments = fileName.toLowerCase().split(".");
  const candidates: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const candidate = segments.slice(index).join(".");
    if (candidate !== "") candidates.push(candidate);
  }
  return candidates;
}

/** The language VS Code would give the file, as far as Seti cares. */
export function languageOf(fileName: string): string | null {
  const name = fileName.toLowerCase();
  const byName = LANGUAGE_BY_NAME[name];
  if (byName !== undefined) return byName;
  for (const extension of extensionCandidates(name)) {
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language !== undefined) return language;
  }
  return null;
}

function iconId(fileName: string, maps: IconMaps): string {
  const name = fileName.toLowerCase();
  const byName = maps.fileNames[name];
  if (byName !== undefined) return byName;
  for (const extension of extensionCandidates(name)) {
    const byExtension = maps.fileExtensions[extension];
    if (byExtension !== undefined) return byExtension;
  }
  const language = languageOf(name);
  if (language !== null) {
    const byLanguage = maps.languageIds[language];
    if (byLanguage !== undefined) return byLanguage;
  }
  return maps.file;
}

export function setiIcon(fileName: string, mode: "dark" | "light"): SetiIcon {
  const maps = mode === "light" ? light : dark;
  const entry = icons[iconId(fileName, maps)] ?? icons[maps.file];
  return { glyph: entry?.[0] ?? "", color: entry?.[1] ?? null };
}
