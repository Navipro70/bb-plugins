// Which account serves a project, and how much of it is left.
//
// A project listed with its own login (a CLAUDE_CONFIG_DIR) reads that login's
// OAuth token where Claude Code keeps it and asks Anthropic's usage endpoint,
// the one the CLI itself calls. Read-only: an expired token is reported, never
// refreshed here (the refresh token rotates; Claude Code renews it on the
// project's next turn). Every other project is served by the Account Pooler,
// whose own account list already carries observed usage.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USER_AGENT = "bb-plugin-project-accounts/0.2";
const CACHE_MS = 3 * 60_000;
const MIN_REFRESH_MS = 30_000;

export const windowSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["five-hour", "weekly", "custom"]),
  model: z.string().nullable(),
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
});
export type UsageWindow = z.infer<typeof windowSchema>;

export const accountViewSchema = z.object({
  /** own: the project's login; pool: Account Pooler; local: machine login, pool off. */
  source: z.enum(["own", "pool", "local"]),
  provider: z.enum(["claude", "codex"]),
  label: z.string(),
  email: z.string().nullable(),
  organization: z.string().nullable(),
  plan: z.string().nullable(),
  configDir: z.string().nullable(),
  accountUuid: z.string().nullable(),
  status: z.enum(["ok", "expired", "unauthenticated", "missing", "error"]),
  message: z.string().nullable(),
  windows: z.array(windowSchema),
  observedAt: z.number().nullable(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

export interface OwnLogin {
  configDir: string;
  label: string | null;
}

function keychainService(configDir: string): string {
  const normalized = configDir.normalize("NFC");
  if (normalized === join(homedir(), ".claude")) return KEYCHAIN_SERVICE;
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${hash}`;
}

function security(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      args,
      { maxBuffer: 1 << 20, timeout: 10_000, killSignal: "SIGKILL" },
      (error, stdout) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : -1;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
  });
}

const credentialsSchema = z.looseObject({
  claudeAiOauth: z.looseObject({
    accessToken: z.string().min(1),
    expiresAt: z.number().optional(),
    subscriptionType: z.string().nullable().optional(),
  }),
});

async function readCredentials(configDir: string) {
  let raw: string | null;
  if (platform() === "darwin") {
    const service = keychainService(configDir);
    const result = await security(["find-generic-password", "-a", userInfo().username, "-w", "-s", service]);
    if (result.code === 44) raw = null;
    else if (result.code !== 0) throw new Error(`keychain read failed (${result.code})`);
    else raw = result.stdout;
  } else {
    raw = await readFile(join(configDir, ".credentials.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }
  if (raw === null) return null;
  const parsed = credentialsSchema.safeParse(JSON.parse(raw.trim()));
  return parsed.success ? parsed.data.claudeAiOauth : null;
}

const profileSchema = z.looseObject({
  oauthAccount: z
    .looseObject({
      emailAddress: z.string().optional(),
      organizationName: z.string().optional(),
      accountUuid: z.string().optional(),
    })
    .optional(),
});

async function readProfile(configDir: string) {
  try {
    const parsed = profileSchema.safeParse(
      JSON.parse(await readFile(join(configDir, ".claude.json"), "utf8")),
    );
    return parsed.success ? (parsed.data.oauthAccount ?? null) : null;
  } catch {
    return null;
  }
}

const bucketSchema = z
  .looseObject({
    utilization: z.number().nullable().optional(),
    resets_at: z.string().nullable().optional(),
    locked_reason: z.string().nullable().optional(),
  })
  .nullable()
  .optional();
const usagePayloadSchema = z.looseObject({
  five_hour: bucketSchema,
  seven_day: bucketSchema,
  limits: z
    .array(
      z.looseObject({
        kind: z.string(),
        percent: z.number(),
        resets_at: z.string().nullable().optional(),
        scope: z
          .looseObject({
            model: z.looseObject({ display_name: z.string() }).nullable().optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .optional(),
});

function parseTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseUsage(payload: unknown): UsageWindow[] {
  const data = usagePayloadSchema.parse(payload);
  const windows: UsageWindow[] = [];
  const session = data.limits?.find((limit) => limit.kind === "session");
  const weekly = data.limits?.find((limit) => limit.kind === "weekly_all");
  const fiveHour =
    session !== undefined
      ? { used: session.percent, reset: parseTime(session.resets_at) }
      : typeof data.five_hour?.utilization === "number"
        ? { used: data.five_hour.utilization, reset: parseTime(data.five_hour.resets_at) }
        : null;
  const sevenDay =
    weekly !== undefined
      ? { used: weekly.percent, reset: parseTime(weekly.resets_at) }
      : typeof data.seven_day?.utilization === "number"
        ? { used: data.seven_day.utilization, reset: parseTime(data.seven_day.resets_at) }
        : null;
  if (fiveHour !== null) {
    windows.push({ id: "five-hour", label: "5-hour session", kind: "five-hour", model: null, usedPercent: fiveHour.used, resetsAt: fiveHour.reset });
  }
  if (sevenDay !== null) {
    windows.push({ id: "weekly", label: "Weekly", kind: "weekly", model: null, usedPercent: sevenDay.used, resetsAt: sevenDay.reset });
  }
  for (const limit of data.limits ?? []) {
    const model = limit.scope?.model?.display_name;
    if (limit.kind !== "weekly_scoped" || model === undefined) continue;
    windows.push({ id: `weekly:${model}`, label: `Weekly · ${model}`, kind: "weekly", model, usedPercent: limit.percent, resetsAt: parseTime(limit.resets_at) });
  }
  return windows;
}

function shortPlan(subscription: string | null | undefined): string | null {
  if (!subscription) return null;
  return subscription.charAt(0).toUpperCase() + subscription.slice(1);
}

/** Usage of one CLAUDE_CONFIG_DIR login, cached per directory. */
export function createOwnUsage(log: { warn(message: string): void }) {
  const cache = new Map<string, { view: AccountView; at: number; lastOk: AccountView | null }>();
  const inflight = new Map<string, Promise<AccountView>>();

  async function collect(login: OwnLogin): Promise<AccountView> {
    const profile = await readProfile(login.configDir);
    const base: AccountView = {
      source: "own",
      provider: "claude",
      label: login.label ?? profile?.organizationName ?? login.configDir.split("/").pop() ?? login.configDir,
      email: profile?.emailAddress ?? null,
      organization: profile?.organizationName ?? null,
      plan: null,
      configDir: login.configDir,
      accountUuid: profile?.accountUuid ?? null,
      status: "ok",
      message: null,
      windows: [],
      observedAt: null,
    };
    const previous = cache.get(login.configDir)?.lastOk ?? null;
    const stale = (status: AccountView["status"], message: string): AccountView => ({
      ...base,
      status,
      message,
      windows: previous?.windows ?? [],
      observedAt: previous?.observedAt ?? null,
    });
    let credentials;
    try {
      credentials = await readCredentials(login.configDir);
    } catch (error) {
      return stale("error", error instanceof Error ? error.message : String(error));
    }
    if (credentials === null) {
      return stale("missing", `No Claude Code login in ${login.configDir}. Run \`CLAUDE_CONFIG_DIR=${login.configDir} claude\` and log in.`);
    }
    base.plan = shortPlan(credentials.subscriptionType);
    if (credentials.expiresAt !== undefined && credentials.expiresAt < Date.now()) {
      return stale("expired", "The login's token expired; Claude Code renews it on the project's next turn.");
    }
    let response: Response;
    try {
      response = await fetch(USAGE_URL, {
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      return stale("error", error instanceof Error ? error.message : String(error));
    }
    if (response.status === 401) return stale("unauthenticated", "Anthropic refused the login; log in again with this config dir.");
    if (response.status === 429) return stale("error", "Usage endpoint is rate limited; showing the last reading.");
    if (!response.ok) return stale("error", `Usage endpoint returned ${response.status}.`);
    try {
      return { ...base, windows: parseUsage(await response.json()), observedAt: Date.now() };
    } catch (error) {
      log.warn(`usage payload for ${login.configDir}: ${String(error)}`);
      return stale("error", "Usage endpoint answered in an unknown format.");
    }
  }

  return async function get(login: OwnLogin, refresh: boolean): Promise<AccountView> {
    const cached = cache.get(login.configDir);
    const age = cached === undefined ? Infinity : Date.now() - cached.at;
    if (cached !== undefined && (age < MIN_REFRESH_MS || (!refresh && age < CACHE_MS))) {
      return { ...cached.view, label: login.label ?? cached.view.label };
    }
    const running = inflight.get(login.configDir);
    if (running !== undefined) return running;
    const task = collect(login)
      .then((view) => {
        cache.set(login.configDir, {
          view,
          at: Date.now(),
          lastOk: view.status === "ok" ? view : (cached?.lastOk ?? null),
        });
        return view;
      })
      .finally(() => inflight.delete(login.configDir));
    inflight.set(login.configDir, task);
    return task;
  };
}

// ---- Account Pooler ------------------------------------------------------

const familyWindowSchema = z
  .looseObject({
    utilization: z.number().nullable().optional(),
    resetAt: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

export const poolAccountSchema = z.looseObject({
  id: z.string(),
  provider: z.string(),
  label: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  accountUuid: z.string().nullable().optional(),
  subscriptionType: z.string().nullable().optional(),
  enabled: z.boolean(),
  priority: z.number(),
  createdAt: z.number().optional(),
  status: z.string().optional(),
  error: z.unknown().optional(),
  fiveHourUtilization: z.number().nullable().optional(),
  fiveHourResetAt: z.number().nullable().optional(),
  sevenDayUtilization: z.number().nullable().optional(),
  sevenDayResetAt: z.number().nullable().optional(),
  familyWeekly: z.record(z.string(), familyWindowSchema).nullable().optional(),
  limitWindows: z
    .array(
      z.looseObject({
        slot: z.string().optional(),
        windowMinutes: z.number().nullable().optional(),
        utilization: z.number().nullable().optional(),
        resetAt: z.number().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  observedAt: z.number().nullable().optional(),
});
export type PoolAccount = z.infer<typeof poolAccountSchema>;

const pct = (fraction: number) => Math.round(fraction * 1000) / 10;

function poolWindows(account: PoolAccount): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (typeof account.fiveHourUtilization === "number") {
    windows.push({ id: "five-hour", label: "5-hour session", kind: "five-hour", model: null, usedPercent: pct(account.fiveHourUtilization), resetsAt: account.fiveHourResetAt ?? null });
  }
  if (typeof account.sevenDayUtilization === "number") {
    windows.push({ id: "weekly", label: "Weekly", kind: "weekly", model: null, usedPercent: pct(account.sevenDayUtilization), resetsAt: account.sevenDayResetAt ?? null });
  }
  for (const [family, window] of Object.entries(account.familyWeekly ?? {})) {
    if (window === null || window === undefined || typeof window.utilization !== "number") continue;
    const model = family.charAt(0).toUpperCase() + family.slice(1);
    windows.push({ id: `weekly:${family}`, label: `Weekly · ${model}`, kind: "weekly", model, usedPercent: pct(window.utilization), resetsAt: window.resetAt ?? null });
  }
  for (const window of account.limitWindows ?? []) {
    if (typeof window.utilization !== "number") continue;
    const fiveHour = window.windowMinutes === 300;
    const weekly = window.windowMinutes === 10080;
    windows.push({
      id: `limit:${window.slot ?? window.windowMinutes}`,
      label: fiveHour ? "5-hour session" : weekly ? "Weekly" : `${window.windowMinutes ?? "?"}-minute window`,
      kind: fiveHour ? "five-hour" : weekly ? "weekly" : "custom",
      model: null,
      usedPercent: pct(window.utilization),
      resetsAt: window.resetAt ?? null,
    });
  }
  return windows;
}

/** The account the pool hands the next turn: first ready one by priority. */
export function poolView(accounts: readonly PoolAccount[], provider: "claude" | "codex"): AccountView | null {
  const candidates = accounts
    .filter((account) => account.provider === provider && account.enabled)
    .sort((a, b) => a.priority - b.priority || (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const account = candidates.find((candidate) => candidate.status === "ready") ?? candidates[0];
  if (account === undefined) return null;
  const email = account.email ?? null;
  return {
    source: "pool",
    provider,
    label: account.label ?? email ?? "Pool account",
    email,
    organization: null,
    plan: shortPlan(account.subscriptionType),
    configDir: null,
    accountUuid: account.accountUuid ?? null,
    status: account.status === "ready" || account.status === undefined ? "ok" : "error",
    message:
      account.status === "ready" || account.status === undefined
        ? candidates.length > 1
          ? `${candidates.length} pooled accounts; the pool fails over by priority.`
          : null
        : `Pool account is ${account.status}.`,
    windows: poolWindows(account),
    observedAt: account.observedAt ?? null,
  };
}
