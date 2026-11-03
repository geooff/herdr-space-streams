# Space Streams

**Install: paste this to your agent inside Herdr**

```text
Read ~/.config/herdr-app/AGENTS.md, then add the Herdr mod at https://github.com/geooff/herdr-space-streams
and make it my Spaces sidebar. Follow the "For agents" section of its README.
```

---

Herdr's Spaces sidebar, rebuilt for running many agents at once:

- **Groups:** a repo's worktree spaces fold into named groups.
- **Streams:** flip the toggle to see one effort across every repo. Groups with the same name in different repos merge into one work stream.
- **Repo emoji:** every row shows its repo's emoji next to its agent's icon, so in a mixed stream you can tell at a glance which repo and which agent each space is.
- **Agents file themselves:** `hc label "$HC_TERMINAL_ID" herdr.group="<stream name>"`.

![Repos view and Streams view](preview.png)

![Picking a repo's emoji](emoji.png)

| | |
|---|---|
| Click a group or stream header | fold it (it still shows the space you're in, and a dot if a hidden agent is blocked or done) |
| Double-click or right-click a header | rename, ungroup, collapse others |
| Right-click a worktree → **Move to group…**, or `cmd-shift-g` | pick a group, join a stream from another repo, or name a new one |
| Drag a worktree onto a header | move it in |
| Click an avatar, or `cmd-shift-e` | pick the repo's emoji (macOS emoji search) |

It works on its own. With [herdr-one-agent-one-worktree](https://github.com/geooff/herdr-one-agent-one-worktree) installed, a repo's `+` opens that flow. Without it, `+` opens Herdr's own worktree dialog. [RECIPE.md](RECIPE.md) describes exactly what it does and how it's built. It's based on Herdr's shipped `spaces` and `menu` mods.

## For agents

You're installing this into the person's Herdr home (`~/.config/herdr-app`, or `$HERDR_APP_HOME`). Read its `AGENTS.md` first.

1. **Tell the person first:** this mod runs `git` in their spaces' folders, `hc machine ls`, and `python3` (macOS emoji search data). It also writes `data/space-groups.json` in the Herdr home.
2. **Copy the mods:** copy `mods/space-streams`, `mods/space-streams-menu`, `mods/space-group` and `mods/emoji-picker` into `<home>/mods/`. Write each folder's `mod.json` before its `main.js`, because Herdr docks a folder it sees without one. If a name is already taken, rename the new one and every reference to it, and tell the person.
3. **Merge keys:** merge `keys.json` into `<home>/keys.json` (`cmd-shift-g` → `space-streams.group`, `cmd-shift-e` → `mod.open:emoji-picker`). Ask before replacing a key they already use.
4. **Make it the sidebar:** find the layout they use (`herdr-app status` → `layout`).
   - If it's a shipped layout (`main`), clone it first: `herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`.
   - In their layout, change the Spaces block's `"mod": "spaces"` (or their own spaces mod) to `"mod": "space-streams"`. Check `layout.error` afterwards.
5. **Check:** run `herdr-app check` on each of the four folders and `herdr-app status` (no errors). Take a `herdr-app shot` and confirm the sidebar shows the **Repos | Streams** toggle.
6. **Agent rule (ask first):** offer to add this to the person's agent instructions (e.g. `~/.claude/CLAUDE.md` or `AGENTS.md`):

   > **Herdr work streams.** When you run inside Herdr in a repo worktree, read `~/.config/herdr-app/data/space-groups.json` and join the work stream your work belongs to: `hc label "$HC_TERMINAL_ID" herdr.group="<exact stream name>"`. Reuse an existing name character for character, even one from another repo. Only make a new one when nothing fits, and name the effort, not your slice of it. Skip this for one-off tasks. If you start other agents for a batch, choose the stream name yourself and put it in each one's prompt.

7. **Report back:** tell the person how to switch views, group a space (`cmd-shift-g`) and set an emoji (click an avatar), and how to undo: point the layout back at `spaces` and delete the four folders.
