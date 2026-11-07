This repository holds every custom BB plugin Navipro70 builds. A new plugin
starts here as `<plugin-id>/`, never in a separate repository.

- Write code, docs, and commit messages in English.
- A PR that changes what a plugin ships runs
  `npm version patch --no-git-tag-version` in that plugin and adds a top entry
  to its `CHANGELOG.md` (README → Releases).
- Docs describe only the current state; history goes in `CHANGELOG.md`.
- Wrap Markdown at 80 columns without splitting links or bold names. Never run
  Prettier on Markdown or `marketplace.json`.
- Edit `marketplace.json` with a script that writes
  `json.dumps(data, indent=2, ensure_ascii=False) + "\n"`, then validate it
  against its `$schema`. Keep each entry's `description` equal to the
  plugin's `bb.description` and its `overview` equal to its
  `PLUGIN_OVERVIEW.md`.
- Never change a released plugin id (installs, settings, data, and keybindings
  are keyed by it) or the marketplace name `navipro-plugins`.
- Default command keys use Cmd, Ctrl, or Alt. BB silently leaves a taken key
  unbound, so check BB's own bindings first (⇧⌘M, for one, picks the model).
- Wrap hand-written `:hover` rules in `@media (hover: hover)`, as BB does, or
  they stick after a tap.
- Prefix plugin CSS classes (`sa-` in serve-sim's Annotate) so they never
  clash with BB's styles.
- Push with the Navipro70 account: `gh` is signed in as Navipro70, while plain
  `git push` may pick another stored GitHub account.

## Testing

Run every change in BB before the PR: `npm ci && bb plugin install .` in the
plugin, then `bb plugin dev`. Each plugin's `npm run typecheck` must pass,
and `npm test` where the plugin has tests. Installing a plugin from another
path keeps its settings and data; switching between a path and a git or
marketplace source takes `bb plugin remove <id>`, which wipes its settings,
so save `bb plugin config <id>` first.

Browser checks go through the user's Aside browser (profile Personal), never
`bb browser-automation`.

Test on a disposable thread and leave the user's threads, drafts, and
terminals alone. When a test types into BB, check first that the focus is in
the plugin's own field: a key that reaches the composer can send a message.

## New plugin

- Scaffold with `bb plugin new <id>` in this repository, rename the folder to
  `<id>/`, and drop the example code. Fill in `package.json`'s `repository`
  (with `directory`), `homepage`, and `bugs` like the other plugins.
- Check that it builds from git alone: `git archive HEAD <id>` into an empty
  directory, then `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.
- Add it to the root README's **Plugins**, to `marketplace.json`, and to the
  collection's `pluginIds`, with a `README.md`, `PLUGIN_OVERVIEW.md`, and
  `CHANGELOG.md` of its own.
