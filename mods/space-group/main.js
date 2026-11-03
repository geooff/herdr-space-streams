// Space groups: a dialog to put a worktree space in a group, or to rename/ungroup a group.
// props { space } — choose a group for that space (or make one).
// props { group } — rename it, ungroup it, collapse the others.
// props { stream } — a work stream (same-named groups across repos): rename or ungroup all.
// State lives in shared("space.groups"); the space-streams sidebar draws it.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, exec, shared, setShared } from "herdr";

export const KEY = "space.groups";
export const state = () => JSON.parse(JSON.stringify(shared(KEY) ?? {}));
const full = (s) => ({ groups: s.groups ?? {}, members: s.members ?? {}, tags: s.tags ?? {} });
const newId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// The same repo key the space-streams sidebar uses: [machine, absolute git common dir].
async function repoOf(space) {
  const on = space.machine ?? null;
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: place(space), on });
  if (r.code !== 0) return null;
  const dir = r.stdout.trim();
  const name = dir.endsWith("/.git") ? dir.slice(0, -5).split("/").pop() : dir.split("/").pop().replace(/\.git$/, "");
  return { key: JSON.stringify([on, dir]), name };
}

export default class SpaceGroup extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.repo = null;
    this.at = 0;
    const g = p.group && full(shared(KEY) ?? {}).groups[p.group];
    const named = p.stream ? Object.values(full(shared(KEY) ?? {}).groups).find((x) => x.name.trim().toLowerCase() === p.stream)?.name : g?.name;
    this.input = InputState.new({ placeholder: p.group || p.stream ? "Name" : "New group…", value: named ?? "" });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
    this.handle = cx.focus_handle();
    const space = p.space && spaces().find((s) => s.id === p.space);
    if (space) cx.spawn(async (cx) => { this.repo = await repoOf(space).catch(() => null); this.loaded = true; cx.notify(); });
  }

  close() { closeOverlay(props().overlay); }

  save(fn) {
    const s = full(state());
    fn(s);
    // Groups nobody is in are gone.
    const used = new Set(Object.values(s.members));
    for (const id of Object.keys(s.groups)) if (!used.has(id)) delete s.groups[id];
    setShared(KEY, s);
  }

  assign(gid) {
    const sid = props().space;
    this.save((s) => { if (gid) s.members[sid] = gid; else delete s.members[sid]; });
    this.close();
  }

  joinNamed(name) {
    const gid = newId();
    this.save((s) => { s.groups[gid] = { name, repo: this.repo.key, collapsed: false, created: Date.now() }; s.members[props().space] = gid; });
    this.close();
  }

  submit() {
    const p = props();
    const name = this.input.value().trim();
    if (p.stream) {
      if (name) this.save((s) => { for (const g of Object.values(s.groups)) if (g.name.trim().toLowerCase() === p.stream) g.name = name; });
      return this.close();
    }
    if (p.group) {
      if (name) this.save((s) => { if (s.groups[p.group]) s.groups[p.group].name = name; });
      return this.close();
    }
    if (!name || !this.repo) return;
    const s = full(shared(KEY) ?? {});
    const same = Object.entries(s.groups).find(([, g]) => g.repo === this.repo.key && g.name.toLowerCase() === name.toLowerCase());
    if (same) return this.assign(same[0]);
    const gid = newId();
    this.save((s) => { s.groups[gid] = { name, repo: this.repo.key, collapsed: false, created: Date.now() }; s.members[p.space] = gid; });
    this.close();
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const s = full(shared(KEY) ?? {});
    const title = (text) => h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().truncate().child(text)).child(div().text_size(11).text_color(t.dim).child("Esc"));
    const field = Input.new(this.input).h(34).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground);
    const button = (id, text, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(7)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).cursor_pointer()
      .hover((st) => st.opacity(0.88)).on_click(action).child(text);
    const root = v_flex().id("space-group").track_focus(this.handle).w_full().min_h(0).p(16).gap(10).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } });

    if (p.stream) {
      const gids = Object.keys(s.groups).filter((id) => s.groups[id].name.trim().toLowerCase() === p.stream);
      const count = Object.values(s.members).filter((v) => gids.includes(v)).length;
      return root.child(title(`Stream · ${count} space${count === 1 ? "" : "s"} in ${gids.length} repo${gids.length === 1 ? "" : "s"}`))
        .child(field)
        .child(div().text_size(11).text_color(t.dim).child("Renames its group in every repo."))
        .child(h_flex().pt(6).gap(8)
          .child(button("sg-ungroup", "Ungroup all", false, () => { this.save((st) => { for (const [k, v] of Object.entries(st.members)) if (gids.includes(v)) delete st.members[k]; }); this.close(); }))
          .child(div().flex_1())
          .child(button("sg-save", "Save", true, (_e, cx) => this.submit(cx))));
    }

    if (p.group) {
      const g = s.groups[p.group];
      if (!g) return root.child(title("Group is gone"));
      const count = Object.values(s.members).filter((v) => v === p.group).length;
      return root.child(title(`Group · ${count} space${count === 1 ? "" : "s"}`))
        .child(field)
        .child(h_flex().pt(6).gap(8)
          .child(button("sg-ungroup", "Ungroup", false, () => { this.save((st) => { for (const [k, v] of Object.entries(st.members)) if (v === p.group) delete st.members[k]; }); this.close(); }))
          .child(button("sg-others", "Collapse others", false, () => { this.save((st) => { for (const [id, o] of Object.entries(st.groups)) if (o.repo === g.repo) o.collapsed = id !== p.group; }); this.close(); }))
          .child(div().flex_1())
          .child(button("sg-save", "Save", true, (_e, cx) => this.submit(cx))));
    }

    const space = spaces().find((x) => x.id === p.space);
    if (!space) return root.child(title("Space is gone"));
    if (!this.loaded) return root.child(title(`Group for ${space.name}`)).child(div().text_size(12).text_color(t.dim).child("Looking at its repo…"));
    if (!this.repo) return root.child(title(`Group for ${space.name}`)).child(div().text_size(12).text_color(t.dim).child("Groups are for a repo's worktree spaces; this one isn't in a repo."));
    const mine = s.members[p.space];
    const groups = Object.entries(s.groups).filter(([, g]) => g.repo === this.repo.key).sort((a, b) => (a[1].created ?? 0) - (b[1].created ?? 0));
    const here = new Set(groups.map(([, g]) => g.name.trim().toLowerCase()));
    const elsewhere = [...new Map(Object.values(s.groups).filter((g) => g.repo !== this.repo.key && !here.has(g.name.trim().toLowerCase()))
      .map((g) => [g.name.trim().toLowerCase(), g.name])).values()];
    const item = (id, label, active, action) => h_flex().id(id).h(30).px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(active, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover)).on_click(action)
      .child(div().w(14).flex_none().text_color(t.accent).child(active ? "✓" : ""))
      .child(div().flex_1().truncate().child(label));
    return root.child(title(`Group for ${space.name}`))
      .child(div().text_size(11.5).text_color(t.dim).child(`Groups in ${this.repo.name}`))
      .child(v_flex().gap(2).children([
        ...groups.map(([id, g]) => item(`sg-${id}`, `${g.name}  ·  ${Object.values(s.members).filter((v) => v === id).length}`, mine === id, () => this.assign(id))),
        ...(groups.length || elsewhere.length ? [] : [div().px(8).text_size(12).text_color(t.dim).child("None yet: name one below.")]),
        ...(elsewhere.length ? [div().px(8).pt(6).text_size(11.5).text_color(t.dim).child("Streams in other repos")] : []),
        ...elsewhere.map((name, n) => item(`sg-x${n}`, name, false, () => { this.joinNamed(name); })),
        ...(mine ? [item("sg-none", "Remove from group", false, () => this.assign(null))] : []),
      ]))
      .child(field)
      .child(div().text_size(11).text_color(t.dim).child("Enter makes the group and moves this space into it."));
  }
}
