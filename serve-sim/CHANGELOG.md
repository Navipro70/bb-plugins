# Changelog

## 0.2.0 (2026-11-07)

- Annotate: a button in serve-sim's toolbar under the device and ⌥⌘A freeze a
  snapshot over the live screen; click an element, write a note, and send it
  to the agent as a composer pill with its `testID`, frame, and a marked
  screenshot.
- The preview now loads through a local proxy that adds the Annotate button
  to serve-sim's page; streams and input pass through unchanged.
- Reloading or updating the plugin stops the serve-sim it started and its
  proxy, so nothing outlives the plugin.
- New setting `idbPath` for Annotate.

## 0.1.0

- First release: the live serve-sim preview in the thread's side panel, the
  `bb serve-sim` CLI, and the agent skill.
