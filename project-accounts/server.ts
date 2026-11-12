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
import { dirname, join, resolve as resolvePath } from "node:path";
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
import { createProxy, PROXY_PATHS } from "./proxy";
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

/**
 * One Claude account of the Account Pooler as a project sees it. The pool picks
 * an account per request from every enabled account and cannot be limited per
 * project, so a project can use either all of them (routed through the pool)
 * or only the account its own login belongs to (the pool is bypassed and the
 * project's CLAUDE_CONFIG_DIR login answers). `toggleable` is false when the
 * switch would ask for any other combination; `hint` says why.
 */
export const projectPoolAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  enabledInPool: z.boolean(),
  allowed: z.boolean(),
  /** The account the project's own login (CLAUDE_CONFIG_DIR) belongs to. */
  local: z.boolean(),
  toggleable: z.boolean(),
  hint: z.string().nullable(),
});
export type ProjectPoolAccount = z.infer<typeof projectPoolAccountSchema>;

/** An account view plus the project's routing and its pool accounts. */
export const projectAccountSchema = accountViewSchema.extend({
  pooled: z.boolean(),
  accounts: z.array(projectPoolAccountSchema),
});
export type ProjectAccount = z.infer<typeof projectAccountSchema>;

export const rpcContract = defineRpcContract({
  account_view: {
    input: z.object({
      projectId: z.string().min(1),
      providerId: z.string().min(1).nullable(),
      refresh: z.boolean().default(false),
    }),
    output: projectAccountSchema.nullable(),
  },
  set_pooled: {
    input: z.object({ projectId: z.string().min(1), pooled: z.boolean() }),
    output: z.object({ pooled: z.boolean(), threads: z.number() }),
  },
  set_account: {
    input: z.object({ projectId: z.string().min(1), accountId: z.string().min(1), allowed: z.boolean() }),
    output: z.object({ pooled: z.boolean(), threads: z.number() }),
  },
});

