# Project Accounts

Give some projects their own Claude or Codex login while the Account Pooler
keeps serving the rest, and see which account serves each thread with its
usage limits.

## Use

- **Bypass the pool per project.** Every thread of a listed project bypasses
  the Account Pooler: new threads, resumed ones, and threads that already
  existed. The bypass applies on creation and on every provider command.
- **Point the project at its own login** with project environment variables,
  for example a separate `CLAUDE_CONFIG_DIR`:

  ```sh
  printf '%s' "$HOME/.claude-other" | bb machine env set CLAUDE_CONFIG_DIR --project <id>
  ```

- **See the account.** A chip in every Claude Code and Codex thread header and
  in the new-thread composer shows which account serves the project (its own
  login or the Account Pooler), with a dot and the fullest window's
  percentage. Click it for the 5-hour, weekly, and per-model windows with
  reset times, and for the Account Pooler's Claude accounts with a switch
  each.
- **Accounts per project.** Check any set of the pool's Claude accounts:
  - all of them: the Account Pooler serves the project;
  - only the account of the project's own login: the pool is bypassed and
    Claude Code uses that login directly;
  - any other set: the pool is bypassed and the plugin's proxy sends the
    project's requests with those accounts' pool logins, in pool priority
    order, moving to the next account on a 429.

  Switching never moves sessions or memory: nothing changes
  `CLAUDE_CONFIG_DIR`. The proxy reads the pool's access tokens and never
  refreshes them; it asks the pool to (refresh tokens are single-use).
- **Provider usage.** Project logins appear in the Provider usage panel under
  "Project logins".

## CLI

```sh
bb project-accounts list
bb project-accounts add <project-id|name>
bb project-accounts remove <project-id|name>

# Tell the plugin which login a project uses, so headers and usage show it
bb project-accounts login <project> ~/.claude-other --label "Org name"
bb project-accounts show <project> [--refresh]
bb project-accounts login <project> --clear

# Pool accounts a project may use
bb project-accounts accounts <project>
bb project-accounts allow <project> <account-id|email>
bb project-accounts deny <project> <account-id|email>
```

The bundled skill teaches agents the same commands. Inspect one thread with
`bb pool status` (routed threads) or the thread's `provider.env-resolved`
timeline event.

## How it works

The plugin applies the Account Pooler's per-thread bypass to every thread of
the listed projects, so their provider uses its own credentials. Usage is
read-only from Anthropic's OAuth usage endpoint with the login's own token;
an expired token is reported, not refreshed (Claude Code renews it on its next
turn). Projects without a login show the Account Pooler's first ready
account. Tokens are read on this machine and never stored by the plugin.

## Install

Needs BB 0.48 or later and the Account Pooler.

```sh
bb marketplace add git:https://github.com/Navipro70/bb-plugins.git@main
bb plugin install project-accounts@navipro-plugins
```

From a checkout of this directory: `npm ci`, then `bb plugin install .`.

## Development

```sh
npm ci
npm run typecheck
npm run build
bb plugin reload project-accounts
```
