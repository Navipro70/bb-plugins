---
name: thread-ports
description: Thread Ports lists the TCP ports each BB thread's processes are serving and can stop one. Use when asked what is running, which port a dev server is on, what URL reaches it (also from a phone on the same network), or to stop a server a thread started.
---

# Thread Ports

Every process an agent starts inherits `BB_THREAD_ID`, so Thread Ports knows
which thread started each listening port.

```sh
bb thread-ports list            # per thread: port, name, URL, LAN URL, pid
bb thread-ports list --json
bb thread-ports stop <port>     # SIGTERM; add --force for SIGKILL
```

The user sees the same listing in the **Ports** panel of the sidebar footer
(Open, Copy, Stop, jump to the thread), in the row above the thread's
composer, and as a plug glyph on serving threads.

- After starting a dev server, give the user its URL from `bb thread-ports
  list` instead of guessing the port.
- A server bound to `0.0.0.0` shows a LAN URL (`http://<lan-ip>:<port>`) that
  opens from a phone on the same Wi-Fi; one bound to `127.0.0.1` does not.
- Stop only servers this thread started unless the user asks otherwise.
