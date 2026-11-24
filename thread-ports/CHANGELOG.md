# Changelog

## 0.2.0 (2026-11-24)

- Ports are attributed to the exact thread that started them, from the
  `BB_THREAD_ID` each agent process inherits, by Thread Ports' own host
  worker. Worktree Ports is no longer needed.
- **Ports** panel in the sidebar footer: one card per serving thread with a
  jump to the thread, and Open, Copy, Stop (with confirm and Force kill) on
  every row. A LAN chip copies the network address of a port reachable from
  other devices.
- The segment above the composer shows the thread's own servers with the
  same rows; a plug glyph marks serving threads in the thread list.
- `bb thread-ports list` and `bb thread-ports stop <port>`.
- Agent tools (MCP, language servers, adb) fold behind a toggle; servers whose
  thread was deleted show under Deleted thread.

## 0.1.0 (2026-11-24)

- First release: a **Ports** segment above a thread's composer that names the
  servers its worktree is serving, with Open and Stop for each port and links
  to the other threads in the worktree. Reads Worktree Ports' listing.
- Needs BB 0.50, plugin SDK 0.6.157, and the Worktree Ports plugin.
