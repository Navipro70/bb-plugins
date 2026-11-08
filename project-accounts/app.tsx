// Project Accounts — frontend.
//
// A chip in every Claude Code / Codex thread header and in the new-thread
// composer: which account serves this project (its own login or the Account
// Pooler) and how much of its 5-hour and weekly windows is used. Click it for
// every window with reset times, a refresh, and the Account Pooler's Claude
// accounts with a switch each: which of them this project may use.
import { useCallback, useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  definePluginApp,
  experimental_Icon as Icon,
  useComposer,
  useRealtime,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { UsageWindow } from "./accounts";
import type { ProjectAccount as AccountView, ProjectPoolAccount, rpcContract } from "./server";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

const POLL_MS = 2 * 60_000;

function useAccountView(projectId: string | null, providerId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<AccountView | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    (refresh: boolean) => {
      if (projectId === null) return;
      setLoading(true);
      rpc
        .call("account_view", { projectId, providerId, refresh })
        .then(setView, () => {})
        .finally(() => setLoading(false));
    },
    [rpc, projectId, providerId],
  );
  useEffect(() => {
    setView(null);
    load(false);
    const timer = window.setInterval(() => load(false), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  useRealtime("accounts-changed", () => load(false));
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setAccount = useCallback(
    (accountId: string, allowed: boolean) => {
      if (projectId === null) return;
      setSwitching(accountId);
      setError(null);
      rpc
        .call("set_account", { projectId, accountId, allowed })
        .then(
          () => load(false),
          (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
        )
        .finally(() => setSwitching(null));
    },
    [rpc, projectId, load],
  );
  return { view, loading, refresh: () => load(true), switching, error, setAccount };
}

/** The window that binds first: the fullest of the 5-hour and weekly ones. */
function headline(view: AccountView): UsageWindow | null {
  const general = view.windows.filter((w) => w.model === null);
  const pool = general.length > 0 ? general : view.windows;
  return pool.reduce<UsageWindow | null>(
    (worst, w) => (worst === null || w.usedPercent > worst.usedPercent ? w : worst),
    null,
  );
}

function tone(percent: number | null, status: AccountView["status"]) {
  if (status === "missing" || status === "unauthenticated") return "bg-red-500";
  if (percent === null) return "bg-muted-foreground/50";
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function shortName(view: AccountView): string {
  if (view.source === "own") return view.label;
  if (view.source === "local") return view.provider === "codex" ? "Codex login" : "Machine login";
  const name = view.email?.split("@")[0] ?? view.label;
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

function relative(ms: number, now: number): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const text =
    minutes < 60
      ? `${minutes}m`
      : minutes < 48 * 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${Math.round(minutes / 1440)}d`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

const SOURCE_LABEL: Record<AccountView["source"], string> = {
  own: "Project login",
  pool: "Account Pooler",
  local: "Machine login",
};

function WindowRow({ window: w, now }: { window: UsageWindow; now: number }) {
  const used = Math.max(0, Math.min(100, w.usedPercent));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-foreground">{w.label}</span>
        <span className="tabular-nums text-muted-foreground">
          {Math.round(w.usedPercent)}%
          {w.resetsAt !== null ? ` · resets ${relative(w.resetsAt, now)}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", tone(used, "ok"))}
          style={{ width: `${used}%` }}
        />
      </div>
    </div>
  );
}

function Switch({
  checked,
  disabled,
  label,
  title,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-3 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-3.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function PoolAccounts({
  accounts,
  pooled,
  switching,
  error,
  onChange,
}: {
  accounts: ProjectPoolAccount[];
  pooled: boolean;
  switching: string | null;
  error: string | null;
  onChange: (accountId: string, allowed: boolean) => void;
}) {
  if (accounts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">Accounts for this project</span>
        <span className="text-[11px] text-muted-foreground">{pooled ? "Account Pooler" : "Own login only"}</span>
      </div>
      {accounts.map((account) => (
        <div key={account.id} className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3" title={account.hint ?? undefined}>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={cn("truncate text-xs", account.allowed ? "text-foreground" : "text-muted-foreground")}>
              {account.label}
              {account.local ? <span className="ml-1.5 text-[11px] text-muted-foreground">project login</span> : null}
            </span>
            {account.email && account.email !== account.label ? (
              <span className="truncate text-[11px] text-muted-foreground">{account.email}</span>
            ) : null}
          </div>
          <Switch
            checked={account.allowed}
            disabled={switching !== null || !account.toggleable}
            label={`Use ${account.email ?? account.label} in this project`}
            title={account.hint ?? undefined}
            onChange={(allowed) => onChange(account.id, allowed)}
          />
        </div>
        {!account.toggleable && account.hint && account.enabledInPool ? (
          <span className="text-[11px] text-muted-foreground">{account.hint}</span>
        ) : null}
        </div>
      ))}
      {error ? <p className="text-[11px] text-amber-600 dark:text-amber-400">{error}</p> : null}
    </div>
  );
}

function AccountChip({
  view,
  loading,
  onRefresh,
  switching,
  error,
  onSetAccount,
  compact = false,
}: {
  view: AccountView;
  loading: boolean;
  onRefresh: () => void;
  switching: string | null;
  error: string | null;
  onSetAccount: (accountId: string, allowed: boolean) => void;
  compact?: boolean;
}) {
  const portalProps = usePortalScopeProps();
  const top = headline(view);
  const percent = top === null ? null : Math.round(top.usedPercent);
  const now = Date.now();
  const name = shortName(view);
  const label = `${SOURCE_LABEL[view.source]}: ${view.email ?? view.label}${
    percent === null ? "" : `, ${percent}% of ${top?.label.toLowerCase()} used`
  }`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="flex h-7 max-w-56 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-state-active data-[state=open]:text-foreground"
        >
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", tone(percent, view.status))} />
          {view.source === "pool" ? (
            <Icon name="Layers" aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
          ) : null}
          {compact ? null : <span className="min-w-0 truncate">{name}</span>}
          {percent !== null ? <span className="shrink-0 tabular-nums">{percent}%</span> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalProps}
          align="end"
          sideOffset={6}
          className="z-50 flex w-72 flex-col gap-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md outline-none"
        >
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium">
                {view.label}
                {view.plan ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{view.plan}</span> : null}
              </span>
              {view.email ? <span className="truncate text-xs text-muted-foreground">{view.email}</span> : null}
              <span className="text-xs text-muted-foreground">
                {SOURCE_LABEL[view.source]}
                {view.organization && view.organization !== view.label ? ` · ${view.organization}` : ""}
              </span>
            </div>
            <button
              type="button"
              aria-label="Refresh usage"
              title="Refresh usage"
              disabled={loading}
              onClick={onRefresh}
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 [&_[data-icon-root]]:size-3.5"
            >
              <Icon name="RefreshCw" aria-hidden="true" className={cn(loading && "animate-spin")} />
            </button>
          </div>
          {view.windows.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              {view.windows.map((w) => (
                <WindowRow key={w.id} window={w} now={now} />
              ))}
            </div>
          ) : view.source !== "local" ? (
            <span className="text-xs text-muted-foreground">No usage observed yet.</span>
          ) : null}
          {view.message ? (
            <p
              className={cn(
                "text-xs",
                view.status === "ok" ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400",
              )}
            >
              {view.message}
            </p>
          ) : null}
          {view.configDir ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={view.configDir}>
              {view.configDir.replace(/^\/(Users|home)\/[^/]+/, "~")}
            </span>
          ) : null}
          {view.observedAt !== null ? (
            <span className="text-[11px] text-muted-foreground">Measured {relative(view.observedAt, now)}</span>
          ) : null}
          <PoolAccounts
            accounts={view.accounts}
            pooled={view.pooled}
            switching={switching}
            error={error}
            onChange={onSetAccount}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const ACCOUNT_PROVIDERS = new Set(["claude-code", "codex"]);
const providerCache = new Map<string, string>();

function ThreadAccount({ threadId, projectId }: { threadId: string; projectId: string }) {
  const sdk = useSdk();
  const [providerId, setProviderId] = useState<string | null>(providerCache.get(threadId) ?? null);
  useEffect(() => {
    let live = true;
    const known = providerCache.get(threadId);
    setProviderId(known ?? null);
    if (known !== undefined) return;
    sdk.threads.get({ threadId }).then(
      (thread) => {
        providerCache.set(threadId, thread.providerId);
        if (live) setProviderId(thread.providerId);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sdk, threadId]);
  const supported = providerId !== null && ACCOUNT_PROVIDERS.has(providerId);
  const { view, loading, refresh, switching, error, setAccount } = useAccountView(supported ? projectId : null, providerId);
  if (!supported || view === null) return null;
  return (
    <AccountChip
      view={view}
      loading={loading}
      onRefresh={refresh}
      switching={switching}
      error={error}
      onSetAccount={setAccount}
    />
  );
}

function NewThreadAccount() {
  const composer = useComposer();
  const projectId = composer.scope.kind === "new-thread" ? composer.scope.projectId : null;
  const providerId = composer.selection?.providerId ?? null;
  const supported = providerId === null || ACCOUNT_PROVIDERS.has(providerId);
  const { view, loading, refresh, switching, error, setAccount } = useAccountView(supported ? projectId : null, providerId);
  if (!supported || view === null) return null;
  return (
    <AccountChip
      view={view}
      loading={loading}
      onRefresh={refresh}
      switching={switching}
      error={error}
      onSetAccount={setAccount}
      compact={composer.layout === "compact"}
    />
  );
}

export default definePluginApp((app) => {
  const slots = app.slots as typeof app.slots & {
    experimental_threadHeaderAction?: (registration: {
      id: string;
      title: string;
      component: typeof ThreadAccount;
    }) => void;
  };
  if (typeof slots.experimental_threadHeaderAction === "function") {
    slots.experimental_threadHeaderAction({
      id: "account",
      title: "Account and usage",
      component: ThreadAccount,
    });
  }
  app.composer.customize({
    id: "account",
    scopes: ["new-thread"],
    actions: [{ id: "account", component: NewThreadAccount }],
  });
});
