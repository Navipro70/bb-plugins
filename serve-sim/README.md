# Simulator (serve-sim) for BB

Stream a live, interactive iOS Simulator into the [BB](https://getbb.app)
thread side panel, powered by Evan Bacon's
[serve-sim](https://github.com/EvanBacon/serve-sim).

- **Simulator (serve-sim)** button in the thread header toggles a side-panel tab.
- Choose a device and press **Start simulator**; the plugin runs serve-sim in
  the background and embeds its full preview (H.264 stream, touch and keyboard
  input, home / screenshot / record / rotate, device grid, logs, Web Inspector).
- `bb serve-sim` CLI and an agent skill, so agents can start the preview and
  drive the same device while you watch.

## Annotate

Point at the part of your app you mean. The **Annotate** button in
serve-sim's toolbar under the device (or **⌥⌘A** in a thread) freezes a
snapshot exactly over the live screen, keeping the device frame and toolbar,
and turns on a picker:

1. Point at an element. A blue box and a label show its type, text,
   `testID`, and size. **↑** selects its parent, **↓** goes back down.
2. Click it and write a note. **Enter** adds it, **Shift+Enter** starts a new
   line, **Esc** drops it.
3. A pill such as `1 · Buy Pro` lands in the thread's composer and the panel
   goes back to the live stream. Annotate again for the next note, then send
   your message.

Click a note's pin in Annotate mode to edit or delete it; deleting its pill in
the composer removes it too. **Live** or **Esc** returns to the stream.

For each pill the agent gets your note, the device and app, and the element's
type, label, identifier, value, frame in points, and ancestors, plus a JPEG of
the screen with the element outlined and pinned. In React Native and Expo the
identifier is the `testID` prop, so the agent finds the component with one
search. Only accessible elements are in the tree: a `Text`, a `Pressable`, or
anything with `testID`, `accessible`, or an `accessibilityLabel`.

Annotate reads the screen with `xcrun simctl io screenshot` and the elements
with [idb](https://fbidb.io) (`idb ui describe-all`). It works on any booted
simulator, even while serve-sim is stopped.

## Requirements

- macOS on Apple Silicon, Xcode with an iOS Simulator runtime.
- Node.js 20+ on your login-shell `PATH` (serve-sim runs through `npx`).
- BB 0.48+ with its server on the same Mac (BB Desktop). The panel embeds
  `http://localhost:<port>`, so remote web clients cannot show it.
- For Annotate: [idb](https://fbidb.io)
  (`brew install facebook/fb/idb-companion` and `pipx install fb-idb`). The
  plugin finds it in `~/.local/bin`, Homebrew, or your login shell's `PATH`.

## Install

```sh
bb plugin install git:https://github.com/Navipro70/bb-plugin-serve-sim.git
```

From a checkout:

```sh
npm install --include=dev
bb plugin build
bb plugin install .
```

## CLI

```sh
bb serve-sim status            # running at http://localhost:3200 (iPhone 17 Pro) — pid …
bb serve-sim devices           # available simulators, booted first
bb serve-sim start [device]    # device name or UDID; waits for the preview URL
bb serve-sim stop
bb serve-sim logs              # recent serve-sim output
```

Every command accepts `--json`.

## Settings

`bb plugin config serve-sim` or Settings → Simulator (serve-sim):

| Setting | Default | Meaning |
|---|---|---|
| `command` | `npx --yes serve-sim@0.1.49` | Command used to start serve-sim (runs in your login shell). Point it at a local build or global install. |
| `port` | `3200` | Preview port. At 3200 serve-sim scans upward when busy; any other value is pinned. |
| `extraArgs` | – | Extra flags, e.g. `--codec mjpeg`, `--theme dark`, `--fit`. |
| `idbPath` | – | Full path to `idb` for Annotate, when it is not found on its own. |

## How it works

`server.ts` spawns serve-sim in its own process group through your login
shell, reads the `Local: http://localhost:<port>` line, and publishes status
over BB realtime. `app.tsx` registers the side-panel tab and header button and
embeds serve-sim's preview page in an iframe. That page talks to serve-sim's
same-origin WebSocket for input, so nothing is re-implemented. Reloading,
disabling or removing the plugin stops serve-sim.

The iframe loads the preview through a small local proxy the plugin starts
next to serve-sim (`annotate/proxy.ts`). It passes every request, stream and
WebSocket through unchanged, speaking for serve-sim's origin, and adds one
script to the preview page (`annotate/inject.ts`). The script puts the
Annotate button into serve-sim's toolbar and reports where the screen is
drawn, so the panel can lay Annotate over exactly that rectangle. If a
serve-sim update renames its toolbar, the button does not appear and Annotate
falls back to a full-panel view; the preview itself keeps working.

## License

Apache-2.0. serve-sim is © Evan Bacon, Apache-2.0, and is downloaded at run
time, not bundled.
