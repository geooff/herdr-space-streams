// A popup for a space's (really its repo's) emoji. props: { key, name, overlay }.
// Without props (a key bound to "mod.open:emoji-picker"), it's for the focused space's repo.
// Choices live in shared("space.emoji"): { [key]: "🦊" }, read by sidebars such as space-streams.
// Keys: a repo's is JSON [machine, absolute git common dir]; a space outside a repo's is "space:<id>".
// Search uses macOS's own emoji search data (system-index.py), so "fox", "celebrate"
// or "coffee" find what the system picker would.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, shared, setShared, closeOverlay, theme, exec, appHome, spaces, panes } from "herdr";

// The focused space's target: its repo (shared by the repo's worktrees), else the space itself.
async function focusedTarget() {
  const s = spaces().find((x) => x.active);
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  const cwd = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
  const on = s.machine ?? null;
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }).catch(() => null);
  if (!r || r.code !== 0) return { key: `space:${s.id}`, name: s.name };
  const dir = r.stdout.trim();
  const name = dir.endsWith("/.git") ? dir.slice(0, -5).split("/").pop() : dir.split("/").pop().replace(/\.git$/, "");
  return { key: JSON.stringify([on, dir]), name };
}

const KEY = "space.emoji";
// Every match shows (scroll for more); the cap only guards a one-letter search.
const COLUMNS = 10, SHOWN = 500, GRID_HEIGHT = 5 * 30 + 4 * 2;
const START = [
  "🚀", "🧠", "🧪", "🛠️", "⚙️", "🔥", "✨", "🌱", "🌊", "⚡️",
  "🎯", "📦", "🧩", "🗺️", "🧭", "🏗️", "🎨", "🖼️", "👗", "👕",
  "🛍️", "💸", "📈", "📊", "🗄️", "🔒", "🤖", "👾", "🐙", "🦊",
  "🐝", "🦄", "🐳", "🦉", "🌵", "🍄", "🍋", "🍕", "☕️", "🎲",
  "🏴‍☠️", "⛵️", "🪐", "🌙", "☀️", "🌈", "💎", "🔮", "🎸", "📚",
];

// The system index, built once per load of this mod and shared by every popup.
let index = null;
async function loadIndex() {
  if (index) return index;
  const r = await exec("python3", ["-I", `${appHome()}/mods/emoji-picker/system-index.py`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "no emoji index");
  const data = JSON.parse(r.stdout);
  index = { ...data, vocabulary: Object.keys(data.terms) };
  return index;
}

// Every word must match a search term (whole, or as its start, while typing). An emoji whose
// own name has the word ranks first, then the system's order for that term.
function search(ix, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  let scores = null;
  for (const word of words) {
    const found = new Map();
    const terms = ix.terms[word] ? [word] : [];
    for (const term of ix.vocabulary) if (terms.length < 40 && term !== word && term.startsWith(word)) terms.push(term);
    for (const term of terms) {
      ix.terms[term].forEach((i, rank) => {
        const name = (ix.names[ix.items[i]] ?? "").toLowerCase();
        const score = (term === word ? 2 : 1) + (name.split(/\s+/).some((w) => w.startsWith(word)) ? 4 : 0) + 1 / (rank + 1);
        found.set(i, Math.max(found.get(i) ?? 0, score));
      });
    }
    scores = scores ? new Map([...scores].filter(([i]) => found.has(i)).map(([i, s]) => [i, s + found.get(i)])) : found;
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, SHOWN).map(([i]) => ix.items[i]);
}

export default class EmojiPicker extends View {
  init(_props, cx) {
    this.query = ""; this.results = []; this.error = null; this.hover = null;
    this.input = InputState.new({ placeholder: "Search emoji" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.update(cx); });
    this.input.focus();
    const p = props() ?? {};
    this.target = p.key ? { key: p.key, name: p.name } : null;
    if (!this.target) cx.spawn(async (cx) => { this.target = await focusedTarget(); cx.notify(); });
    cx.spawn(async (cx) => {
      try { await loadIndex(); } catch (e) { this.error = String(e?.message ?? e); }
      this.update(cx);
    });
  }

  update(cx) {
    this.results = index ? search(index, this.query) : [];
    cx.notify();
  }

  pick(emoji) {
    const key = this.target?.key, overlay = props()?.overlay;
    if (!key) return;
    const all = { ...(shared(KEY) ?? {}) };
    if (emoji) all[key] = emoji; else delete all[key];
    setShared(KEY, all);
    closeOverlay(overlay);
  }

  render() {
    const t = theme(), key = this.target?.key, name = this.target?.name ?? "…", now = key ? (shared(KEY) ?? {})[key] : undefined;
    const searching = Boolean(this.query.trim());
    const shown = searching ? this.results : START;
    const cell = (e, i) => div().id(`emoji-${i}`).size(30).flex().items_center().justify_center().rounded(6).text_size(17).cursor_pointer()
      .when(e === now, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.hover = e; else if (this.hover === e) this.hover = null; cx.notify(); })
      .on_click(() => this.pick(e)).child(e);
    const rows = [];
    for (let i = 0; i < shown.length; i += COLUMNS) rows.push(h_flex().gap(2).children(shown.slice(i, i + COLUMNS).map((e, j) => cell(e, i + j))));
    const label = this.hover ? index?.names[this.hover] ?? this.hover
      : this.error ? `Search unavailable: ${this.error}`
      : searching && !index ? "Loading the system's emoji…"
      : searching && !shown.length ? "No emoji match"
      : searching ? `${shown.length}${shown.length === SHOWN ? "+" : ""} match${shown.length === 1 ? "" : "es"}` : "Type to search all emoji";
    return v_flex().id("emoji-picker").size_full().p(10).gap(8).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(`Icon for ${name}`))
        .when(Boolean(now), (el) => el.child(div().id("emoji-clear").px(6).py(2).rounded(5).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.pick(null)).child("Use letter"))))
      .child(Input.new(this.input).h(30).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
      // A popup sizes to its content, so the grid gets a fixed five-row height and scrolls past it.
      .child(v_flex().id("emoji-grid").flex_none().h(GRID_HEIGHT).overflow_y_scrollbar().gap(2).children(rows))
      .child(div().flex_none().h(16).text_size(11).text_color(t.dim).truncate().child(label));
  }
}
