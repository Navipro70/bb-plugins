## What you get

A **Ports** segment in the row above a thread's composer, beside the pull
request and changed-files segments. It names the dev servers the thread's
worktree is serving, such as `node :5173 · python :8060 · +2`, and appears
only while something is listening.

Click it to see every port with its process and pid:

- **Open** shows the server in the browser BB prefers.
- **Stop** sends SIGTERM to the listening process (or stops the Docker
  container behind a published port). A second click confirms.

Ports belong to a worktree, so the list also names the other threads working
in it, each a link to that thread.

## How it works

Thread Ports does no scanning of its own. The **Worktree Ports** plugin
already attributes every listening TCP port to the BB environment whose
worktree holds the process, and Thread Ports asks it for that listing every
few seconds while the segment is on screen. Stop goes through Worktree Ports
too, which re-scans and refuses a port that is not listening in that
worktree.

## Requirements

- The **Worktree Ports** plugin (BB Community). Without it the segment stays
  hidden.
- macOS or Linux, as Worktree Ports needs `lsof`.
- BB 0.50 or newer. The segment uses the experimental
  `experimental_threadContextSegment` slot, which may change between BB
  releases.
