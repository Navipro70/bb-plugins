Give some projects their own Claude or Codex login while the Account Pooler
keeps serving the rest.

## What you get

- Every thread of a listed project bypasses the Account Pooler automatically:
  new threads, resumed ones, and threads that already existed.
- Combine it with project environment variables (for example
  `CLAUDE_CONFIG_DIR`) to point those threads at a separate login.
- A chip in every Claude Code and Codex thread header and in the new-thread
  composer: which account serves the project (its own login or the Account
  Pooler) with a dot and the fullest window's percentage. Click it for the
  5-hour, weekly and per-model windows with reset times.
- Project logins appear in the Provider usage panel under "Project logins".
