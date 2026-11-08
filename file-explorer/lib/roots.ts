// Which folder a Files tab shows: a thread's environment, or, on the New
// thread screen, what its composer has selected.

export type Root =
  | { kind: "environment"; environmentId: string }
  | {
      kind: "project";
      projectId: string;
      /** The machine to read the project's folder on; the server's own when null. */
      hostId: string | null;
    };

/**
 * The environment part of a New thread composer selection, as bb's
 * `CreateThreadEnvironmentArgs` describes it; only the fields read here.
 */
export type SelectedEnvironment =
  | { type: "reuse"; environmentId: string }
  | {
      type: "host";
      hostId?: string;
      workspace: { type: "unmanaged" | "managed-worktree" | "personal" };
    }
  | { type: "project-default" }
  | {
      type: "provider";
      environmentProviderId: string;
      machine?: { type: "existing"; hostId: string } | { type: "new" };
    };

export function rootKey(root: Root): string {
  return root.kind === "environment"
    ? `env:${root.environmentId}`
    : `project:${root.projectId}:${root.hostId ?? "local"}`;
}

const CHECKOUT_PROVIDER = "project-checkout";

/**
 * The folder the New thread screen will work in: an existing environment it
 * reuses, or else the project's own folder on the selected machine (a new
 * worktree or environment starts from it). Null when there is no folder to
 * show yet: no project, a machine still to be created, or no project at all.
 */
export function newThreadRoot(
  projectId: string | null,
  environment: SelectedEnvironment | undefined,
): { root: Root; note: string | null } | null {
  if (environment?.type === "reuse") {
    return { root: { kind: "environment", environmentId: environment.environmentId }, note: null };
  }
  if (projectId === null) return null;
  let hostId: string | null = null;
  let note: string | null = null;
  if (environment?.type === "provider") {
    if (environment.machine?.type === "new") return null;
    if (environment.machine?.type === "existing") hostId = environment.machine.hostId;
    if (environment.environmentProviderId !== CHECKOUT_PROVIDER) {
      note = "A new environment starts from this project folder.";
    }
  } else if (environment?.type === "host") {
    if (environment.workspace.type === "personal") return null;
    hostId = environment.hostId ?? null;
    if (environment.workspace.type === "managed-worktree") {
      note = "A new worktree starts from this project folder.";
    }
  }
  return { root: { kind: "project", projectId, hostId }, note };
}
