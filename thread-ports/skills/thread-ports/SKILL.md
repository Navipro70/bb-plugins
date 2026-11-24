---
name: thread-ports
description: The Thread Ports plugin shows the ports a thread's worktree is serving in the row above the composer. Use when a user asks where a dev server started in a thread can be seen, opened or stopped.
---

# Thread Ports

The **Ports** segment in the context row above a thread's composer names the
servers listening in that thread's worktree, such as `vite :5173 · python
:8060`. Clicking it lists every port with **Open** (in the browser BB prefers)
and **Stop** (SIGTERM to the listening process, or the container for a Docker
port; a second click confirms).

- The data comes from the **Worktree Ports** plugin. Without it the segment
  stays hidden. Ask `bb ports list` (Worktree Ports) for the same listing in a
  terminal.
- Ports belong to a worktree, not to a single thread: every thread in that
  worktree shows the same ports, and the expanded list names the other threads.
- A server an agent starts stays visible to the user here, so start dev
  servers inside the thread's worktree and tell the user the port.
