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
- Prefix plugin CSS classes (`sa-` in sim-annotate) so they never clash with
  BB's styles.

## Testing

Run every change in BB before the PR: `npm ci && bb plugin install .` in the
plugin, then `bb plugin dev`. Each plugin's `npm test` and
`npm run typecheck` must pass.

Test on a disposable thread and leave the user's threads, drafts, and
terminals alone. When a test types into BB, check first that the focus is in
the plugin's own field: a key that reaches the composer can send a message.

## New plugin

- Scaffold with `bb plugin new <id>`, then move it to `<id>/` and drop the
  example code.
- Check that it builds from git alone: `git archive HEAD <id>` into an empty
  directory, then `npm ci`, `npm test`, `npm run typecheck`, `npm run build`.
- Add it to the root README's **Plugins**, to `marketplace.json`, and to the
  collection's `pluginIds`.
