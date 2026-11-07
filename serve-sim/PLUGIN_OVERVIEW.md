## What you get

A **Simulator (serve-sim)** button in every thread header opens a side-panel tab with a
live, interactive iOS Simulator. Click to tap, drag to swipe, type to send
keys, and use serve-sim's own toolbar for home, screenshots, recording,
rotation, the device grid, logs and Safari Web Inspector.

Pick a device (booted ones are listed first) and press **Start simulator**.
The plugin runs [serve-sim](https://github.com/EvanBacon/serve-sim) in the
background and keeps it running while you switch threads; **Stop** in the
panel toolbar ends it.

## Annotate

Press **Annotate** in serve-sim's toolbar under the device or **⌥⌘A**: the
live screen freezes in place and you click the element you mean. A blue box shows
its type, text, and `testID`; **↑** selects its parent. Write a note, press
**Enter**, and a pill such as `1 · Buy Pro` lands in the composer. Your agent
gets the note, the element's `testID` (React Native / Expo), frame, and a
screenshot with the element outlined. Needs [idb](https://fbidb.io).

## For agents

`bb serve-sim start|stop|status|devices|logs` controls the preview from a
shell, and the bundled skill shows agents how to drive the same device with
`npx serve-sim tap|type|button|gesture` while you watch.

## Requirements

An Apple Silicon Mac with Xcode, an iOS Simulator runtime and Node.js 20+.
The BB server must run on that Mac: the panel embeds serve-sim's preview at
`http://localhost:<port>`, so it works in BB Desktop, not from a remote web
client. No account or external service is needed; the first start downloads
serve-sim through npx.
