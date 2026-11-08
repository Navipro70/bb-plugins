// A small Anthropic proxy for projects limited to some of the Account
// Pooler's Claude accounts.
//
// The pool's hub picks an account per request from every enabled account and
// does not know which project a request comes from, so it cannot be narrowed
// per project. Threads of such projects bypass the pool and send their
// requests here instead: each request goes to Anthropic with the access token
// of the first allowed account (pool priority order), and on a 429 to the next
// one. The tokens are the pool's own logins, read from its secret files and
// never refreshed here: refresh tokens are single-use, so the pool stays their
// only writer, and we ask it to refresh (account.refreshUsage) when a token is
// about to expire or Anthropic answers 401.
//
// A thread authenticates with a per-project bearer token,
// `<projectId>.<hmac>`, so the allowed accounts are read live on every
// request: switching accounts in the popover applies to the next request.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const PROXY_PATHS = ["/v1/messages", "/v1/messages/count_tokens"] as const;

const UPSTREAM = "https://api.anthropic.com";
const KEEP_HEADERS = new Set(["accept", "content-type", "user-agent", "x-app"]);
const KEEP_PREFIXES = ["anthropic-", "x-stainless-"];
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
const EXPIRY_SKEW_MS = 2 * 60_000;
const REFRESH_THROTTLE_MS = 30_000;

const secretSchema = z.looseObject({
  kind: z.literal("oauth"),
  accessToken: z.string().min(1),
  expiresAt: z.number().nullable().optional(),
});

export interface ProxyAccount {
  id: string;
  accountUuid: string | null;
  label: string;
}

export interface ProxyOptions {
  /** The Account Pooler's secrets/accounts directory. */
  poolSecretsDir: string;
  /** This plugin's own secrets directory (holds the HMAC key). */
  ownSecretsDir: string;
  /** Allowed accounts in try order, or null when the project is not limited. */
  accountsFor(projectId: string): Promise<ProxyAccount[] | null>;
  /** Ask the pool to refresh an account (its usage poll renews the token). */
  refresh(accountId: string): Promise<void>;
  log: { warn(message: string): void };
}

function errorResponse(status: number, message: string): Response {
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error";
  return Response.json({ type: "error", error: { type, message } }, { status });
}

/** Point metadata.user_id at the account that serves the request, as the pool's hub does. */
function forAccount(body: Uint8Array, accountUuid: string | null): Uint8Array {
  if (accountUuid === null) return body;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { metadata?: { user_id?: unknown } };
    const userId = parsed.metadata?.user_id;
    if (typeof userId !== "string") return body;
    let next: string | null = null;
    try {
      const inner = JSON.parse(userId) as Record<string, unknown>;
      if (inner && typeof inner === "object" && "account_uuid" in inner) {
        next = JSON.stringify({ ...inner, account_uuid: accountUuid });
      }
    } catch {
      const replaced = userId.replace(/_account_[0-9a-f-]{36}_/i, `_account_${accountUuid}_`);
      if (replaced !== userId) next = replaced;
    }
    if (next === null) return body;
    return new TextEncoder().encode(JSON.stringify({ ...parsed, metadata: { ...parsed.metadata, user_id: next } }));
  } catch {
    return body;
  }
}

export function createProxy(options: ProxyOptions) {
  let keyPromise: Promise<Buffer> | null = null;
  const lastRefresh = new Map<string, number>();

  function key(): Promise<Buffer> {
    keyPromise ??= (async () => {
      const path = join(options.ownSecretsDir, "proxy-key");
      try {
        const existing = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
        if (existing.length >= 32) return existing;
      } catch {
        // first use: create below
      }
      const fresh = randomBytes(32);
      await mkdir(options.ownSecretsDir, { recursive: true, mode: 0o700 });
      await writeFile(path, `${fresh.toString("base64url")}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      return fresh;
    })();
    keyPromise.catch(() => {
      keyPromise = null;
    });
    return keyPromise;
  }

  function sign(secret: Buffer, projectId: string): string {
    return createHmac("sha256", secret).update(projectId).digest("base64url");
  }

  async function tokenFor(projectId: string): Promise<string> {
    return `${projectId}.${sign(await key(), projectId)}`;
  }

  async function authenticate(request: Request): Promise<string | null> {
    const header = request.headers.get("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : request.headers.get("x-api-key");
    if (!bearer) return null;
    const dot = bearer.lastIndexOf(".");
    if (dot <= 0) return null;
    const projectId = bearer.slice(0, dot);
    const given = Buffer.from(bearer.slice(dot + 1));
    const expected = Buffer.from(sign(await key(), projectId));
    return given.length === expected.length && timingSafeEqual(given, expected) ? projectId : null;
  }

  async function readSecret(accountId: string) {
    if (!/^[A-Za-z0-9-]+$/.test(accountId)) return null;
    try {
      const parsed = secretSchema.safeParse(
        JSON.parse(await readFile(join(options.poolSecretsDir, `account-${accountId}.json`), "utf8")),
      );
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function refresh(accountId: string, force: boolean): Promise<void> {
    const last = lastRefresh.get(accountId) ?? 0;
    if (!force && Date.now() - last < REFRESH_THROTTLE_MS) return;
    lastRefresh.set(accountId, Date.now());
    await options.refresh(accountId).catch((error) =>
      options.log.warn(`pool refresh for ${accountId} failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  async function accessToken(accountId: string): Promise<string | null> {
    let secret = await readSecret(accountId);
    if (secret?.expiresAt != null && secret.expiresAt - Date.now() < EXPIRY_SKEW_MS) {
      await refresh(accountId, false);
      secret = await readSecret(accountId);
    }
    return secret?.accessToken ?? null;
  }

  function upstreamHeaders(request: Request, token: string): Headers {
    const headers = new Headers();
    request.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (KEEP_HEADERS.has(lower) || KEEP_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        headers.set(lower, value);
      }
    });
    headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  function relay(response: Response): Response {
    const headers = new Headers();
    response.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    });
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  async function handle(request: Request, path: string): Promise<Response> {
    const projectId = await authenticate(request);
    if (projectId === null) return errorResponse(401, "Project Accounts: invalid proxy token.");
    const accounts = await options.accountsFor(projectId).catch(() => null);
    if (accounts === null || accounts.length === 0) {
      return errorResponse(503, "Project Accounts: this project has no allowed Claude account; check the account chip.");
    }
    const body = new Uint8Array(await request.arrayBuffer());
    const search = new URL(request.url).search;
    let last: Response | null = null;
    for (const [index, account] of accounts.entries()) {
      const payload = forAccount(body, account.accountUuid);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await accessToken(account.id);
        if (token === null) break;
        let response: Response;
        try {
          response = await fetch(`${UPSTREAM}${path}${search}`, {
            method: "POST",
            headers: upstreamHeaders(request, token),
            body: Buffer.from(payload),
            signal: request.signal,
          });
        } catch (error) {
          if (request.signal.aborted) throw error;
          return errorResponse(502, `Project Accounts: Anthropic is unreachable (${String(error)}).`);
        }
        if (response.status === 401 && attempt === 0) {
          await response.body?.cancel();
          await refresh(account.id, true);
          continue;
        }
        if (response.status === 429 && index < accounts.length - 1) {
          await response.body?.cancel();
          last = null;
          break;
        }
        return relay(response);
      }
    }
    return last ?? errorResponse(503, "Project Accounts: no allowed account has a usable pool login.");
  }

  return { handle, tokenFor };
}
