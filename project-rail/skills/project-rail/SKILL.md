---
name: project-rail
description: "Set a project's icon in the Project Rail sidebar, or focus the sidebar thread list on one project, with `bb project-rail`."
---

# Project Rail

Project Rail draws one icon per project in the sidebar's left rail. Clicking an
icon focuses the thread list on that project (other projects move into More);
clicking it again shows every project. Cmd/Ctrl-click starts a new thread in
that project. Users drag icons to reorder them (saved as bb's project order,
the same as `bb project reorder`), and right-click an icon to move it, hide it
from the rail (hidden projects are listed under More), or put the project block
below the plugin panels.

```sh
bb project-rail status                         # focused project and every icon
bb project-rail focus <project-id|name|all>
bb project-rail icon set <file.png> [--project <id|name>]   # PNG, up to 256KB, square
bb project-rail icon emoji <emoji> [--project <id|name>]
bb project-rail icon color <#rrggbb> [--project <id|name>]  # monogram background
bb project-rail icon clear [--project <id|name>]
bb project-rail icon get [--project <id|name>]
bb project-rail home set <nav-item-id> [--project <id|name>]   # e.g. pulse/pulse
bb project-rail home clear [--project <id|name>]
```

A project's home is a plugin panel (its rail item id, `<pluginId>/<panelId>`,
listed in `bb settings ui get sidebar.pluginPanelOrder`). With a home set,
clicking the project icon opens that panel, and leaving a thread for the empty
new-thread screen (closing or archiving the chat) returns to it. New thread
clicks and the New thread shortcut are not redirected. Opening that panel from
anywhere (its own rail icon included) focuses the linked project, even when
the project's icon is hidden; opening any other rail destination clears the
focus, and Home always shows every project. Users can also pick it
from the icon's right-click menu → Home page.

Without `--project`, the calling chat's project is used. Focusing changes the
Thread list plugin's `organizationMode`, `hiddenGroups`, and `collapsedProjects`
preferences; `focus all` restores the values saved before the first focus.