const POOL = "account-pool";
const PLUGIN_ID = "project-accounts";
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
  ): Promise<ProjectAccount | null> {
    const view = await servingAccount(projectId, providerId, refresh);
    if (view === null) return null;
    const pooled = !(await readProjects()).includes(projectId);
    const accounts = view.provider === "claude" ? await projectPoolAccounts(projectId).catch(() => []) : [];
    return { ...view, pooled, accounts };
  }

  /** The login a project's threads use when they bypass the pool. */
  async function projectLogin(projectId: string): Promise<OwnLogin> {
    return (await readLogins())[projectId] ?? { configDir: `${homedir()}/.claude`, label: null };
  }

  function sameAccount(account: PoolAccount, view: AccountView): boolean {
    if (account.accountUuid && view.accountUuid) return account.accountUuid === view.accountUuid;
    return Boolean(account.email && view.email && account.email.toLowerCase() === view.email.toLowerCase());
  }

  /** <dataDir>/plugins/<this plugin>/ — the plugin's own data directory. */
  function ownDir(): string {
    return dirname(bb.storage.database().name);
  }

  // ---- Which pool accounts a project may use -----------------------------
  async function readAccess(): Promise<Record<string, string[]>> {
    const parsed = z.record(z.string(), z.array(z.string())).safeParse(await bb.storage.kv.get("access"));
    return parsed.success ? parsed.data : {};
  }
  async function writeAccess(access: Record<string, string[]>): Promise<void> {
    await bb.storage.kv.set("access", access);
  }

  interface AccessState {
    accounts: PoolAccount[];
    enabled: PoolAccount[];
    localId: string | null;
    where: string;
    allowed: Set<string>;
  }

  async function accessState(projectId: string): Promise<AccessState> {
    const [accounts, bypassed, local, access] = await Promise.all([
      poolAccounts().then((all) => all.filter((a) => a.provider === "claude")),
      readProjects().then((ids) => ids.includes(projectId)),
      projectLogin(projectId).then((login) => ownUsage(login, false)),
      readAccess(),
    ]);
    const enabled = accounts.filter((a) => a.enabled);
    const localId = accounts.find((a) => sameAccount(a, local))?.id ?? null;
    const stored = access[projectId]?.filter((id) => enabled.some((a) => a.id === id));
    const allowed = new Set(
      !bypassed ? enabled.map((a) => a.id) : stored && stored.length > 0 ? stored : localId ? [localId] : [],
    );
    const where = local.configDir?.replace(/^\/(Users|home)\/[^/]+/, "~") ?? "its login";
    return { accounts, enabled, localId, where, allowed };
  }

  /** Why a set of accounts cannot serve a project, or null when it can. */
  function refusal(_state: AccessState, next: Set<string>): string | null {
    return next.size === 0 ? "A project needs at least one account." : null;
  }

  async function projectPoolAccounts(projectId: string): Promise<ProjectPoolAccount[]> {
    const state = await accessState(projectId);
    return state.accounts.map((account) => {
      const allowed = account.enabled && state.allowed.has(account.id);
      const next = new Set(state.allowed);
      if (allowed) next.delete(account.id);
      else next.add(account.id);
      const hint = account.enabled ? refusal(state, next) : "Disabled in the Account Pooler.";
      return {
        id: account.id,
        label: account.label ?? account.email ?? "Pool account",
        email: account.email ?? null,
        enabledInPool: account.enabled,
        allowed,
        local: account.id === state.localId,
        toggleable: hint === null,
        hint,
      };
    });
  }

  /**
   * The accounts a limited project's requests go to through this plugin's
   * proxy, in pool priority order; null when the pool serves the project or
   * it runs on its own login alone. Runs on every provider command, so it
   * reads only local state.
   */
  async function routeAccounts(projectId: string): Promise<PoolAccount[] | null> {
    if (!(await readProjects()).includes(projectId)) return null;
    const ids = (await readAccess())[projectId];
    if (ids === undefined || ids.length === 0) return null;
    const accounts = (await poolAccounts())
      .filter((a) => a.provider === "claude" && a.enabled && ids.includes(a.id))
      .sort((a, b) => a.priority - b.priority || (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return accounts;
  }

  const proxy = createProxy({
    poolSecretsDir: join(dirname(ownDir()), POOL, "secrets", "accounts"),
    ownSecretsDir: join(ownDir(), "secrets"),
    accountsFor: async (projectId) =>
      (await routeAccounts(projectId))?.map((a) => ({
        id: a.id,
        accountUuid: a.accountUuid ?? null,
        label: a.label ?? a.email ?? a.id,
      })) ?? null,
    refresh: async (accountId) => {
      await bb.sdk.plugins.callRpc({
        pluginId: POOL,
        method: "account.refreshUsage",
        input: { accountId },
        outputSchema: z.unknown(),
      });
    },
    log: bb.log,
  });
  for (const path of PROXY_PATHS) {
    bb.http.route("POST", path, (c) => proxy.handle(c.req.raw, path), { auth: "none" });
  }

  /** Allow or disallow one pool account for a project. */
  async function setAccount(projectId: string, accountId: string, allowed: boolean) {
    const state = await accessState(projectId);
    const account = state.accounts.find((a) => a.id === accountId);
    if (account === undefined) throw new Error(`No Claude pool account ${accountId}.`);
    if (!account.enabled) throw new Error("Disabled in the Account Pooler.");
    const next = new Set(state.allowed);
    if (allowed) next.add(accountId);
    else next.delete(accountId);
    const why = refusal(state, next);
    if (why !== null) throw new Error(why);
    const pooled = next.size === state.enabled.length;
    const access = await readAccess();
    const [only] = [...next];
    if (pooled || (next.size === 1 && only === state.localId)) delete access[projectId];
    else access[projectId] = [...next];
    await writeAccess(access);
    return { pooled, threads: await setPooled(projectId, pooled) };
  }

  /**
   * The account a project's threads use: its own login while it bypasses the
   * pool, otherwise the pool's first ready account. A project login stays on
   * record while the project is pooled (its CLAUDE_CONFIG_DIR still holds the
   * sessions), but the pool serves the requests then.
   */
  async function servingAccount(
    projectId: string,
    providerId: string | null,
    refresh: boolean,
  ): Promise<AccountView | null> {
    const provider = providerId === "codex" ? "codex" : providerId === null || providerId === "claude-code" ? "claude" : null;
    if (provider === null) return null;
    const [bypassed, logins] = await Promise.all([readProjects(), readLogins()]);
    const login = logins[projectId];
    if (bypassed.includes(projectId)) {
      const routed = provider === "claude" ? await routeAccounts(projectId) : null;
      if (routed !== null && routed.length > 0) {
        if (refresh) await refreshPool(routed.map((a) => a.id));
        const fresh = await poolAccounts().catch(() => routed);
        const view = poolView(
          fresh.filter((a) => routed.some((r) => r.id === a.id)),
          "claude",
        );
        if (view !== null) {
          const names = routed.map((a) => a.email ?? a.label ?? a.id).join(", ");
          return {
            ...view,
            message: `Only ${names} — their pool logins, through Project Accounts. Sessions stay in ${(login?.configDir ?? `${homedir()}/.claude`).replace(/^\/(Users|home)\/[^/]+/, "~")}.`,
          };
        }
      }
      if (provider === "claude" && login !== undefined) return ownUsage(login, refresh);
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
    set_pooled: async ({ projectId, pooled }) => ({ pooled, threads: await setPooled(projectId, pooled) }),
    set_account: ({ projectId, accountId, allowed }) => setAccount(projectId, accountId, allowed),
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

  /** Route a project through the pool, or take it off; returns threads updated. */
  async function setPooled(projectId: string, pooled: boolean): Promise<number> {
    const projects = await readProjects();
    await writeProjects(pooled ? projects.filter((id) => id !== projectId) : [...projects, projectId]);
    if (pooled) {
      const access = await readAccess();
      if (projectId in access) {
        delete access[projectId];
        await writeAccess(access);
      }
    }
    bb.realtime.publish("accounts-changed", {});
    return reconcile(projectId, !pooled);
  }

  bb.events.on("thread.created", async ({ thread }) => {
    const projects = await readProjects();
    if (projects.includes(thread.projectId)) await ensureBypass(thread.id);
  });

  for (const providerId of PROVIDERS) {
    bb.providers.experimental_contributeEnv(providerId, async (context) => {
      if (context.projectId === null) return [];
      const projects = await readProjects();
      if (!projects.includes(context.projectId)) return [];
      if (context.threadId !== null) await ensureBypass(context.threadId);
      if (providerId !== "claude-code") return [];
      const routed = await routeAccounts(context.projectId).catch(() => null);
      if (routed === null) return [];
      const names = routed.map((a) => a.email ?? a.label ?? a.id).join(", ") || "no account";
      return [
        {
          name: "ANTHROPIC_BASE_URL",
          value: { serverPath: `/api/v1/plugins/${PLUGIN_ID}/http` },
          reason: `Project Accounts: this project uses only ${names}`,
        },
        { name: "ANTHROPIC_AUTH_TOKEN", value: await proxy.tokenFor(context.projectId), reason: "Project Accounts proxy token for this project" },
        {
          name: "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
          value: "1",
          reason: "Claude Code otherwise refreshes the project's own login while routed, which can spend its single-use refresh token",
        },
        { name: "ENABLE_TOOL_SEARCH", value: "true", reason: "Claude Code turns tool search off behind a custom base URL" },
        {
          name: "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
          value: "1",
          reason: "Claude Code limits Opus to a 200k context window behind a custom base URL; the proxy forwards to Anthropic's API",
        },
        { name: "ENABLE_PROMPT_CACHING_1H", value: "1", reason: "Subscription accounts get the 1-hour prompt cache" },
      ];
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
    if (match !== undefined) return match;
    // Projects bb does not list (the Personal workspace) still resolve by id.
    if (/^proj_[A-Za-z0-9_]+$/.test(wanted)) return { id: wanted, name: wanted };
    throw new Error(`No project matches "${wanted}".`);
  }

  const usage = [
    "Usage:",
    "  bb project-accounts list",
    "  bb project-accounts add <project-id|name>      # bypass the Account Pooler for its threads",
    "  bb project-accounts remove <project-id|name>   # route its threads through the pool again",
    "  bb project-accounts login <project> <config-dir> [--label <name>]   # the login to show and measure",
    "  bb project-accounts login <project> --clear",
    "  bb project-accounts show <project>              # account and usage right now",
    "  bb project-accounts accounts <project>          # pool accounts this project may use",
    "  bb project-accounts allow <project> <account>   # let the project use a pool account (id or email)",
    "  bb project-accounts deny <project> <account>    # stop the project using a pool account",
  ].join("\n");

  function describeAccounts(accounts: ProjectPoolAccount[]): string {
    if (accounts.length === 0) return "  No Claude accounts in the Account Pooler.";
    return accounts
      .map((a) => {
        const mark = a.allowed ? "[x]" : "[ ]";
        const extra = [
          a.local ? "project login" : null,
          a.enabledInPool ? null : "disabled in pool",
        ]
          .filter(Boolean)
          .join(", ");
        return `  ${mark} ${a.label}${a.email && a.email !== a.label ? ` <${a.email}>` : ""} (${a.id})${extra ? ` — ${extra}` : ""}`;
      })
      .join("\n");
  }

  async function findAccount(projectId: string, selector: string | undefined) {
    if (selector === undefined) throw new Error("Name an account: <id|email>.");
    const accounts = await projectPoolAccounts(projectId);
    const wanted = selector.toLowerCase();
    const match = accounts.find((a) => a.id === selector || a.email?.toLowerCase() === wanted || a.label.toLowerCase() === wanted);
    if (match === undefined) throw new Error(`No Claude pool account matches "${selector}".`);
    return match;
  }

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
      { name: "accounts", summary: "List the pool accounts a project may use", usage: "bb project-accounts accounts [<project>]" },
      { name: "allow", summary: "Let a project use a pool account", usage: "bb project-accounts allow <project> <account-id|email>" },
      { name: "deny", summary: "Stop a project using a pool account", usage: "bb project-accounts deny <project> <account-id|email>" },
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
            const count = await setPooled(project.id, false);
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
            const pool = view === null ? "" : `\nPool accounts:\n${describeAccounts(view.accounts)}`;
            return { exitCode: 0, stdout: `${project.name}\n${view === null ? "No account." : describe(view)}${pool}` };
          }
          case "accounts": {
            const project = await resolveProject(target, ctx.projectId);
            return { exitCode: 0, stdout: `${project.name}\n${describeAccounts(await projectPoolAccounts(project.id))}` };
          }
          case "allow":
          case "deny": {
            const project = await resolveProject(target, ctx.projectId);
            const account = await findAccount(project.id, extra);
            const result = await setAccount(project.id, account.id, command === "allow");
            const routing = result.pooled ? "all pool accounts (Account Pooler)" : "only the checked accounts (pool bypassed)";
            return {
              exitCode: 0,
              stdout: `${project.name}: ${routing}; ${result.threads} thread(s) updated.\n${describeAccounts(await projectPoolAccounts(project.id))}`,
            };
          }
          case "remove": {
            const project = await resolveProject(target, ctx.projectId);
            const count = await setPooled(project.id, true);
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
