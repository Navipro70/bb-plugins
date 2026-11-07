// Project Rail — backend.
//
// Owns two pieces of state in bb.storage.kv:
//   "focus": which project the rail has focused, plus a snapshot of the
//            Thread list preferences taken before focusing so "show all"
//            can restore them exactly.
//   "icons": per-project icon (PNG data URL or emoji) and accent color.
//
// Focusing a project drives the bundled Thread list plugin through its
// public RPC: organize by project, hide every other project group (and the
// loose Threads group) into More, and make sure the focused project is
// expanded. Nothing about threads or projects themselves is changed.
import { readFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const THREAD_LIST = "thread-list";
const ORIGIN = "project-rail";
const CHANGED = "rail-changed";
const MAX_IMAGE_BYTES = 256 * 1024;

const iconSchema = z.object({
  image: z.string().startsWith("data:image/").optional(),
  emoji: z.string().min(1).max(16).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type ProjectIcon = z.infer<typeof iconSchema>;

const snapshotSchema = z.object({
  organizationMode: z.unknown(),
  hiddenGroups: z.array(z.string()),
  collapsedProjects: z.array(z.string()),
});
type Snapshot = z.infer<typeof snapshotSchema>;

const focusSchema = z.object({
  projectId: z.string().nullable(),
  snapshot: snapshotSchema.nullable(),
});
type FocusState = z.infer<typeof focusSchema>;

const positionSchema = z.enum(["top", "bottom"]);
/** grouped: Home groups threads by project; badges: one flat list with a project icon per row. */
const homeStyleSchema = z.enum(["grouped", "badges"]);
const layoutSchema = z.object({
  hiddenProjectIds: z.array(z.string()),
  position: positionSchema,
  /** projectId -> sidebar navigation item id (e.g. "pulse/pulse") shown as that project's home. */
  homes: z.record(z.string(), z.string()).default({}),
  homeStyle: homeStyleSchema.default("grouped"),
});
type Layout = z.infer<typeof layoutSchema>;

const stateSchema = z.object({
  focusedProjectId: z.string().nullable(),
  icons: z.record(z.string(), iconSchema),
  hiddenProjectIds: z.array(z.string()),
  position: positionSchema,
  homes: z.record(z.string(), z.string()),
  homeStyle: homeStyleSchema,
});
export type RailState = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  state_get: { input: z.null(), output: stateSchema },
  focus_set: {
    input: z.object({ projectId: z.string().min(1).nullable() }),
    output: stateSchema,
  },
  layout_set: {
    input: z.object({
      hiddenProjectIds: z.array(z.string().min(1)).max(500).optional(),
      position: positionSchema.optional(),
      homes: z.record(z.string().min(1), z.string().min(1).max(200)).optional(),
      homeStyle: homeStyleSchema.optional(),
    }),
    output: stateSchema,
  },
});

const prefsOutput = z.object({
  preferences: z
    .object({
      organizationMode: z.unknown(),
      hiddenGroups: z.array(z.string()),
      collapsedProjects: z.array(z.string()),
    })
    .passthrough(),
});
const setPrefOutput = z.object({ key: z.string(), value: z.unknown() });

export default async function plugin(bb: BbPluginApi) {
  async function readFocus(): Promise<FocusState> {
    const parsed = focusSchema.safeParse(await bb.storage.kv.get("focus"));
    return parsed.success ? parsed.data : { projectId: null, snapshot: null };
  }
  async function readIcons(): Promise<Record<string, ProjectIcon>> {
    const parsed = z
      .record(z.string(), iconSchema)
      .safeParse(await bb.storage.kv.get("icons"));
    return parsed.success ? parsed.data : {};
  }
  async function readLayout(): Promise<Layout> {
    const parsed = layoutSchema.safeParse(await bb.storage.kv.get("layout"));
    return parsed.success
      ? parsed.data
      : { hiddenProjectIds: [], position: "top", homes: {}, homeStyle: "grouped" };
  }
  async function readState(): Promise<RailState> {
    const [focus, icons, layout] = await Promise.all([
      readFocus(),
      readIcons(),
      readLayout(),
    ]);
    return { focusedProjectId: focus.projectId, icons, ...layout };
  }
  async function setLayout(change: Partial<Layout>): Promise<RailState> {
    const layout = { ...(await readLayout()), ...change };
    layout.hiddenProjectIds = [...new Set(layout.hiddenProjectIds)];
    await bb.storage.kv.set("layout", layout);
    if (change.homeStyle !== undefined && (await readFocus()).projectId === null) {
      await focus(null);
    }
    return publish();
  }
  async function publish(): Promise<RailState> {
    const state = await readState();
    bb.realtime.publish(CHANGED, { focusedProjectId: state.focusedProjectId });
    return state;
  }

  async function listPrefs() {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST,
      method: "listPreferences",
      input: null,
      outputSchema: prefsOutput,
    });
    return result.preferences;
  }
  async function setPref(key: string, value: unknown) {
    await bb.sdk.plugins.callRpc({
      pluginId: THREAD_LIST,
      method: "setPreference",
      input: { key, value: value as never, origin: ORIGIN },
      outputSchema: setPrefOutput,
    });
  }

  async function listProjects(): Promise<{ id: string; name: string }[]> {
    const projects = (await bb.sdk.projects.list()) as {
      id: string;
      name: string;
    }[];
    return projects.map(({ id, name }) => ({ id, name }));
  }

  async function focus(projectId: string | null): Promise<RailState> {
    const current = await readFocus();
    if (projectId === null) {
      // Home: every project, grouped by the project each thread started in,
      // with project-less threads first and projects as compact headers
      // below (the rail opens a project expanded).
      const { homeStyle } = await readLayout();
      await setPref("organizationMode", homeStyle === "badges" ? "chronological" : "project");
      await setPref("sectionOrder", ["pinned", "threads", "projects"]);
      if (current.snapshot !== null) {
        const snap = current.snapshot;
        await setPref("hiddenGroups", snap.hiddenGroups);
        await setPref("collapsedProjects", snap.collapsedProjects);
      }
      if ((await bb.storage.kv.get("homeLayout")) !== 2) {
        // One-time: start Home with every project collapsed; later toggles
        // made on Home persist through the focus snapshot.
        const ids = (await listProjects())
          .map((project) => project.id)
          .filter((id) => id !== "proj_personal");
        await setPref("collapsedProjects", ids);
        await bb.storage.kv.set("homeLayout", 2);
      }
      await bb.storage.kv.set("focus", { projectId: null, snapshot: null });
      return publish();
    }

    const projects = await listProjects();
    if (!projects.some((project) => project.id === projectId)) {
      throw new Error(`Unknown project ${projectId}`);
    }
    const prefs = await listPrefs();
    const snapshot: Snapshot = current.snapshot ?? {
      organizationMode: prefs.organizationMode,
      hiddenGroups: prefs.hiddenGroups,
      collapsedProjects: prefs.collapsedProjects,
    };
    const focusedKey = `project:${projectId}`;
    const hidden = new Set(snapshot.hiddenGroups);
    hidden.delete(focusedKey);
    hidden.add("threads");
    hidden.add("project:proj_personal");
    for (const project of projects) {
      if (project.id !== projectId) hidden.add(`project:${project.id}`);
    }
    await setPref("organizationMode", "project");
    await setPref("hiddenGroups", [...hidden]);
    await setPref(
      "collapsedProjects",
      prefs.collapsedProjects.filter((id) => id !== projectId),
    );
    await bb.storage.kv.set("focus", { projectId, snapshot });
    return publish();
  }

  bb.rpc.register(rpcContract, {
    state_get: () => readState(),
    focus_set: ({ projectId }) => focus(projectId),
    layout_set: (change) => setLayout(change),
  });

  async function resolveProject(
    selector: string | undefined,
    fallback: string | undefined,
  ): Promise<{ id: string; name: string }> {
    const projects = await listProjects();
    const wanted = selector ?? fallback;
    if (wanted === undefined) {
      throw new Error("Pass --project <id|name> (no calling chat project).");
    }
    const match =
      projects.find((project) => project.id === wanted) ??
      projects.find(
        (project) => project.name.toLowerCase() === wanted.toLowerCase(),
      );
    if (match === undefined) throw new Error(`No project matches "${wanted}".`);
    return match;
  }

  async function updateIcon(
    projectId: string,
    change: (icon: ProjectIcon) => ProjectIcon | null,
  ): Promise<ProjectIcon | null> {
    const icons = await readIcons();
    const next = change(icons[projectId] ?? {});
    if (next === null || Object.keys(next).length === 0) delete icons[projectId];
    else icons[projectId] = iconSchema.parse(next);
    await bb.storage.kv.set("icons", icons);
    await publish();
    return icons[projectId] ?? null;
  }

  async function loadPng(path: string, cwd: string | undefined) {
    const absolute = resolvePath(cwd ?? process.cwd(), path);
    const info = await stat(absolute);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image is ${info.size} bytes; the limit is 256KB.`);
    }
    const bytes = await readFile(absolute);
    const isPng = bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng) throw new Error("Only PNG images are supported.");
    return `data:image/png;base64,${bytes.toString("base64")}`;
  }

  function describeIcon(icon: ProjectIcon | null): string {
    if (icon === null) return "monogram (default)";
    const parts = [
      icon.image ? "image" : icon.emoji ? `emoji ${icon.emoji}` : "monogram",
    ];
    if (icon.color) parts.push(`color ${icon.color}`);
    return parts.join(", ");
  }

  const usage = [
    "Usage:",
    "  bb project-rail status",
    "  bb project-rail focus <project-id|name|all>",
    "  bb project-rail icon set <file.png> [--project <id|name>]",
    "  bb project-rail icon emoji <emoji> [--project <id|name>]",
    "  bb project-rail icon color <#rrggbb> [--project <id|name>]",
    "  bb project-rail icon clear [--project <id|name>]",
    "  bb project-rail icon get [--project <id|name>]",
    "  bb project-rail home set <nav-item-id> [--project <id|name>]   # e.g. pulse/pulse",
    "  bb project-rail home clear [--project <id|name>]",
    "  bb project-rail home-style <grouped|badges>   # Home: groups by project, or one list with project icons",
    "",
    "Without --project, the calling chat's project is used.",
  ].join("\n");

  bb.cli.register({
    name: "project-rail",
    summary: "Project icons in the sidebar rail; focus the thread list on one project",
    commands: [
      { name: "status", summary: "Show the focused project and icons", usage: "bb project-rail status" },
      { name: "focus", summary: "Focus a project, or 'all' to show every project", usage: "bb project-rail focus <project-id|name|all>" },
      { name: "icon", summary: "Set, read, or clear a project's rail icon", usage: "bb project-rail icon <set|emoji|color|clear|get> [value] [--project <id|name>]" },
      { name: "home-style", summary: "Home groups threads by project, or shows one list with project icons", usage: "bb project-rail home-style <grouped|badges>" },
      { name: "home", summary: "Open a plugin panel as a project's home when its icon is clicked", usage: "bb project-rail home <set <nav-item-id>|clear> [--project <id|name>]" },
    ],
    async run(argv, ctx) {
      const args = [...argv];
      let projectFlag: string | undefined;
      const flagIndex = args.indexOf("--project");
      if (flagIndex !== -1) {
        projectFlag = args[flagIndex + 1];
        args.splice(flagIndex, 2);
      }
      const [command, sub, ...rest] = args;
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
          case "-h":
            return { exitCode: 0, stdout: usage };
          case "status": {
            const state = await readState();
            const projects = await listProjects();
            const lines = projects.map((project) => {
              const mark = project.id === state.focusedProjectId ? "*" : " ";
              const home = state.homes[project.id];
              return `${mark} ${project.name} (${project.id}): ${describeIcon(state.icons[project.id] ?? null)}${home ? `; home ${home}` : ""}`;
            });
            lines.unshift(
              state.focusedProjectId === null
                ? "Focus: all projects"
                : `Focus: ${state.focusedProjectId}`,
            );
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "focus": {
            if (sub === undefined) break;
            if (sub === "all" || sub === "none") {
              await focus(null);
              return { exitCode: 0, stdout: "Showing all projects." };
            }
            const project = await resolveProject(sub, undefined);
            await focus(project.id);
            return { exitCode: 0, stdout: `Focused ${project.name}.` };
          }
          case "home-style": {
            const parsed = homeStyleSchema.safeParse(sub);
            if (!parsed.success) break;
            await setLayout({ homeStyle: parsed.data });
            return { exitCode: 0, stdout: `Home: ${parsed.data}.` };
          }
          case "home": {
            const project = await resolveProject(projectFlag, ctx.projectId);
            const homes = { ...(await readLayout()).homes };
            if (sub === "set" && rest.length === 1 && /^[\w.-]+\/[\w.-]+$/.test(rest[0])) {
              homes[project.id] = rest[0];
              await setLayout({ homes });
              return { exitCode: 0, stdout: `${project.name}: home is ${rest[0]}.` };
            }
            if (sub === "clear") {
              delete homes[project.id];
              await setLayout({ homes });
              return { exitCode: 0, stdout: `${project.name}: home is the thread list.` };
            }
            break;
          }
          case "icon": {
            const project = await resolveProject(projectFlag, ctx.projectId);
            const value = rest.join(" ").trim();
            switch (sub) {
              case "set": {
                if (value === "") break;
                const image = await loadPng(value, ctx.cwd);
                await updateIcon(project.id, (icon) => ({ ...icon, image, emoji: undefined }));
                return { exitCode: 0, stdout: `${project.name}: icon set from ${value}.` };
              }
              case "emoji": {
                if (value === "") break;
                await updateIcon(project.id, (icon) => ({ ...icon, emoji: value, image: undefined }));
                return { exitCode: 0, stdout: `${project.name}: emoji ${value}.` };
              }
              case "color": {
                if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
                  return { exitCode: 1, stderr: "Color must look like #1f9d8b." };
                }
                await updateIcon(project.id, (icon) => ({ ...icon, color: value }));
                return { exitCode: 0, stdout: `${project.name}: color ${value}.` };
              }
              case "clear":
                await updateIcon(project.id, () => null);
                return { exitCode: 0, stdout: `${project.name}: back to the monogram.` };
              case "get":
                return {
                  exitCode: 0,
                  stdout: `${project.name}: ${describeIcon((await readIcons())[project.id] ?? null)}`,
                };
            }
            break;
          }
        }
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
