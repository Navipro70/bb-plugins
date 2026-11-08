// File Explorer backend: lists one folder of a thread's workspace at a time
// and reads its git status, for the Files tab in app.tsx.
//
// The workspace is read with Node's fs and git on this machine, so it covers
// environments on the bb server's own machine (project checkouts and local
// worktrees). Environments on other machines get a clear error.
import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parsePorcelainZ } from "./lib/git-status";
import { compareEntries, HIDDEN_NAMES, normalizeRelativeDir, type DirEntry } from "./lib/tree";

const MAX_ENTRIES = 5000;
const MAX_STATUS_FILES = 20000;
const GIT_TIMEOUT_MS = 15000;
const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const entrySchema = z.object({
  name: z.string(),
  kind: z.enum(["file", "directory"]),
  ignored: z.boolean(),
});

const gitStateSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
  "conflict",
]);

export const rpcContract = defineRpcContract({
  workspace: {
    input: z.object({ environmentId: z.string().min(1) }),
    output: z.object({
      name: z.string(),
      isGitRepo: z.boolean(),
      branch: z.string().nullable(),
    }),
  },
  list_dir: {
    input: z.object({
      environmentId: z.string().min(1),
      dir: z.string().max(4096),
    }),
    output: z.object({
      entries: z.array(entrySchema),
      truncated: z.boolean(),
    }),
  },
  git_status: {
    input: z.object({ environmentId: z.string().min(1) }),
    output: z.object({
      available: z.boolean(),
      files: z.array(z.object({ path: z.string(), state: gitStateSchema })),
      truncated: z.boolean(),
    }),
  },
});

interface Workspace {
  root: string;
  isGitRepo: boolean;
  branch: string | null;
}

class GitError extends Error {}

/** Runs git in `cwd`; resolves stdout. Exit code 1 is allowed when asked. */
function runGit(
  cwd: string,
  args: string[],
  options: { input?: string; allowExitOne?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new GitError(`git ${args[0]} timed out`));
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GIT_MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new GitError(`git could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || (code === 1 && options.allowExitOne === true)) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else {
        reject(new GitError(stderr.trim() || `git ${args[0]} exited with ${code}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

export default async function plugin(bb: BbPluginApi) {
  const workspaces = new Map<string, { value: Workspace; expiresAt: number }>();

  async function resolveWorkspace(environmentId: string): Promise<Workspace> {
    const cached = workspaces.get(environmentId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
    const environment = await bb.sdk.environments.get({ environmentId });
    const { primaryHostId } = await bb.sdk.system.config();
    if (environment.hostId !== primaryHostId) {
      throw new Error(
        "File Explorer reads workspaces on this computer only; this thread's environment is on another machine.",
      );
    }
    if (environment.path === null || environment.path === undefined) {
      throw new Error("This environment has no workspace folder yet.");
    }
    const value: Workspace = {
      root: await realpath(environment.path),
      isGitRepo: environment.isGitRepo === true,
      branch: environment.branchName ?? null,
    };
    workspaces.set(environmentId, { value, expiresAt: Date.now() + 30_000 });
    return value;
  }

  /** The absolute folder for a relative one, confined to the workspace. */
  async function resolveDir(root: string, dir: string): Promise<string> {
    const normalized = normalizeRelativeDir(dir);
    if (normalized === null) throw new Error(`Not a workspace folder: ${dir}`);
    const absolute = await realpath(join(root, normalized));
    const inside = relative(root, absolute);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`Not a workspace folder: ${dir}`);
    }
    return absolute;
  }

  async function ignoredNames(
    root: string,
    dir: string,
    entries: { name: string; kind: DirEntry["kind"] }[],
  ): Promise<Set<string>> {
    if (entries.length === 0) return new Set();
    const prefix = normalizeRelativeDir(dir) ?? "";
    const toPath = (entry: { name: string; kind: DirEntry["kind"] }) =>
      `${prefix === "" ? "" : `${prefix}/`}${entry.name}${entry.kind === "directory" ? "/" : ""}`;
    const output = await runGit(root, ["check-ignore", "-z", "--stdin"], {
      input: entries.map(toPath).join("\0") + "\0",
      allowExitOne: true,
    });
    const ignored = new Set<string>();
    for (const path of output.split("\0")) {
      if (path === "") continue;
      const name = path.replace(/\/$/, "").split("/").pop();
      if (name !== undefined) ignored.add(name);
    }
    return ignored;
  }

  async function listDir(environmentId: string, dir: string) {
    const workspace = await resolveWorkspace(environmentId);
    const absolute = await resolveDir(workspace.root, dir);
    const dirents = await readdir(absolute, { withFileTypes: true });
    const truncated = dirents.length > MAX_ENTRIES;
    const raw: { name: string; kind: DirEntry["kind"] }[] = [];
    for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
      if (HIDDEN_NAMES.has(dirent.name)) continue;
      let kind: DirEntry["kind"] = dirent.isDirectory() ? "directory" : "file";
      if (dirent.isSymbolicLink()) {
        kind = await stat(join(absolute, dirent.name)).then(
          (target) => (target.isDirectory() ? "directory" : "file"),
          () => "file",
        );
      }
      raw.push({ name: dirent.name, kind });
    }
    let ignored = new Set<string>();
    if (workspace.isGitRepo) {
      ignored = await ignoredNames(workspace.root, dir, raw).catch((error: unknown) => {
        bb.log.warn(`check-ignore failed: ${String(error)}`);
        return new Set<string>();
      });
    }
    const entries: DirEntry[] = raw
      .map((entry) => ({ ...entry, ignored: ignored.has(entry.name) }))
      .sort(compareEntries);
    return { entries, truncated };
  }

  async function gitStatus(environmentId: string) {
    const workspace = await resolveWorkspace(environmentId);
    if (!workspace.isGitRepo) return { available: false, files: [], truncated: false };
    const output = await runGit(workspace.root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ]);
    const files = parsePorcelainZ(output);
    return {
      available: true,
      files: files.slice(0, MAX_STATUS_FILES),
      truncated: files.length > MAX_STATUS_FILES,
    };
  }

  bb.rpc.register(rpcContract, {
    workspace: async ({ environmentId }) => {
      const workspace = await resolveWorkspace(environmentId);
      return {
        name: workspace.root.split("/").pop() ?? workspace.root,
        isGitRepo: workspace.isGitRepo,
        branch: workspace.branch,
      };
    },
    list_dir: ({ environmentId, dir }) => listDir(environmentId, dir),
    git_status: ({ environmentId }) => gitStatus(environmentId),
  });
}
