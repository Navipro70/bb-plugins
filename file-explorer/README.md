# File Explorer

A Cursor / VS Code style file tree for the thread's workspace, in bb's side
panel.

- **Files** in the side panel's Actions list (the `+` tab) opens the tree of
  the thread's workspace: folders first, natural name order, `.gitignore`d
  entries dimmed, and `.git` and `.DS_Store` hidden, as VS Code does.
- Seti file icons, the same set Cursor and VS Code ship by default.
- Git colors and letters: modified (`M`), added (`A`), untracked (`U`),
  deleted, renamed and conflicted files, with a dot on folders that contain
  changes. The status refreshes every few seconds while the window is
  visible, and the open folders reload when files appear or disappear.
- Click a file to preview it next to the tree, with bb's own file preview
  (syntax highlighting, Markdown, Raw, Open in editor). Drag the divider to
  resize the tree. In a narrow panel, and on double-click, the file opens as
  a regular bb file tab instead.
- Keyboard: arrows move and open or close folders, Enter opens.
- The expanded folders, the previewed file and the tree width are remembered
  per environment.

## Limits

The tree reads the workspace with Node's `fs` and `git` on the bb server's
own machine, so it covers project checkouts and worktrees on this computer.
A thread whose environment lives on another machine shows an error instead.
A folder lists at most 5000 entries.

## Development

```sh
npm ci
bb plugin install .
bb plugin dev
npm run typecheck
npm test
```

`npm run update-seti` refreshes the vendored icon font and map in `lib/` from
VS Code's `theme-seti` extension.

## Credits

The file icons are [Seti UI](https://github.com/jesseweed/seti-ui) by Jesse
Weed, as packaged in VS Code's `theme-seti` extension, under the MIT license.
See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Releases

See [CHANGELOG.md](./CHANGELOG.md).
