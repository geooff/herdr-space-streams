# Space Streams

Herdr's Spaces sidebar with **groups** and **work streams**: fold a repo's worktree spaces into named groups, then flip to Streams to see one effort's agents across every repo. Agents can file themselves with `hc label "$HC_TERMINAL_ID" herdr.group="<name>"`.

![Space Streams](preview.png)

A mod for the [Herdr app](https://herdr.dev). Install it by asking your agent to "add herdr.dev/mods/geooff/herdr-space-streams", or by hand: copy the `mods/` folders into `~/.config/herdr-app/mods/` (`mod.json` first) and merge `keys.json` into yours. [RECIPE.md](RECIPE.md) describes exactly what it does and how it's built.

Works on its own. Picks up [herdr-emoji-picker](https://github.com/geooff/herdr-emoji-picker) and [herdr-new-workspace](https://github.com/geooff/herdr-new-workspace) when they're installed. Based on Herdr's shipped `spaces` and `menu` mods.
