## What you get

Every dev server a BB thread started, named after that thread, with the
actions you need one click away.

- **Ports in the sidebar footer.** One card per thread that is serving
  something: the thread title (click it, or **Thread →**, to jump there), its
  project and branch, and a row per port such as `:5173 vite`. Each row has
  **Open** (in the browser BB prefers), **Copy** (the localhost URL), and
  **Stop**, which asks once more before it stops the server. A **LAN** chip
  marks a port reachable from your network and copies its address, for
  opening the server on a phone.
- **Above the composer.** A thread that started servers shows them in the
  row beside the pull request and changed files, `vite :5173 · python
  http.server :8060`. Click it for the same rows.
- **In the thread list.** A plug glyph marks threads that are serving.
- **`bb thread-ports`** lists the same thing in a terminal, and
  `bb thread-ports stop <port>` stops one, so agents can use it too.

Agent tools such as MCP servers fold behind a toggle, and a server whose
thread was deleted shows under **Deleted thread**.

## How it works

Agents start processes with `BB_THREAD_ID` in their environment, and every
child inherits it. A host worker on each machine lists listening TCP ports
with `lsof`, reads that variable from each process (`ps -E` on macOS,
`/proc` on Linux), and also attributes a server started by hand inside a
BB workspace by its working directory. Nothing else on the machine (AirPlay,
editors, bb itself) is listed.

Stop re-checks that the same process (pid and start time) still holds the
port, sends SIGTERM, and offers **Force kill** if it does not exit.

## Requirements

- macOS or Linux, with `lsof` and `ps`.
- BB 0.50 or newer. The panel, the context-row segment and the row glyph use
  experimental SDK slots that may change between BB releases.
