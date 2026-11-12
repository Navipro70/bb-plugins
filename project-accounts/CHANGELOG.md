# Changelog

## 0.2.1 (2026-11-09)

- The account chip's popover lists the Account Pooler's Claude accounts with
  a switch each, for any combination: all of them (the pool serves the
  project), only the project's own login (pool bypassed), or any other set,
  served by a small proxy in this plugin with those accounts' pool logins
  (priority order, next account on 429). Sessions stay in the project's
  `CLAUDE_CONFIG_DIR`. The pool stays the only one that refreshes its logins.
- `bb project-accounts accounts|allow|deny`; `show` lists the accounts.
- Projects bb does not list, such as the Personal workspace, resolve by id.
- A pooled project's chip shows the pool account even when it has a project
  login on record.
- The default login (`~/.claude`) is recognised: its profile lives in
  `~/.claude.json`.

## 0.2.0 (2026-11-07)

- First release in this repository: listed projects bypass the Account
  Pooler; an account chip with usage windows in thread headers and the
  new-thread composer; project logins in the Provider usage panel; the
  `bb project-accounts` CLI.
