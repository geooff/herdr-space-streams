// Space Streams: Herdr's Spaces sidebar with groups and work streams.
// Repos view: spaces under their repo, a repo's worktree spaces in named, foldable groups.
// Streams view: groups with the same name across repos shown as one work stream.
// Agents join a group with `hc label "$HC_TERMINAL_ID" herdr.group="<name>"`.
// props: { under?: "<folder>" } shows only spaces whose folder is inside it.
// Modified from Herdr's shipped `spaces` mod (Apache License 2.0, see LICENSE-APACHE): groups,
// streams, the view toggle, list-order next/prev, the `under` prop and repo marks were added.
// From it: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, uncommitted changes (●N), ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, home, notify, terminals, nextCommand, appHome, props, readTextFile } from "herdr";
import * as fs from "fs/promises";

// Space groups (see mods/space-group): { groups: {id: {name, repo, collapsed, created}},
// members: {spaceId: groupId}, tags: {spaceId: last herdr.group label applied} }.
const GROUPS = "space.groups";
const groupState = () => { const s = shared(GROUPS) ?? {}; return { groups: s.groups ?? {}, members: s.members ?? {}, tags: s.tags ?? {} }; };
const URGENT = ["blocked", "done", "working", "idle"];
const urgent = (list) => URGENT.find((st) => list.includes(st)) ?? null;
const groupDialog = (props) => openOverlay({ mod: "space-group", kind: "dialog", width: 420, height: 380, props });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const GROUP_ROW = 26;
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space's emoji belongs to its repo, so a repo's worktree spaces share it; outside a repo, to the space.
const emojiKey = (w, g) => g?.repo ?? `space:${w.id}`;

