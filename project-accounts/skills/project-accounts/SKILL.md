---
name: project-accounts
description: "Keep a project's threads off the Account Pooler so they use that project's own Claude/Codex login (e.g. a project-scoped CLAUDE_CONFIG_DIR), with `bb project-accounts`."
---

# Project Accounts

The Account Pooler routes every Claude Code and Codex thread through the shared
pool. Project Accounts applies the pool's per-thread bypass to every thread of
the listed projects (on creation, on every provider command, and for existing
threads), so they use their own provider credentials.

```sh
bb project-accounts list
bb project-accounts add <project-id|name>
bb project-accounts remove <project-id|name>
```

Per account, with the same rules as the switches in the account chip's
popover:

```sh
bb project-accounts accounts <project>
bb project-accounts allow <project> <account-id|email>
bb project-accounts deny <project> <account-id|email>
```

Any non-empty set works: all accounts (the pool serves the project), only the
project's own login (pool bypassed), or any other set (pool bypassed; the
plugin's proxy sends requests with those accounts' pool logins, in priority
order). Nothing changes `CLAUDE_CONFIG_DIR`, so switching keeps sessions and
memory.

Pair it with project-scoped environment variables that select the login:

```sh
printf '%s' "$HOME/.claude-other" | bb machine env set CLAUDE_CONFIG_DIR --project <id>
```

Inspect one thread with `bb pool status` (routed threads) or the thread's
`provider.env-resolved` timeline event.

## Showing the account and its limits

Tell the plugin which login a project uses so headers, the new-thread composer
and the Provider usage panel show it and its usage:

```sh
bb project-accounts login <project> ~/.claude-other --label "Org name"
bb project-accounts show <project> [--refresh]
bb project-accounts login <project> --clear
```

Usage is read-only from Anthropic's OAuth usage endpoint; an expired token is
reported, not refreshed (Claude Code renews it on the next turn). Projects
without a login show the Account Pooler's first ready account.
