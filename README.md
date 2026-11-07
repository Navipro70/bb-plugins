# Navipro Plugins

A family of [bb](https://getbb.app) plugins by
[Navipro70](https://github.com/Navipro70), plus the marketplace catalog that
serves them.

## Use this repository as a marketplace

```sh
bb marketplace add git:https://github.com/Navipro70/bb-plugins.git@main
bb plugin install sim-annotate@navipro-plugins
```

`bb marketplace refresh navipro-plugins` re-reads the catalog; it never
installs or updates a plugin on its own. The catalog tracks `main`, so
`bb plugin update sim-annotate` follows this repository's latest commit.

## Plugins

### [Annotate Simulator](./sim-annotate)

Notes on elements of the iOS Simulator's screen. Click an element of your
Expo or React Native app, write a note, and send it to your agent as a pill
with the element's `testID`, frame, and a marked screenshot. Needs a Mac with
Xcode's iOS Simulator and idb.

## Layout

- `marketplace.json` is the v2 marketplace document bb reads.
- `<plugin-id>/` holds one plugin, with its own `package.json`, tests, and
  `CHANGELOG.md`.
- `screenshots/<plugin-id>/` holds the catalog screenshots.

## Releases

Each plugin has its own version, in `<plugin-id>/package.json`, its own
history, in `<plugin-id>/CHANGELOG.md`, and its own release tags,
`<plugin-id>/v<version>`, so tags never collide between plugins.

1. In every pull request that changes what a plugin ships (its code, styles,
   manifest, or runtime dependencies), raise that plugin's patch version by
   one with `npm version patch --no-git-tag-version` in its directory. A pull
   request that changes two plugins raises both. Tests, docs, and dev tooling
   alone don't need a new version.
2. In the same pull request, add the new version at the top of the plugin's
   `CHANGELOG.md`, with the date and what changed for the people who use it.
3. When the pull request merges, the
   [Release tags](./.github/workflows/release-tags.yml) workflow tags the new
   commit on `main` as `<plugin-id>/v<version>`.

Never move or delete a pushed tag: BB records the commit behind each tag and
reports a moved tag as a failed security check. Fix a bad release with the
next version.