// The agent running in a space (the first one), as the Agents list draws it.
function agentOf(w, ps) {
  const tabs = new Set((w.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.program?.agent && p.program.icon)?.program ?? null;
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pulling = new Set(); // where()s with a `git pull` under way
    this.press = null; // a row held down: { key, y (in the list, once known), dy, moving }
    this.units = []; // what a drag moves, and where it was drawn (see grouped)
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.repoFolded = new Set(JSON.parse(localStorage.getItem("repos.folded") ?? "[]")); // repos whose worktrees are hidden
    // "repos": spaces under their repo, groups inside it. "streams": groups of the same name
    // across repos as one work stream, then everything else.
    this.mode = localStorage.getItem("spaces.mode") === "streams" ? "streams" : "repos";
    this.streamFolded = new Set(JSON.parse(localStorage.getItem("streams.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    cx.timer.every(1000, () => this.applyTags());
    // Commands (keys.json): "space-streams.group" puts the shown space in a group,
    // "space-streams.view" switches between Repos and Streams, "space-streams.next" / ".prev"
    // show the space below / above in the list as drawn (Herdr's space.next follows its own
    // order, which groups and streams don't change, so it would jump around the list).
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const s = spaces().find((x) => x.active);
        if (c === "group" && s) groupDialog({ space: s.id });
        if ((c === "next" || c === "prev") && this.order?.length) {
          const at = this.order.indexOf(s?.id);
          const n = this.order.length;
          const to = at < 0 ? (c === "next" ? 0 : n - 1) : (at + (c === "next" ? 1 : n - 1)) % n;
          run("space.select", { id: this.order[to] });
        }
        if (c === "view") { this.mode = this.mode === "streams" ? "repos" : "streams"; localStorage.setItem("spaces.mode", this.mode); cx.notify(); }
      }
    });
    // Optional companions: used when installed (herdr.dev/mods), left out when not.
    this.has = {};
    cx.spawn(async (cx) => {
      for (const m of ["emoji-picker", "new-workspace"]) {
        this.has[m] = Boolean(await readTextFile(`${appHome()}/mods/${m}/main.js`).catch(() => null));
      }
      cx.notify();
    });
  }

  // Agents group themselves: `hc label "$HC_TERMINAL_ID" herdr.group="<name>"`. A new label
  // value joins (or makes) that group in the space's repo; after that the space is moved like
  // any other (the label only acts again when its value changes). Also drops spaces and groups
  // that are gone, and keeps data/space-groups.json up to date for agents to read.
  applyTags() {
    const sp = spaces();
    if (!sp.length) return;
    const cur = groupState();
    const s = JSON.parse(JSON.stringify(cur));
    const byId = Object.fromEntries(sp.map((x) => [x.id, x]));
    const ps = panes();
    for (const term of terminals()) {
      const name = term.labels?.["herdr.group"]?.trim();
      const local = term.labels?.["herdr.space"];
      if (!name || !local) continue;
      const sid = term.address.includes("/") ? `${term.address.split("/")[0]}/${local}` : local;
      const space = byId[sid];
      if (!space || s.tags[sid] === name) continue;
      const g = this.git[where(space, ps)];
      if (g === undefined) continue; // git not looked at yet
      s.tags[sid] = name;
      if (!g?.linked) continue; // groups hold a repo's worktree spaces
      let gid = Object.keys(s.groups).find((id) => s.groups[id].repo === g.repo && s.groups[id].name.toLowerCase() === name.toLowerCase());
      if (!gid) { gid = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; s.groups[gid] = { name, repo: g.repo, collapsed: false, created: Date.now() }; }
      s.members[sid] = gid;
    }
    for (const sid of Object.keys(s.members)) if (!byId[sid] && !sid.includes("/")) delete s.members[sid];
    for (const sid of Object.keys(s.tags)) if (!byId[sid] && !sid.includes("/")) delete s.tags[sid];
    const used = new Set(Object.values(s.members));
    for (const id of Object.keys(s.groups)) if (!used.has(id)) delete s.groups[id];
    if (JSON.stringify(s) !== JSON.stringify(cur)) setShared(GROUPS, s);
    this.writeGroupsFile(s, byId);
  }

  writeGroupsFile(s, byId) {
    const repos = {};
    for (const [id, g] of Object.entries(s.groups)) {
      const [machine, dir] = JSON.parse(g.repo);
      const repo = dir.endsWith("/.git") ? dir.slice(0, -5) : dir;
      (repos[repo] ??= { machine, groups: [] }).groups.push({
        name: g.name,
        collapsed: Boolean(g.collapsed),
        spaces: Object.entries(s.members).filter(([, v]) => v === id).map(([sid]) => byId[sid]?.name ?? sid),
      });
    }
    const text = JSON.stringify({
      about: "Herdr space groups, written by the space-streams sidebar. Join or make one from inside a space with: hc label \"$HC_TERMINAL_ID\" herdr.group=\"<group name>\" (reuse an existing name in your repo when it fits).",
      repos,
    }, null, 2) + "\n";
    if (text === this.groupsFile) return;
    this.groupsFile = text;
    fs.writeFile(`${appHome()}/data/space-groups.json`, text).catch(() => { this.groupsFile = null; });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, changes: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line && !line.startsWith("#")) info.changes++; // a changed, unmerged or untracked path
        else if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "space-streams-menu", kind: "popup", width: 220, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const under = props()?.under?.replace(/\/+$/, "");
    const inside = (w) => !under || `${place(w, ps)}/`.startsWith(`${under}/`);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id) && inside(r.w));
    if (this.mode === "streams") return this.streamRows(list);
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    const G = groupState();
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, key: r.w.id, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const all = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      out[out.length - 1].kids = all.length;
      out[out.length - 1].block = all.map((k) => k.w.id); // its worktrees go where it goes, folded or not
      // A folded repo still shows the space you're in.
      if (this.repoFolded.has(r.g.repo)) {
        all.filter((k) => k.w.active).forEach((k) => out.push({ ...k, key: k.w.id, parent: r.w.id, tree: "└─" }));
        continue;
      }
      // Its groups first (oldest first), each a header then its spaces, then the ungrouped ones.
      const groupOf = (k) => { const id = G.members[k.w.id]; return id && G.groups[id]?.repo === r.g.repo ? id : null; };
      const gids = Object.keys(G.groups).filter((id) => G.groups[id].repo === r.g.repo && all.some((k) => groupOf(k) === id))
        .sort((a, b) => (G.groups[a].created ?? 0) - (G.groups[b].created ?? 0));
      for (const gid of gids) {
        const grp = G.groups[gid];
        const members = all.filter((k) => groupOf(k) === gid);
        out.push({ hdr: gid, key: `grp:${gid}`, parent: r.w.id, machine: r.w.machine, tree: "├─", grp, repo: r.g.repo, count: members.length,
          status: urgent(members.map((k) => k.w.status)), hidden: grp.collapsed ? urgent(members.filter((k) => !k.w.active).map((k) => k.w.status)) : null });
        // A collapsed group still shows the space you're in.
        (grp.collapsed ? members.filter((k) => k.w.active) : members)
          .forEach((k) => out.push({ ...k, key: k.w.id, parent: r.w.id, tree: "├─", depth: 2, lane: `grp:${gid}` }));
      }
      const loose = all.filter((k) => !groupOf(k));
      loose.forEach((k, n) => out.push({ ...k, key: k.w.id, parent: r.w.id, tree: n === loose.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // Work streams: every group with the same name, from any repo, under one header; then
  // what's in no stream. Each row says its repo. Rows don't reorder here (order across repos
  // means nothing); drop a worktree on a stream to join it.
  streamRows(list) {
    const G = groupState();
    const streams = new Map();
    for (const [id, g] of Object.entries(G.groups)) {
      const k = g.name.trim().toLowerCase();
      const st = streams.get(k) ?? { name: g.name, gids: [], created: Infinity };
      st.gids.push(id);
      st.created = Math.min(st.created, g.created ?? 0);
      streams.set(k, st);
    }
    const out = [], used = new Set();
    const head = (k, name, members) => {
      const folded = this.streamFolded.has(k);
      out.push({ hdr: k ? `stream:${k}` : "stream-rest", stream: k, key: `grp:stream:${k}`, machine: null, grp: { name, collapsed: folded },
        count: members.length, repos: new Set(members.map((r) => r.g?.name ?? "")).size,
        status: urgent(members.map((r) => r.w.status)), hidden: folded ? urgent(members.filter((r) => !r.w.active).map((r) => r.w.status)) : null });
      (folded ? members.filter((r) => r.w.active) : members)
        .forEach((r) => out.push({ ...r, key: r.w.id, tree: "├─", inStream: true, lane: `one:${r.w.id}` }));
    };
    for (const [k, st] of [...streams.entries()].sort((a, b) => a[1].created - b[1].created)) {
      const members = list.filter((r) => st.gids.includes(G.members[r.w.id]));
      if (!members.length) continue;
      members.forEach((r) => used.add(r.w.id));
      head(k, st.name, members);
    }
    const rest = list.filter((r) => !used.has(r.w.id));
    if (rest.length) head("", "Not in a stream", rest);
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    // The narrow rail lists spaces only: no group headers.
    const rows = this.ordered().filter((r) => !(collapsed && r.hdr));
    // Where each row is drawn, by the heights it's given, so a drag can tell where it
    // would land. A unit is what one drag moves: a space with its worktrees, among the
    // spaces of its machine, or one worktree among its repo's.
    const units = [];
    let y = 0;
    const draw = (r) => {
      const h = r.hdr ? GROUP_ROW : rowHeight(r);
      if (r.tree) {
        const main = units.find((u) => u.key === r.parent);
        if (main) { main.height += h; main.rows.push(r.key); }
      }
      // A group header isn't dragged; its spaces move among themselves.
      if (r.hdr) { y += h; return this.groupRow(r, t); }
      this.order.push(r.w.id);
      units.push({ key: r.w.id, lane: r.lane ?? (r.tree ? `kids:${r.parent}` : `top:${r.w.machine ?? ""}`), ids: [r.w.id, ...(r.block ?? [])], rows: [r.w.id], top: y, height: h });
      y += h;
      return collapsed ? this.compact(r, t) : this.row(r, t);
    };
    this.units = units;
    this.drawn = rows;
    this.order = []; // the spaces as drawn, for next/prev (filled by draw: folded ones are left out)
    const remote = [...new Set([...rows.map(r => r.w?.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => ((r.hdr ? r.machine : r.w.machine) ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      y += 26; // the header
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [(y += 28, loading(m) ? loadingRow(m) : empty)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t, key) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    // The branch text takes what's left and truncates; the counts never shrink, so they never cover the name.
    const text = (el) => el.text_size(11.5).text_color(t.dim);
    return [
      text(div().flex_1().min_w(0).flex().justify_end()).when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where))),
      text(h_flex().flex_none().gap(5).items_center())
        .when(g.changes > 0, (el) => el.child(div().flex_none().text_color(t.ansi3).child(`\u25cf${g.changes}`)))
        .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
        .when(g.behind > 0 || this.pulling.has(key), (el) => el.child(this.pullButton(g, t, key))),
    ];
  }

  // \u2193N is a button: click it to fast-forward to the upstream.
  pullButton(g, t, key) {
    const busy = this.pulling.has(key);
    return h_flex().id(`space-pull-${key.replace(/\W+/g, "_")}`).flex_none().gap(3).px(4).h(18).items_center().rounded(4).cursor_pointer()
      .text_color(t.ansi1).hover((s) => s.bg(t.raised))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.press = null;
        this.pull(key, cx);
      })
      .when(busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(10).spin(900)))
      .when(!busy, (el) => el.child(`\u2193${g.behind}`));
  }

  pull(key, cx) {
    if (this.pulling.has(key)) return;
    const [on, cwd] = JSON.parse(key);
    this.pulling.add(key);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Uncommitted changes are stashed for the pull and put back after.
        const r = await exec("git", ["pull", "--ff-only", "--autostash"], { cwd, on });
        if (r.code !== 0) {
          const why = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).slice(-2).join(" ");
          const diverged = /not possible to fast-forward|diverg/i.test(why);
          notify({ title: diverged ? "Branch has diverged" : "Pull failed", body: diverged ? "It has local commits too: rebase or merge it in a terminal." : why, level: "error" });
        } else if (/applying them\s+resulted in conflicts|autostash resulted in conflicts/i.test(`${r.stdout}${r.stderr}`)) {
          notify({ title: "Pulled, but your changes conflict", body: "They're kept in `git stash`: resolve the conflicts, then `git stash drop`.", level: "warning" });
        }
      } catch (e) {
        notify({ title: "Pull failed", body: String(e.message ?? e), level: "error" });
      }
      this.pulling.delete(key);
      this.refreshGit(new Set(this.sameRepo(key, new Set(Object.keys(this.git)))), cx);
      cx.notify();
    });
  }

  // A repo's main checkout with worktrees: an arrow folds them away, the count says how many.
  foldToggle(w, g, kids, t) {
    const folded = this.repoFolded.has(g.repo);
    return h_flex().id(`space-fold-${w.id}`).flex_none().gap(3).px(4).h(18).items_center().rounded(4)
      .text_size(11).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.press = null;
        folded ? this.repoFolded.delete(g.repo) : this.repoFolded.add(g.repo);
        localStorage.setItem("repos.folded", JSON.stringify([...this.repoFolded]));
        cx.notify();
      })
      .when(folded, (el) => el.child(String(kids)))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11));
  }

  // A drag under way: where the held unit is drawn now (it follows the pointer, kept
  // inside its lane), where it would land, and how far each row slides to make room.
  preview() {
    const p = this.press;
    const s = p?.moving && this.units.find((u) => u.key === p.key);
    if (!s) return null;
    const lane = this.units.filter((u) => u.lane === s.lane);
    const start = lane[0].top, end = lane.at(-1).top + lane.at(-1).height;
    const top = Math.min(Math.max(s.top + p.dy, start), end - s.height);
    const others = lane.filter((u) => u !== s);
    const at = others.filter((u) => u.top + u.height / 2 < top + s.height / 2).length;
    const order = [...others.slice(0, at), s, ...others.slice(at)];
    const shift = {};
    let y = start;
    for (const u of order) {
      for (const id of u.rows) shift[id] = y - u.top;
      y += u.height;
    }
    return { s, top, at, others, shift, moved: order.some((u, n) => u !== lane[n]) };
  }

  // Lets go: the held unit's spaces go where the preview showed, one move per space out of place.
  drop() {
    // Let go over a group's header: the held worktree space joins that group.
    const into = this.press?.moving && this.overGroup && this.drawn?.find((r) => r.key === this.press.key);
    const grp = into && groupState().groups[this.overGroup];
    if (into && grp && into.tree && into.g?.repo === grp.repo) {
      const s = groupState();
      setShared(GROUPS, { ...s, members: { ...s.members, [into.w.id]: this.overGroup } });
      this.press = null;
      return;
    }
    if (into && this.overGroup.startsWith("stream:") && into.g?.linked) {
      const k = this.overGroup.slice(7);
      const s = groupState();
      const name = Object.values(s.groups).find((g) => g.name.trim().toLowerCase() === k)?.name ?? k;
      let gid = Object.keys(s.groups).find((id) => s.groups[id].repo === into.g.repo && s.groups[id].name.trim().toLowerCase() === k);
      const groups = { ...s.groups };
      if (!gid) { gid = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; groups[gid] = { name, repo: into.g.repo, collapsed: false, created: Date.now() }; }
      setShared(GROUPS, { ...s, groups, members: { ...s.members, [into.w.id]: gid } });
      this.press = null;
      return;
    }
    const v = this.preview();
    this.press = null;
    if (!v?.moved) return;
    const ids = spaces().map((s) => s.id);
    const held = ids.filter((id) => v.s.ids.includes(id));
    const rest = ids.filter((id) => !v.s.ids.includes(id));
    const next = v.others[v.at], prev = v.others[v.at - 1];
    const cut = next ? Math.min(...next.ids.map((id) => rest.indexOf(id))) : Math.max(...prev.ids.map((id) => rest.indexOf(id))) + 1;
    const now = [...ids];
    [...rest.slice(0, cut), ...held, ...rest.slice(cut)].forEach((id, k) => {
      if (now[k] === id) return;
      now.splice(now.indexOf(id), 1);
      now.splice(k, 0, id);
      run("space.move", { id, index: k + 1 });
    });
  }

  // The dragged space (with its worktrees), lifted off the list and following the pointer.
  lifted(t) {
    const { s, top } = this.view;
    return v_flex().id("space-lifted").absolute().left(0).right(0).top(top)
      .rounded(8).bg(t.raised).border(1).border_color(t.border).shadow_lg()
      .children(this.drawn.filter((r) => s.rows.includes(r.key)).map((r) => (r.hdr ? this.groupRow(r, t, true) : this.row(r, t, true))));
  }

  // A group of a repo's worktree spaces: click folds it, double-click renames it,
  // right-click for rename / ungroup / collapse others. Drop a worktree on it to move it in.
  // Folded, it still shows the space you're in, and a dot when one it hides needs you.
  groupRow({ hdr, key, grp, count, status, hidden, stream, repos }, t, ghost = false) {
    const isStream = stream !== undefined;
    const v = ghost ? null : this.view;
    const target = !ghost && this.view && this.overGroup === hdr;
    const d = grp.collapsed ? hidden : status;
    const dot = d === "idle" ? null : d;
    return h_flex().relative().id(`${ghost ? "ghost" : "group"}-${hdr}`).h(GROUP_ROW).flex_none().pl(isStream ? 8 : 30).pr(8).gap(7).items_center().rounded(7)
      .text_size(11.5).text_color(t.muted).cursor_pointer()
      .when(!this.view, (el) => el.hover((s) => s.bg(t.hover)))
      .when(Boolean(target), (el) => el.bg(t.selected).border(1).border_color(t.accent))
      .when(Boolean(v), (el) => el.top(v.shift[key] ?? 0).spring("top", { response: 180, damping: 1 }).when(v.s.rows.includes(key), (el) => el.opacity(0)))
      .on_hover((h, cx) => { if (h && hdr !== "stream-rest") this.overGroup = hdr; else if (this.overGroup === hdr) this.overGroup = null; if (this.view) cx.notify(); })
      .on_mouse_up("left", (e, cx) => {
        if (this.press?.moving) return; // a drop: the list handles it
        if (isStream) {
          if (e.click_count >= 2 && stream) { groupDialog({ stream }); return; }
          this.streamFolded.has(stream) ? this.streamFolded.delete(stream) : this.streamFolded.add(stream);
          localStorage.setItem("streams.folded", JSON.stringify([...this.streamFolded]));
          cx.notify();
          return;
        }
        if (e.click_count >= 2) { groupDialog({ group: hdr }); return; }
        const s = groupState();
        setShared(GROUPS, { ...s, groups: { ...s.groups, [hdr]: { ...grp, collapsed: !grp.collapsed } } });
      })
      .on_mouse_down("right", () => { if (!isStream) groupDialog({ group: hdr }); else if (stream) groupDialog({ stream }); })
      .child(svg(`mods/workspace-chrome/chevron-${grp.collapsed ? "right" : "down"}.svg`).size(11).flex_none())
      .child(div().flex_shrink(1).min_w(0).truncate().font_semibold().text_color(t.foreground).child(grp.name))
      .child(div().flex_none().text_color(t.dim).child(isStream && repos > 1 ? `${count} · ${repos} repos` : String(count)))
      .child(div().flex_1())
      .when(Boolean(dot), (el) => el.child(div().size(7).rounded(4).flex_none().bg(tone(t, dot))
        .when(dot === "working", (el) => el.loop("opacity", { from: 0.4, to: 1, period: 1200 }))));
  }

  // `ghost`: the copy that follows the pointer while the row is dragged.
  row({ w, i, g, tree, kids, depth, inStream }, t, ghost = false) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const v = ghost ? null : this.view;
    return v_flex()
      .relative()
      .id(`${ghost ? "ghost" : "space"}-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on && !ghost, (el) => el.bg(t.selected))
      .when(!on && !this.view, (el) => el.hover((s) => s.bg(t.hover)))
      // Rows slide aside while one is dragged; the held one leaves a gap where it would land.
      .when(Boolean(v), (el) => el.top(v.shift[w.id] ?? 0).spring("top", { response: 180, damping: 1 })
        .when(v.s.rows.includes(w.id), (el) => el.opacity(0)))
      .on_mouse_down("left", () => {
        this.press = { key: w.id, y: null, dy: 0, moving: false };
      })
      .on_mouse_up("left", () => {
        if (this.press?.key === w.id && !this.press.moving) run("space.select", { id: w.id });
      })
      .on_mouse_down("right", () => this.menu(w))
      .on_hover((hovered, cx) => {
        if (hovered) this.hovered = w.id;
        else if (this.hovered === w.id) this.hovered = null;
        cx.notify();
      })
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(depth === 2 ? 38 : 22))
          .child(this.avatar(w, g, tree, fill, t, inStream))
          .child(div().flex_shrink(1).min_w(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .children(g ? this.gitTail(g, inStream ? null : tree, w.name, t, where(w, panes())) : [div().flex_1()])
          // A repo's main checkout: + starts a new workspace (worktree, setup, agent) in it.
          // Its slot is always there, shown on hover, so nothing beside it moves.
          .when(Boolean(g && !g.linked && g.repo !== JSON.stringify([null, `${home()}/.git`])), (el) => el.child(
            div().id(`space-new-ws-${w.id}`).flex_none().px(5).rounded(4).text_color(t.muted)
              .opacity(this.hovered === w.id ? 1 : 0)
              .hover((s) => s.bg(t.raised).text_color(t.foreground))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_mouse_up("left", (_e, cx) => {
                cx.stop_propagation();
                this.press = null;
                if (this.has["new-workspace"]) openOverlay({ mod: "new-workspace", kind: "dialog", width: 680, height: 640, props: { space: w.id } });
                else openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: w.id, action: "new" } });
              })
              .child("+")))
          // A worktree: the trash icon closes its space and removes the checkout (the dialog warns about uncommitted work).
          .when(Boolean(g?.linked), (el) => el.child(
            div().id(`space-remove-wt-${w.id}`).flex_none().px(5).rounded(4).text_color(t.muted)
              .opacity(this.hovered === w.id ? 1 : 0)
              .hover((s) => s.bg(t.raised).text_color(t.foreground))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_mouse_up("left", (_e, cx) => {
                cx.stop_propagation();
                this.press = null;
                openOverlay({ mod: "worktree", kind: "dialog", width: 480, height: 300, props: { space: w.id, action: "remove" } });
              })
              .child(svg("mods/space-streams/trash.svg").size(13))))
          .when(Boolean(kids), (el) => el.child(this.foldToggle(w, g, kids, t))),
      );
  }

  // The repo's emoji (else the name's first letter on its color); with an agent running in the
  // space, half emoji and half the agent's icon. Click it to choose the emoji (emoji-picker, bundled).
  // In Streams view a row always wears its repo's mark (emoji, else letter on the repo's color),
  // since rows from different repos sit side by side there.
  avatar(w, g, tree, fill, t, inStream = false) {
    const emoji = (shared("space.emoji") ?? {})[emojiKey(w, g)];
    const agent = agentOf(w, panes());
    const mark = emoji
      ? div().size(18).flex_none().flex().items_center().justify_center().text_size(12.5).child(emoji)
      : tree && !agent && !inStream
        ? div().size(18).flex_none().flex().items_center().justify_center().child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim))
        : div().size(18).flex_none().flex().items_center().justify_center().bg(tree ? this.repoFill(g, t) ?? fill : fill).text_size(10.5).font_bold().text_color("#ffffff").child([...(tree ? g?.name ?? w.name : w.name)][0]?.toUpperCase() ?? "?");
    const picker = Boolean(this.has?.["emoji-picker"]);
    return h_flex().id(`avatar-${w.id}`).flex_none().h(18).rounded(5).overflow_hidden().when(picker, (el) => el.cursor_pointer())
      .when(Boolean(emoji || agent), (el) => el.bg(t.raised))
      .when(picker, (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation()))
      .when(picker, (el) => el.on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.press = null;
        openOverlay({ mod: "emoji-picker", kind: "popup", width: 360, height: 300, props: { key: emojiKey(w, g), name: g?.name ?? w.name } });
      }))
      .child(mark)
      .when(Boolean(agent), (el) => el.child(div().w(1).h_full().bg(t.border)).child(div().size(18).flex_none().flex().items_center().justify_center()
        .child(agent.tint ? svg(agent.icon).size(12).text_color(t.muted) : image(agent.icon).w(12).h(12))));
  }

  // A worktree wears its repo's color: the one set on the repo's main checkout space.
  repoFill(g, t) {
    if (!g?.repo) return null;
    const ps = panes(), colors = shared("space.colors") ?? {};
    const main = spaces().find((s) => { const h = this.git[where(s, ps)]; return h && h.repo === g.repo && !h.linked; });
    const color = main ? colors[main.id] ?? "ansi6" : null;
    return color && (color.startsWith("#") ? color : MARK[color] ?? t[color]);
  }

  // Repos | Streams, at the top of the list.
  modeToggle(t) {
    const pill = (mode, label) => div().id(`spaces-mode-${mode}`).px(7).h(20).flex().items_center().rounded(5).cursor_pointer()
      .when(this.mode === mode, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(this.mode !== mode, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { this.mode = mode; localStorage.setItem("spaces.mode", mode); this.press = null; cx.notify(); })
      .child(label);
    return h_flex().gap(2).p(2).rounded(7).bg(t.raised).child(pill("repos", "Repos")).child(pill("streams", "Streams"));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    this.view = collapsed ? null : this.preview();
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child(this.modeToggle(t)))
        .child(div().id("space-new").p(4).rounded(5).hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("space.new")).child("+")))
      .child(v_flex().id("space-list").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .when(Boolean(this.view), (el) => el.cursor_grabbing())
        // A held row starts dragging once the pointer has moved a little; until then it's a click.
        .on_mouse_down("left", (e) => { if (this.press && this.press.y === null) this.press.y = e.local_position?.y ?? null; })
        .on_mouse_move((e, cx) => {
          const p = this.press;
          if (collapsed || !p || p.y === null) return;
          p.dy = e.local_position.y - p.y;
          if (!p.moving && Math.abs(p.dy) < 4) return;
          p.moving = true;
          cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => { this.drop(); cx.notify(); })
        // Let go outside the list: nothing moves.
        .on_hover((hovered, cx) => { if (!hovered && this.press) { this.press = null; cx.notify(); } })
        .child(v_flex().relative().children(this.grouped(t, collapsed))
          .when(Boolean(this.view), (el) => el.child(this.lifted(t)))));
  }
}
