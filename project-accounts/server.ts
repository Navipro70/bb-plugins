// Project Accounts — keep selected projects off the Account Pooler.
//
// The Account Pooler routes every Claude Code and Codex thread through its
// shared pool and only offers a per-thread bypass. This plugin applies that
// bypass automatically to every thread of the projects you list, so those
// threads use their own provider login instead — for example a separate
// Claude login selected with a project-scoped CLAUDE_CONFIG_DIR
// (`bb machine env set CLAUDE_CONFIG_DIR --project <id>`).
//
// Bypass is applied when a thread is created, re-checked on every provider
// command through an env resolver (which contributes no variables), and
// reconciled for existing threads on load and when a project is added.
//
// It also shows which account serves a thread and how much of it is left:
// a chip in the thread header and the new-thread composer (app.tsx), and the
// project logins as cards in bb's Provider usage panel.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  accountViewSchema,
  createOwnUsage,
  poolAccountSchema,
  poolView,
  type AccountView,
  type OwnLogin,
  type PoolAccount,
} from "./accounts";
import {
  usageFetchMethod,
  usageListMethod,
  usageSourceRpcContract,
  type UsageMeasurement,
} from "./usage-source-contract";

const loginSchema = z.object({
  configDir: z.string().min(1),
  label: z.string().min(1).max(40).nullable().default(null),
});
const loginsSchema = z.record(z.string(), loginSchema);

export const rpcContract = defineRpcContract({
  account_view: {
    input: z.object({
      projectId: z.string().min(1),
      providerId: z.string().min(1).nullable(),
      refresh: z.boolean().default(false),
    }),
    output: accountViewSchema.nullable(),
  },
});

const POOL = "account-pool";
const PROVIDERS = ["claude-code", "codex"] as const;

const bypassOutput = z.object({ threadId: z.string(), bypassed: z.boolean() });

