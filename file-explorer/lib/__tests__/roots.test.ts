import { describe, expect, it } from "vitest";
import { newThreadRoot, rootKey } from "../roots";

describe("newThreadRoot", () => {
  it("shows a reused environment", () => {
    expect(newThreadRoot("p1", { type: "reuse", environmentId: "env_1" })).toEqual({
      root: { kind: "environment", environmentId: "env_1" },
      note: null,
    });
  });

  it("shows the project folder for a project checkout on a machine", () => {
    expect(
      newThreadRoot("p1", {
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "existing", hostId: "host_1" },
      }),
    ).toEqual({ root: { kind: "project", projectId: "p1", hostId: "host_1" }, note: null });
  });

  it("notes that a new worktree starts from the project folder", () => {
    const result = newThreadRoot("p1", {
      type: "provider",
      environmentProviderId: "git-worktree",
    });
    expect(result?.root).toEqual({ kind: "project", projectId: "p1", hostId: null });
    expect(result?.note).toMatch(/starts from this project folder/);
    expect(
      newThreadRoot("p1", { type: "host", workspace: { type: "managed-worktree" } })?.note,
    ).toMatch(/worktree/);
  });

  it("falls back to the project folder before anything is selected", () => {
    expect(newThreadRoot("p1", undefined)?.root).toEqual({
      kind: "project",
      projectId: "p1",
      hostId: null,
    });
    expect(newThreadRoot("p1", { type: "project-default" })?.root.kind).toBe("project");
  });

  it("has nothing to show without a folder", () => {
    expect(newThreadRoot(null, undefined)).toBeNull();
    expect(newThreadRoot("p1", { type: "host", workspace: { type: "personal" } })).toBeNull();
    expect(
      newThreadRoot("p1", {
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "new" },
      }),
    ).toBeNull();
  });

  it("keys roots so a change of folder remounts the tree", () => {
    expect(rootKey({ kind: "environment", environmentId: "env_1" })).toBe("env:env_1");
    expect(rootKey({ kind: "project", projectId: "p1", hostId: null })).toBe("project:p1:local");
  });
});
