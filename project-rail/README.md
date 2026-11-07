# Project Rail

Keep each project one click away in the sidebar's left rail.

## Use

- **An icon per project** under Home in the rail: your own PNG, an emoji, or a
  colored monogram.
- **Click** an icon to focus the thread list on that project; click it again to
  show every project. **Cmd/Ctrl-click** starts a new thread there, and New
  thread in the header files new threads in the focused project.
- **A dot** on an icon when a thread in that project needs input, failed, is
  unread, or is working.
- **Drag** icons to reorder projects (saved as bb's project order, the same as
  `bb project reorder`). **Right-click** an icon to move it, hide it from the
  rail (hidden projects are listed under More), put the project block below
  the plugin panels, or pick its home page.
- **Home page.** A project's home is a plugin panel. With a home set, clicking
  the icon opens that panel, and leaving a thread for the empty new-thread
  screen returns to it. Opening the panel from anywhere focuses its project.
- **Home style.** Home groups threads by project, or shows one list with each
  thread's project icon before its agent icon.

## CLI

Without `--project`, the calling chat's project is used.

```sh
bb project-rail status                                      # focused project and every icon
bb project-rail focus <project-id|name|all>
bb project-rail icon set <file.png> [--project <id|name>]   # PNG, up to 256 KB, square
bb project-rail icon emoji <emoji> [--project <id|name>]
bb project-rail icon color <#rrggbb> [--project <id|name>]  # monogram background
bb project-rail icon clear [--project <id|name>]
bb project-rail icon get [--project <id|name>]
bb project-rail home set <nav-item-id> [--project <id|name>]  # e.g. pulse/pulse
bb project-rail home clear [--project <id|name>]
bb project-rail home-style <grouped|badges>
```

The bundled skill teaches agents the same commands.

## How it works

Focusing drives bb's built-in Thread list through its preferences: it sets
`organizationMode`, `hiddenGroups`, and `collapsedProjects` to organize by
project and hide the other projects into More. `focus all`, or a second click,
restores the values saved before the first focus. Icons live in this plugin's
storage; nothing leaves the machine.

## Install

Needs BB 0.48 or later.

```sh
bb marketplace add git:https://github.com/Navipro70/bb-plugins.git@main
bb plugin install project-rail@navipro-plugins
```

From a checkout of this directory: `npm ci`, then `bb plugin install .`.

## Development

```sh
npm ci
npm run typecheck
npm run build
bb plugin reload project-rail
```