export default async function plugin(bb: BbPluginApi) {
  async function readProjects(): Promise<string[]> {
    const parsed = z.array(z.string()).safeParse(await bb.storage.kv.get("projects"));
    return parsed.success ? parsed.data : [];
  }
  async function writeProjects(ids: string[]): Promise<void> {
    await bb.storage.kv.set("projects", [...new Set(ids)]);
  }
  async function readLogins(): Promise<Record<string, OwnLogin>> {
    const parsed = loginsSchema.safeParse(await bb.storage.kv.get("logins"));
    return parsed.success ? parsed.data : {};
  }
  async function writeLogins(logins: Record<string, OwnLogin>): Promise<void> {
    await bb.storage.kv.set("logins", logins);
    bb.realtime.publish("accounts-changed", {});
  }

  const ownUsage = createOwnUsage(bb.log);

  async function poolAccounts() {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: POOL,
      method: "account.list",
      input: null,
      outputSchema: z.unknown(),
    });
    const rows = Array.isArray(result)
      ? result
      : ((result as { accounts?: unknown[] } | null)?.accounts ?? []);
    return rows.flatMap((row) => {
      const parsed = poolAccountSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
  }
  async function refreshPool(accountIds: string[]) {
    await Promise.all(
      accountIds.map((accountId) =>
        bb.sdk.plugins
          .callRpc({ pluginId: POOL, method: "account.refreshUsage", input: { accountId }, outputSchema: z.unknown() })
          .catch(() => null),
      ),
    );
  }

  function localView(provider: "claude" | "codex", message: string): AccountView {
    return {
      source: "local",
      provider,
      label: provider === "claude" ? "Machine login" : "Machine Codex login",
      email: null,
      organization: null,
      plan: null,
      configDir: provider === "claude" ? `${homedir()}/.claude` : null,
      accountUuid: null,
      status: "ok",
      message,
      windows: [],
      observedAt: null,
    };
  }

  async function accountView(
    projectId: string,
    providerId: string | null,
    refresh: boolean,
  ): Promise<AccountView | null> {
    const provider = providerId === "codex" ? "codex" : providerId === null || providerId === "claude-code" ? "claude" : null;
    if (provider === null) return null;
    const [bypassed, logins] = await Promise.all([readProjects(), readLogins()]);
    const login = logins[projectId];
    if (provider === "claude" && login !== undefined) return ownUsage(login, refresh);
    if (bypassed.includes(projectId)) {
      return localView(provider, "This project bypasses the Account Pooler and uses the login its environment selects.");
    }
    let accounts: PoolAccount[];
    try {
      accounts = await poolAccounts();
    } catch {
      return localView(provider, "The Account Pooler is not answering; threads use the machine login.");
    }
    if (refresh) {
      const ids = accounts.filter((a) => a.enabled && a.provider === provider).map((a) => a.id);
      await refreshPool(ids);
      accounts = await poolAccounts().catch(() => accounts);
    }
    return poolView(accounts, provider) ?? localView(provider, "No enabled pool account for this provider.");
  }

  bb.rpc.register(rpcContract, {
    account_view: ({ projectId, providerId, refresh }) => accountView(projectId, providerId, refresh),
  });

  // ---- Provider usage panel: one card per project login ----------------
  function resourceId(configDir: string) {
    return `login-${createHash("sha256").update(configDir).digest("hex").slice(0, 12)}`;
  }
  async function distinctLogins(): Promise<Map<string, OwnLogin>> {
    const byId = new Map<string, OwnLogin>();
    for (const login of Object.values(await readLogins())) {
      const id = resourceId(login.configDir);
      if (!byId.has(id)) byId.set(id, login);
    }
    return byId;
  }
  function toMeasurement(view: AccountView): UsageMeasurement {
    const fields = {
      plan: null,
      accountEmail: view.email,
      planLabel: [view.label, view.plan].filter(Boolean).join(" · ") || null,
    };
    const accountKey = view.accountUuid ? `anthropic:account:${view.accountUuid}` : null;
    if (view.status === "ok" || view.windows.length > 0) {
      return {
        accountKey,
        observedAt: view.observedAt,
        usage: {
          status: "ok",
          ...fields,
          windows: view.windows.map((w) => ({
            kind: w.kind,
            id: w.id,
            label: w.label,
            usedPercent: w.usedPercent,
            resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString(),
            model: w.model,
            cost: null,
          })),
        },
      };
    }
    if (view.status === "expired" || view.status === "unauthenticated") {
      return { accountKey, observedAt: view.observedAt, usage: { status: view.status, ...fields } };
    }
    if (view.status === "missing") {
      return { accountKey, observedAt: null, usage: { status: "unauthenticated", ...fields } };
    }
    return {
      accountKey,
      observedAt: view.observedAt,
      usage: { status: "error", ...fields, message: view.message ?? "Usage unavailable." },
    };
  }
  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const resources = [...(await distinctLogins())].map(([id, login]) => ({
          id,
          accountKey: null,
          providerId: "claude-code",
          label: login.label ?? login.configDir,
          scope: { kind: "shared" as const },
        }));
        return { label: "Project logins", resources };
      },
      async [usageFetchMethod]({ resourceId: id, refresh }) {
        const login = (await distinctLogins()).get(id);
        if (login === undefined) throw new Error("Usage resource no longer exists.");
        return toMeasurement(await ownUsage(login, refresh));
      },
    },
    {
      experimental_discoverable: true,
      experimental_description: "Usage windows of the Claude Code logins that projects use instead of the Account Pooler.",
    },
  );

  /** Threads we already bypassed in this load; avoids an RPC per turn. */
  const applied = new Set<string>();

  async function setBypass(threadId: string, bypassed: boolean): Promise<void> {
    await bb.sdk.plugins.callRpc({
      pluginId: POOL,
      method: "bypass.set",
      input: { threadId, bypassed },
      outputSchema: bypassOutput,
    });
    if (bypassed) applied.add(threadId);
    else applied.delete(threadId);
  }

  async function ensureBypass(threadId: string): Promise<void> {
    if (applied.has(threadId)) return;
    try {
      await setBypass(threadId, true);
    } catch (error) {
      bb.log.warn(
        `could not bypass the Account Pooler for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function listProjectThreadIds(projectId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const archived of [false, true]) {
      const result = (await bb.sdk.threads.list({
        projectId,
        archived,
        includeHidden: true,
      })) as unknown;
      const rows = Array.isArray(result)
        ? result
        : ((result as { threads?: unknown[] } | null)?.threads ?? []);
      for (const row of rows) {
        const id = (row as { id?: unknown }).id;
        if (typeof id === "string") ids.push(id);
      }
    }
    return ids;
  }

  async function reconcile(projectId: string, bypassed: boolean): Promise<number> {
    const ids = await listProjectThreadIds(projectId);
    for (const id of ids) {
      if (bypassed) await ensureBypass(id);
      else await setBypass(id, false).catch(() => {});
    }
    return ids.length;
  }

  bb.events.on("thread.created", async ({ thread }) => {
    const projects = await readProjects();
    if (projects.includes(thread.projectId)) await ensureBypass(thread.id);
  });

  for (const providerId of PROVIDERS) {
    bb.providers.experimental_contributeEnv(providerId, async (context) => {
      if (context.threadId !== null && context.projectId !== null) {
        const projects = await readProjects();
        if (projects.includes(context.projectId)) await ensureBypass(context.threadId);
      }
      return [];
    });
  }

  bb.background.service("reconcile", {
    async start(signal) {
      for (const projectId of await readProjects()) {
        if (signal.aborted) return;
        await reconcile(projectId, true).catch((error) =>
          bb.log.warn(`reconcile ${projectId} failed: ${String(error)}`),
        );
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });

  async function resolveProject(selector: string | undefined, fallback: string | undefined) {
    const projects = (await bb.sdk.projects.list()) as { id: string; name: string }[];
    const wanted = selector ?? fallback;
    if (wanted === undefined) throw new Error("Name a project: <id|name>.");
    const match =
      projects.find((project) => project.id === wanted) ??
      projects.find((project) => project.name.toLowerCase() === wanted.toLowerCase());
    if (match === undefined) throw new Error(`No project matches "${wanted}".`);
    return match;
  }

  const usage = [
    "Usage:",
    "  bb project-accounts list",
    "  bb project-accounts add <project-id|name>      # bypass the Account Pooler for its threads",
    "  bb project-accounts remove <project-id|name>   # route its threads through the pool again",
    "  bb project-accounts login <project> <config-dir> [--label <name>]   # the login to show and measure",
    "  bb project-accounts login <project> --clear",
    "  bb project-accounts show <project>              # account and usage right now",
  ].join("\n");

  function describe(view: AccountView): string {
    const source = { own: "project login", pool: "Account Pooler", local: "machine login" }[view.source];
    const lines = [
      `${view.label}${view.plan ? ` (${view.plan})` : ""} via ${source}${view.email ? ` — ${view.email}` : ""}`,
    ];
    if (view.organization && view.organization !== view.label) lines.push(`  org: ${view.organization}`);
    if (view.configDir) lines.push(`  config: ${view.configDir}`);
    for (const w of view.windows) {
      const reset = w.resetsAt === null ? "" : `, resets ${new Date(w.resetsAt).toLocaleString()}`;
      lines.push(`  ${w.label}: ${Math.round(w.usedPercent)}% used${reset}`);
    }
    if (view.status !== "ok") lines.push(`  status: ${view.status}`);
    if (view.message) lines.push(`  ${view.message}`);
    return lines.join("\n");
  }

  bb.cli.register({
    name: "project-accounts",
    summary: "Keep selected projects off the Account Pooler so they use their own login",
    commands: [
      { name: "list", summary: "List projects that bypass the pool", usage: "bb project-accounts list" },
      { name: "add", summary: "Bypass the pool for every thread of a project", usage: "bb project-accounts add <project-id|name>" },
      { name: "remove", summary: "Route a project's threads through the pool again", usage: "bb project-accounts remove <project-id|name>" },
      { name: "login", summary: "Set the CLAUDE_CONFIG_DIR login a project uses (shown in headers and Provider usage)", usage: "bb project-accounts login <project> <config-dir> [--label <name>] | --clear" },
      { name: "show", summary: "Show which account serves a project and its usage", usage: "bb project-accounts show [<project>] [--refresh]" },
    ],
    async run(argv, ctx) {
      const args = [...argv];
      const take = (flag: string) => {
        const index = args.indexOf(flag);
        if (index === -1) return undefined;
        const [, value] = args.splice(index, 2);
        return value;
      };
      const takeBool = (flag: string) => {
        const index = args.indexOf(flag);
        if (index === -1) return false;
        args.splice(index, 1);
        return true;
      };
      const label = take("--label");
      const clear = takeBool("--clear");
      const refresh = takeBool("--refresh");
      const [command, target, extra] = args;
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
          case "-h":
            return { exitCode: 0, stdout: usage };
          case "list": {
            const ids = await readProjects();
            const projects = (await bb.sdk.projects.list()) as { id: string; name: string }[];
            const lines = ids.map(
              (id) => `${projects.find((project) => project.id === id)?.name ?? "(deleted)"} (${id})`,
            );
            return {
              exitCode: 0,
              stdout: lines.length === 0 ? "No projects bypass the pool." : lines.join("\n"),
            };
          }
          case "add": {
            const project = await resolveProject(target, ctx.projectId);
            await writeProjects([...(await readProjects()), project.id]);
            const count = await reconcile(project.id, true);
            return {
              exitCode: 0,
              stdout: `${project.name}: threads bypass the Account Pooler (${count} existing thread(s) updated).`,
            };
          }
          case "login": {
            const project = await resolveProject(target, ctx.projectId);
            const logins = await readLogins();
            if (clear) {
              delete logins[project.id];
              await writeLogins(logins);
              return { exitCode: 0, stdout: `${project.name}: no project login; the header shows the pool.` };
            }
            if (extra === undefined) break;
            const configDir = resolvePath(ctx.cwd ?? process.cwd(), extra.replace(/^~(?=\/|$)/, homedir()));
            logins[project.id] = { configDir, label: label ?? null };
            await writeLogins(logins);
            const view = await ownUsage(logins[project.id], true);
            return { exitCode: 0, stdout: `${project.name}: login ${configDir}.\n${describe(view)}` };
          }
          case "show": {
            const project = await resolveProject(target, ctx.projectId);
            const view = await accountView(project.id, "claude-code", refresh);
            return { exitCode: 0, stdout: `${project.name}\n${view === null ? "No account." : describe(view)}` };
          }
          case "remove": {
            const project = await resolveProject(target, ctx.projectId);
            await writeProjects((await readProjects()).filter((id) => id !== project.id));
            const count = await reconcile(project.id, false);
            return {
              exitCode: 0,
              stdout: `${project.name}: threads use the Account Pooler again (${count} thread(s) updated).`,
            };
          }
        }
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
      return { exitCode: 1, stderr: usage };
    },
  });
}
