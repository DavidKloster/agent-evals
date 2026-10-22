import { escapeHtml } from '../report/html.ts';

/**
 * The viewer's single page: inline CSS and vanilla JavaScript, nothing loaded from elsewhere. Transcripts are untrusted
 * model output, so the script builds every node with createElement and sets text through text nodes only.
 */

const STYLE = String.raw`
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1b1f24; --muted: #5b6470; --border: #d8dde3; --panel: #f6f8fa; --code: #f0f2f5;
  --accent: #2457c5; --pass: #1a7f37; --pass-bg: #dcf5e3; --fail: #b42318; --fail-bg: #fde4e1;
  --unk: #8a5a00; --unk-bg: #fff2cc; --infra: #6941c6; --infra-bg: #ece6fb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --fg: #e5e9ee; --muted: #9aa4b0; --border: #2c333c; --panel: #161b22; --code: #1b2129;
    --accent: #7aa7ff; --pass: #5dd39e; --pass-bg: #12301f; --fail: #ff8a80; --fail-bg: #3a1714;
    --unk: #f5c451; --unk-bg: #3a2e0c; --infra: #b9a3ff; --infra-bg: #261d40;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline;
  padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
header h1 { margin: 0; font-size: 15px; }
header nav { display: flex; flex-wrap: wrap; gap: 6px; }
header .labels-file { margin-left: auto; }
main { padding: 16px; max-width: 1600px; margin: 0 auto; }
a { color: var(--accent); }
h2 { font-size: 18px; margin: 8px 0 12px; }
h3 { font-size: 15px; margin: 20px 0 8px; }
.muted { color: var(--muted); }
.error-box { padding: 10px 12px; border: 1px solid var(--fail); background: var(--fail-bg); color: var(--fail); border-radius: 6px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--border); }
th { font-weight: 600; color: var(--muted); white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.row-link { cursor: pointer; }
tr.row-link:hover td { background: var(--panel); }
button, select, input, textarea { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
button { cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
textarea { width: 100%; resize: vertical; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin: 8px 0 12px; }
.toolbar label { display: inline-flex; gap: 6px; align-items: center; }
.badge { display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.pass { color: var(--pass); background: var(--pass-bg); }
.fail { color: var(--fail); background: var(--fail-bg); }
.unknown { color: var(--unk); background: var(--unk-bg); }
.infra { color: var(--infra); background: var(--infra-bg); }
.neutral { color: var(--muted); background: var(--panel); border: 1px solid var(--border); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.chip { display: inline-block; min-width: 30px; padding: 0 5px; border-radius: 4px; text-align: center; text-decoration: none; font-size: 12px; font-variant-numeric: tabular-nums; }
.chip.dim { opacity: .35; }
.cell-head { white-space: nowrap; }
.event { border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px; padding: 8px 10px; margin: 6px 0; background: var(--bg); }
.event .meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.event.user { border-left-color: var(--accent); }
.event.assistant { border-left-color: var(--pass); }
.event.system, .event.note { border-left-color: var(--muted); }
.event.model_call { border-left-color: var(--infra); }
.event.tool_call, .event.tool_result { border-left-color: var(--unk); }
.event.is-error { border-color: var(--fail); background: var(--fail-bg); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
pre { margin: 4px 0; padding: 8px; background: var(--code); border-radius: 6px; overflow: auto; max-height: 480px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.grade { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
.grade-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.dimension { border-top: 1px dashed var(--border); margin-top: 8px; padding-top: 8px; }
.choices { display: flex; gap: 6px; margin: 6px 0; }
.choice[aria-pressed="true"].pass { outline: 2px solid var(--pass); }
.choice[aria-pressed="true"].fail { outline: 2px solid var(--fail); }
.choice[aria-pressed="true"].unknown { outline: 2px solid var(--unk); }
.judge { margin-top: 6px; padding: 6px 8px; background: var(--panel); border-radius: 6px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .pair { grid-template-columns: 1fr; } }
.kv { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--muted); }
.kv b { color: var(--fg); font-weight: 600; }
`;

// String.raw keeps the backslashes of the script's regular expressions; the script uses no template literals.
const SCRIPT = String.raw`
"use strict";
(() => {
  const app = document.getElementById("app");
  const crumbs = document.getElementById("crumbs");
  const labelsInfo = document.getElementById("labels-file");
  // The server's k (view --k), set on the root element.
  const K = Number(document.documentElement.dataset.k) || 3;
  const state = {
    runs: new Map(),
    labels: [],
    filters: { failed: false, target: "", grader: "", text: "" },
    revealed: new Set(),
    hideUnchanged: true,
  };
  let renderToken = 0;

  // Builds an element; strings and numbers become text nodes, never markup.
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
        else if (key in el && !key.includes("-")) el[key] = value;
        else el.setAttribute(key, value === true ? "" : String(value));
      }
    }
    add(el, children);
    return el;
  }
  function add(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) child.forEach((c) => add(el, c));
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
  const link = (...parts) => "#/" + parts.map((p) => encodeURIComponent(String(p))).join("/");
  const a = (href, ...children) => h("a", { href }, ...children);
  const pct = (v) => (v === null || v === undefined ? "–" : Math.round(v * 100) + "%");
  const fixed = (v, d) => (v === null || v === undefined ? "–" : Number(v).toFixed(d));
  const usd = (v) => (v === null || v === undefined ? "–" : "$" + Number(v).toFixed(4));
  const ms = (v) => (v === null || v === undefined ? "–" : v < 1000 ? Math.round(v) + " ms" : (v / 1000).toFixed(2) + " s");
  const toJson = (v) => { try { const s = JSON.stringify(v, null, 2); return s === undefined ? "undefined" : s; } catch (e) { return String(v); } };
  const key = (...parts) => JSON.stringify(parts);
  const verdictClass = (v) => (v === "pass" ? "pass" : v === "fail" ? "fail" : "unknown");
  const badge = (cls, text) => h("span", { class: "badge " + cls }, text);

  // A long text shows its start and a button to show the rest.
  function longText(text, max) {
    const pre = h("pre");
    if (text.length <= max) { pre.textContent = text; return pre; }
    pre.textContent = text.slice(0, max) + " …";
    const more = h("button", { type: "button", onclick: () => { pre.textContent = text; more.remove(); } },
      "Show all (" + (text.length - max) + " more characters)");
    return h("div", null, pre, more);
  }

  async function api(path, init) {
    const res = await fetch(path, init);
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (!res.ok) throw new Error((body && body.error) || res.status + " " + res.statusText);
    return body;
  }
  function getRun(id) {
    if (!state.runs.has(id)) {
      const p = api("/api/run?id=" + encodeURIComponent(id) + "&k=" + K).then((data) => {
        // Trial indices per suite, task and target, for the cells and the compare view.
        const index = new Map();
        data.run.trials.forEach((t, i) => {
          const k = key(t.suite, t.taskId, t.target);
          if (!index.has(k)) index.set(k, []);
          index.get(k).push(i);
        });
        data.index = index;
        return data;
      });
      p.catch(() => state.runs.delete(id));
      state.runs.set(id, p);
    }
    return state.runs.get(id);
  }
  async function loadLabels() {
    try {
      const body = await api("/api/labels");
      state.labels = body.labels;
      labelsInfo.textContent = "labels: " + body.file;
    } catch (e) {
      labelsInfo.textContent = "labels: " + e.message;
    }
  }

  function getLabeller() { try { return localStorage.getItem("agent-evals.labeller") || ""; } catch (e) { return ""; } }
  function setLabeller(v) { try { localStorage.setItem("agent-evals.labeller", v); } catch (e) { /* private mode */ } }

  function setView(token, title, path, node) {
    if (token !== renderToken) return;
    document.title = title + " · agent-evals";
    crumbs.replaceChildren(...path.flatMap((p, i) => [i ? h("span", { class: "muted" }, "›") : null,
      p.href ? a(p.href, p.text) : h("span", null, p.text)]).filter(Boolean));
    app.replaceChildren(node);
  }

  // ---- (a) the run list ----
  async function showRuns(token) {
    const runs = await api("/api/runs?k=" + K);
    const selected = [];
    const boxes = new Map();
    const compare = h("button", { type: "button", class: "primary", disabled: true, onclick: () => {
      const [x, y] = selected.slice().sort((p, q) => (p.startedAt || "").localeCompare(q.startedAt || ""));
      location.hash = link("compare", x.id, y.id);
    } }, "Compare 0/2");
    const refresh = () => { compare.disabled = selected.length !== 2; compare.textContent = "Compare " + selected.length + "/2"; };
    const rows = runs.map((r) => {
      const box = h("input", { type: "checkbox", "aria-label": "Select " + r.id, disabled: !!r.error, onclick: (e) => e.stopPropagation(),
        onchange: () => {
          if (box.checked) {
            selected.push(r);
            // Two runs at most: the oldest pick gives way.
            if (selected.length > 2) { const old = selected.shift(); boxes.get(old.id).checked = false; }
          } else selected.splice(selected.indexOf(r), 1);
          refresh();
        } });
      boxes.set(r.id, box);
      return h("tr", { class: r.error ? "" : "row-link", onclick: () => { if (!r.error) location.hash = link("run", r.id); } },
        h("td", null, box),
        h("td", null, r.error ? r.id : a(link("run", r.id), r.id), r.error ? h("div", { class: "error-box" }, r.error) : null),
        h("td", null, r.runId || ""),
        h("td", null, r.startedAt ? new Date(r.startedAt).toLocaleString() : "–"),
        h("td", null, r.targets.join(", ")),
        h("td", null, r.suites.map((s) => s.name + " (" + s.kind + ")").join(", ")),
        h("td", { class: "num" }, r.trials),
        h("td", { class: "num" }, pct(r.pass1)));
    });
    const reload = h("button", { type: "button", onclick: () => { state.runs.clear(); render(); } }, "Reload");
    const body = runs.length === 0
      ? h("p", { class: "muted" }, "No run folders (a folder with a run.json) under the results folder.")
      : h("div", { class: "scroll" }, h("table", null,
          h("thead", null, h("tr", null, h("th"), h("th", null, "Folder"), h("th", null, "Run"), h("th", null, "Started"),
            h("th", null, "Targets"), h("th", null, "Suites"), h("th", { class: "num" }, "Trials"), h("th", { class: "num" }, "pass@1"))),
          h("tbody", null, rows)));
    setView(token, "Runs", [{ text: "Runs" }], h("section", null,
      h("h2", null, "Runs"),
      h("div", { class: "toolbar" }, compare, reload, h("span", { class: "muted" }, "Tick two runs to compare them; the older one is the baseline.")),
      body));
  }

  // ---- (b) a run ----
  function graderMatches(g, filter) {
    return filter.startsWith("type:") ? g.type === filter.slice(5) : g.id === filter.slice(3);
  }
  const haystacks = new WeakMap();
  function haystack(t) {
    if (!haystacks.has(t)) {
      const texts = t.transcript.flatMap((e) => (e.type === "message" ? [e.text] : e.type === "error" ? [e.message] : []));
      haystacks.set(t, [t.taskId, t.target, t.error || ""].concat(texts).join(" ").toLowerCase());
    }
    return haystacks.get(t);
  }
  function trialVisible(t) {
    const f = state.filters;
    if (f.target && t.target !== f.target) return false;
    let grades = t.grades;
    if (f.grader) {
      grades = grades.filter((g) => graderMatches(g, f.grader));
      if (grades.length === 0) return false;
    }
    // An ungraded trial (no judge, or the judge failed) is no failure of the agent.
    if (f.failed && (t.ungraded || (f.grader ? grades.every((g) => g.passed) : t.passed))) return false;
    if (f.text && !haystack(t).includes(f.text.toLowerCase())) return false;
    return true;
  }
  function trialClass(t) { return t.status === "infra_error" ? "infra" : t.ungraded ? "unknown" : t.passed ? "pass" : "fail"; }
  function trialLabel(t) { return t.status === "infra_error" ? "infra error" : t.ungraded ? "ungraded" : t.passed ? "passed" : "failed"; }
  function trialChip(runId, run, i, dim) {
    const t = run.trials[i];
    const mark = t.status === "infra_error" ? "!" : t.ungraded ? "?" : t.passed ? "✓" : "✗";
    return h("a", { class: "chip " + trialClass(t) + (dim ? " dim" : ""), href: link("run", runId, "trial", i),
      title: "trial " + t.trial + ": " + t.status + ", " + trialLabel(t) }, mark + t.trial);
  }

  async function showRun(token, id) {
    const data = await getRun(id);
    const { run, summary } = data;
    const f = state.filters;
    const graders = new Map();
    run.trials.forEach((t) => t.grades.forEach((g) => { graders.set("type:" + g.type, "type " + g.type); graders.set("id:" + g.id, g.id); }));
    if (f.target && !run.targets.some((t) => t.name === f.target)) f.target = "";
    if (f.grader && !graders.has(f.grader)) f.grader = "";

    const content = h("div");
    const draw = () => content.replaceChildren(...runBody(id, data));
    const failed = h("input", { type: "checkbox", checked: f.failed, onchange: () => { f.failed = failed.checked; draw(); } });
    const target = h("select", { onchange: () => { f.target = target.value; draw(); } },
      h("option", { value: "" }, "All targets"), run.targets.map((t) => h("option", { value: t.name, selected: f.target === t.name }, t.name)));
    const grader = h("select", { onchange: () => { f.grader = grader.value; draw(); } },
      h("option", { value: "" }, "All graders"), [...graders].sort().map(([v, label]) => h("option", { value: v, selected: f.grader === v }, label)));
    const text = h("input", { type: "search", placeholder: "Search task, messages, errors", value: f.text,
      oninput: () => { f.text = text.value; draw(); } });
    draw();

    const meta = run.meta ? h("details", null, h("summary", null, "Run meta"), h("pre", null, toJson(run.meta))) : null;
    setView(token, id, [{ text: "Runs", href: "#/" }, { text: id }], h("section", null,
      h("h2", null, id),
      h("div", { class: "kv" }, h("span", null, "run ", h("b", null, run.id)),
        h("span", null, "started ", h("b", null, new Date(run.startedAt).toLocaleString())),
        h("span", null, "finished ", h("b", null, new Date(run.finishedAt).toLocaleString())),
        h("span", null, "trials ", h("b", null, run.trials.length)),
        h("span", null, "k ", h("b", null, summary.k))),
      meta,
      h("div", { class: "toolbar" }, h("label", null, failed, "Only failed"), target, grader, text),
      content));
  }

  function runBody(id, data) {
    const { run, summary } = data;
    const f = state.filters;
    const targets = run.targets.map((t) => t.name).filter((t) => !f.target || t === f.target);
    const tasks = new Map(summary.tasks.map((t) => [key(t.suite, t.taskId, t.target), t]));
    const out = [];
    for (const suite of run.suites) {
      const taskIds = suite.tasks.slice();
      run.trials.forEach((t) => { if (t.suite === suite.name && !taskIds.includes(t.taskId)) taskIds.push(t.taskId); });
      const rows = taskIds.flatMap((taskId) => {
        let any = false;
        const cells = targets.map((target) => {
          const indices = data.index.get(key(suite.name, taskId, target)) || [];
          const visible = indices.filter((i) => trialVisible(run.trials[i]));
          if (visible.length) any = true;
          const s = tasks.get(key(suite.name, taskId, target));
          if (!s) return h("td", { class: "muted" }, "–");
          const cls = s.pass1 === null ? "infra" : s.c === s.n ? "pass" : s.c === 0 ? "fail" : "unknown";
          return h("td", null,
            h("div", { class: "cell-head" }, badge(cls, s.c + "/" + s.n), " ", h("span", { class: "muted" }, "pass^" + summary.k + " " + pct(s.passHatK))),
            h("div", { class: "chips" }, visible.map((i) => trialChip(id, run, i, false))));
        });
        return any ? [h("tr", null, h("th", { scope: "row" }, taskId), cells)] : [];
      });
      const groups = summary.groups.filter((g) => g.suite === suite.name && (!f.target || g.target === f.target));
      out.push(h("h3", null, suite.name + " ", badge("neutral", suite.kind)));
      out.push(h("div", { class: "scroll" }, h("table", null,
        h("thead", null, h("tr", null, h("th", null, "Target"), h("th", { class: "num" }, "pass@1"), h("th", { class: "num" }, "pass@" + summary.k),
          h("th", { class: "num" }, "pass^" + summary.k), h("th", { class: "num" }, "graded"), h("th", { class: "num" }, "USD/task"),
          h("th", { class: "num" }, "TTFT p50"), h("th", { class: "num" }, "reply p50"), h("th", { class: "num" }, "infra errors"), h("th", { class: "num" }, "grader errors"), h("th", { class: "num" }, "grading errors"))),
        h("tbody", null, groups.map((g) => h("tr", null, h("td", null, g.target), h("td", { class: "num" }, pct(g.pass1)),
          h("td", { class: "num" }, pct(g.passAtK)), h("td", { class: "num" }, pct(g.passHatK)), h("td", { class: "num" }, g.graded),
          h("td", { class: "num" }, (g.costComplete ? "" : "≥") + usd(g.perTask.costUsd)), h("td", { class: "num" }, ms(g.ttftMs.p50)),
          h("td", { class: "num" }, ms(g.replyMs.p50)), h("td", { class: "num" }, g.infraErrors), h("td", { class: "num" }, g.graderErrors), h("td", { class: "num" }, g.gradingErrors ?? 0)))))));
      out.push(rows.length
        ? h("div", { class: "scroll" }, h("table", null,
            h("thead", null, h("tr", null, h("th", null, "Task"), targets.map((t) => h("th", null, t)))),
            h("tbody", null, rows)))
        : h("p", { class: "muted" }, "No trial matches the filters."));
    }
    return out;
  }

  // ---- (c) the transcript reader ----
  function eventNode(e, t0) {
    const at = h("span", null, "+" + ((e.at - t0) / 1000).toFixed(2) + " s");
    switch (e.type) {
      case "message":
        return h("div", { class: "event " + e.role }, h("div", { class: "meta" }, h("b", null, e.role), at,
          e.firstTokenAt ? h("span", null, "first token +" + ((e.firstTokenAt - t0) / 1000).toFixed(2) + " s") : null),
          h("div", { class: "text" }, e.text));
      case "model_call":
        return h("div", { class: "event model_call" + (e.error ? " is-error" : "") }, h("div", { class: "meta" }, h("b", null, "model call"), at,
          h("span", null, e.model + (e.provider ? " via " + e.provider : "")),
          h("span", null, "latency " + ms(e.endedAt - e.startedAt)),
          e.firstTokenAt ? h("span", null, "TTFT " + ms(e.firstTokenAt - e.startedAt)) : null,
          h("span", null, "tokens " + (e.inputTokens ?? "?") + " in / " + (e.outputTokens ?? "?") + " out"),
          h("span", null, "cost " + usd(e.costUsd))),
          e.error ? h("div", { class: "text" }, e.error) : null);
      case "tool_call":
        return h("div", { class: "event tool_call" }, h("div", { class: "meta" }, h("b", null, "tool call " + e.name), at, h("span", null, e.id)),
          longText(toJson(e.args), 4000));
      case "tool_result":
        return h("div", { class: "event tool_result" + (e.error ? " is-error" : "") }, h("div", { class: "meta" }, h("b", null, "tool result " + e.name), at, h("span", null, e.id)),
          e.error ? h("div", { class: "text" }, "error: " + e.error) : null, longText(toJson(e.result), 1500));
      case "error":
        return h("div", { class: "event is-error" }, h("div", { class: "meta" }, h("b", null, "error (" + e.kind + ")"), at), h("div", { class: "text" }, e.message));
      default:
        return h("div", { class: "event note" }, h("div", { class: "meta" }, h("b", null, e.type || "event"), at),
          e.text ? h("div", { class: "text" }, e.text) : null, e.data !== undefined ? longText(toJson(e.data), 1500) : null);
    }
  }

  function judgeDimensions(g) {
    const d = g.details && g.details.dimensions;
    return Array.isArray(d) ? d.filter((x) => x && typeof x.name === "string") : [];
  }
  function findLabel(t, grader, dimension) {
    return state.labels.find((l) => (!l.suite || l.suite === t.suite) && l.taskId === t.taskId && l.target === t.target
      && l.trial === t.trial && l.grader === grader && l.dimension === dimension);
  }
  function judgeBox(d) {
    return h("div", { class: "judge" }, "Judge: ", badge(verdictClass(d.verdict), d.verdict), " ", d.reason || "",
      Array.isArray(d.votes) && d.votes.length > 1 ? h("ul", null, d.votes.map((v) => h("li", null, v.model + ": ", badge(verdictClass(v.verdict), v.verdict), " " + (v.reason || "")))) : null);
  }

  // A labelling control per judge dimension. The judge's verdict stays hidden until the person saved a label or asks
  // for it, so the label isn't anchored on it.
  function dimensionNode(t, g, d, labeller, redraw) {
    const existing = findLabel(t, g.id, d.name);
    const revealKey = key(t.suite, t.taskId, t.target, t.trial, g.id);
    let choice = existing ? existing.label : "";
    const buttons = ["pass", "fail", "unknown"].map((v) => h("button", { type: "button", class: "choice " + verdictClass(v),
      "aria-pressed": String(choice === v), onclick: () => { choice = v; buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(["pass", "fail", "unknown"][i] === v))); } }, v));
    const note = h("textarea", { rows: 2, maxLength: 2000, placeholder: "Note (optional)", value: existing && existing.note ? existing.note : "" });
    const status = h("span", { class: "muted" }, existing ? "Saved: " + existing.label + (existing.labeller ? " by " + existing.labeller : "") : "");
    const save = h("button", { type: "button", class: "primary", onclick: async () => {
      if (!choice) { status.textContent = "Choose pass, fail or unknown first."; return; }
      const label = { suite: t.suite, taskId: t.taskId, target: t.target, trial: t.trial, grader: g.id, dimension: d.name, label: choice };
      if (labeller.value.trim()) label.labeller = labeller.value.trim();
      if (note.value.trim()) label.note = note.value.trim();
      save.disabled = true;
      status.textContent = "Saving …";
      try {
        const body = await api("/api/labels", { method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Evals": "1" },
          body: JSON.stringify({ labels: [label] }) });
        state.labels = body.labels;
        redraw();
      } catch (e) {
        save.disabled = false;
        status.textContent = "Not saved: " + e.message;
      }
    } }, existing ? "Update label" : "Save label");
    const shown = existing || state.revealed.has(revealKey);
    return h("div", { class: "dimension" },
      h("div", null, h("b", null, d.name), d.question ? h("span", null, " — " + d.question) : null),
      h("div", { class: "choices" }, buttons), note, h("div", { class: "toolbar" }, save, status),
      shown ? judgeBox(d) : h("div", { class: "muted" }, "The judge's verdict shows once you saved your label."));
  }

  function gradeNode(t, g, labeller) {
    const box = h("div", { class: "grade" });
    const dims = judgeDimensions(g);
    const revealKey = key(t.suite, t.taskId, t.target, t.trial, g.id);
    const draw = () => {
      const allLabelled = dims.every((d) => findLabel(t, g.id, d.name));
      const shown = dims.length === 0 || allLabelled || state.revealed.has(revealKey);
      const verdict = g.error ? badge("fail", "grader error") : g.unknown ? badge("unknown", "unknown") : g.passed ? badge("pass", "pass") : badge("fail", "fail");
      const head = h("div", { class: "grade-head" }, h("b", null, g.id), h("span", { class: "muted" }, g.type),
        shown ? verdict : badge("neutral", "verdict hidden"),
        shown ? h("span", { class: "muted" }, "score " + fixed(g.score, 2) + " · weight " + g.weight + (g.required ? " · required" : "")) : null,
        dims.length && !state.revealed.has(revealKey) && !allLabelled
          ? h("button", { type: "button", onclick: () => { state.revealed.add(revealKey); draw(); } }, "Show judge")
          : null);
      const parts = [head];
      if (g.error) parts.push(h("div", { class: "error-box" }, g.error));
      if (dims.length) parts.push(dims.map((d) => dimensionNode(t, g, d, labeller, draw)));
      if (shown && g.assertions.length && !dims.length) {
        parts.push(h("div", { class: "scroll" }, h("table", null,
          h("thead", null, h("tr", null, h("th", null, "Assertion"), h("th", null, "Result"), h("th", null, "Expected"), h("th", null, "Actual"), h("th", null, "Message"))),
          h("tbody", null, g.assertions.map((x) => h("tr", null, h("td", null, x.name),
            h("td", null, x.passed ? badge("pass", "pass") : badge("fail", "fail")),
            h("td", null, x.expected === undefined ? "" : longText(toJson(x.expected), 400)),
            h("td", null, x.actual === undefined ? "" : longText(toJson(x.actual), 400)),
            h("td", { class: "text" }, x.message || "")))))));
      }
      if (shown && g.details !== undefined && !dims.length) parts.push(h("details", null, h("summary", null, "Details"), longText(toJson(g.details), 4000)));
      box.replaceChildren(...parts.flat());
    };
    draw();
    return box;
  }

  function transcriptNode(runId, run, i) {
    const t = run.trials[i];
    if (!t) return h("div", { class: "error-box" }, "No trial " + i + " in " + runId);
    const m = t.metrics;
    const labeller = h("input", { type: "text", maxLength: 200, placeholder: "Your name", value: getLabeller(), oninput: () => setLabeller(labeller.value) });
    const t0 = t.transcript.length ? t.transcript[0].at : 0;
    return h("article", null,
      h("h2", null, t.suite + " / " + t.taskId + " / " + t.target + " / trial " + t.trial),
      h("div", { class: "toolbar" }, badge(trialClass(t), trialLabel(t)),
        h("span", { class: "muted" }, t.status + " · score " + fixed(t.score, 2) + " · attempts " + t.attempts),
        h("span", { class: "muted" }, a(link("run", runId), runId))),
      t.error ? h("div", { class: "error-box" }, t.error) : null,
      t.gradingError ? h("div", { class: "error-box" }, "Not graded: " + t.gradingError) : null,
      t.infraErrors.length ? h("details", null, h("summary", null, t.infraErrors.length + " infrastructure errors"), h("ul", null, t.infraErrors.map((x) => h("li", null, x)))) : null,
      h("div", { class: "kv" },
        h("span", null, "duration ", h("b", null, ms(m.durationMs))),
        h("span", null, "turns ", h("b", null, m.turns)),
        h("span", null, "model calls ", h("b", null, m.modelCalls)),
        h("span", null, "tool calls ", h("b", null, m.toolCalls)),
        h("span", null, "tokens ", h("b", null, m.inputTokens + " in / " + m.outputTokens + " out")),
        h("span", null, "cost ", h("b", null, (m.costComplete ? "" : "≥") + usd(m.costUsd))),
        h("span", null, "TTFT ", h("b", null, m.ttftMs.map(ms).join(", ") || "–")),
        h("span", null, "reply ", h("b", null, m.replyMs.map(ms).join(", ") || "–"))),
      h("h3", null, "Graders"),
      h("label", { class: "toolbar" }, "Labeller", labeller),
      t.grades.length ? t.grades.map((g) => gradeNode(t, g, labeller)) : h("p", { class: "muted" }, "No grader ran."),
      h("h3", null, "Transcript"),
      t.transcript.length ? t.transcript.map((e) => eventNode(e, t0)) : h("p", { class: "muted" }, "Empty transcript."),
      h("h3", null, "Outcome"),
      longText(toJson(t.outcome), 6000));
  }

  async function showTrial(token, id, i) {
    const data = await getRun(id);
    const run = data.run;
    const t = run.trials[i];
    // Previous and next follow the run's filters, so a reviewer can walk the failures.
    const order = run.trials.map((_, j) => j).filter((j) => j === i || trialVisible(run.trials[j]));
    const at = order.indexOf(i);
    const prev = order[at - 1];
    const next = order[at + 1];
    const nav = h("div", { class: "toolbar" },
      prev !== undefined ? a(link("run", id, "trial", prev), "← previous") : h("span", { class: "muted" }, "← previous"),
      next !== undefined ? a(link("run", id, "trial", next), "next →") : h("span", { class: "muted" }, "next →"),
      h("span", { class: "muted" }, (at + 1) + " of " + order.length + (order.length < run.trials.length ? " (filtered)" : "")));
    setView(token, t ? t.taskId : "Trial", [{ text: "Runs", href: "#/" }, { text: id, href: link("run", id) }, { text: t ? t.taskId + " #" + t.trial : String(i) }],
      h("section", null, nav, transcriptNode(id, run, i)));
  }

  // ---- (d) two runs compared ----
  async function showCompare(token, beforeId, afterId) {
    const [diff, before, after] = await Promise.all([
      api("/api/diff?before=" + encodeURIComponent(beforeId) + "&after=" + encodeURIComponent(afterId) + "&k=" + K),
      getRun(beforeId), getRun(afterId)]);
    const content = h("div");
    const chipsOf = (runId, data, row, dims) => (data.index.get(key(row.suite, row.taskId, row.target)) || []).map((i) => trialChip(runId, data.run, i, dims));
    const side = (s) => (s ? h("span", null, badge(s.pass1 === null ? "infra" : s.c === s.n ? "pass" : s.c === 0 ? "fail" : "unknown", s.c + "/" + s.n), " " + pct(s.pass1) + " · pass^" + diff.k + " " + pct(s.passHatK)) : h("span", { class: "muted" }, "–"));
    const kindClass = { regression: "fail", improvement: "pass", new: "neutral", removed: "neutral", incomparable: "infra", unchanged: "neutral" };
    const pairLink = (row) => {
      const b = before.index.get(key(row.suite, row.taskId, row.target)) || [];
      const x = after.index.get(key(row.suite, row.taskId, row.target)) || [];
      if (!b.length || !x.length) return null;
      // The first failure of the later run against the same trial number of the earlier one.
      const failed = (t) => !t.passed && !t.ungraded && t.status !== "infra_error";
      const ai = x.find((i) => failed(after.run.trials[i])) ?? x[0];
      const bi = b.find((i) => before.run.trials[i].trial === after.run.trials[ai].trial) ?? b[0];
      return a(link("pair", beforeId, bi, afterId, ai), "side by side");
    };
    const hide = h("input", { type: "checkbox", checked: state.hideUnchanged, onchange: () => { state.hideUnchanged = hide.checked; draw(); } });
    const draw = () => {
      const rows = diff.tasks.filter((row) => !state.hideUnchanged || row.kind !== "unchanged");
      content.replaceChildren(rows.length
        ? h("div", { class: "scroll" }, h("table", null,
            h("thead", null, h("tr", null, h("th", null, "Change"), h("th", null, "Suite"), h("th", null, "Task"), h("th", null, "Target"),
              h("th", null, "Before: " + beforeId), h("th", null, "After: " + afterId), h("th", { class: "num" }, "Δ pass@1"), h("th"))),
            h("tbody", null, rows.map((row) => h("tr", null,
              h("td", null, badge(kindClass[row.kind] || "neutral", row.kind === "regression" ? "worse" : row.kind === "improvement" ? "better" : row.kind === "unchanged" ? "same" : row.kind)),
              h("td", null, row.suite), h("td", null, row.taskId), h("td", null, row.target),
              h("td", null, side(row.before), h("div", { class: "chips" }, chipsOf(beforeId, before, row, false))),
              h("td", null, side(row.after), h("div", { class: "chips" }, chipsOf(afterId, after, row, false))),
              h("td", { class: "num" }, row.pass1Change === null ? "–" : (row.pass1Change > 0 ? "+" : "") + Math.round(row.pass1Change * 100) + " pp"),
              h("td", null, pairLink(row)))))))
        : h("p", { class: "muted" }, "No task changed."));
    };
    draw();
    const groups = h("div", { class: "scroll" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Suite"), h("th", null, "Target"), h("th", { class: "num" }, "pass@1"), h("th", { class: "num" }, "pass^" + diff.k),
        h("th", { class: "num" }, "USD/task"), h("th", { class: "num" }, "reply p50"))),
      h("tbody", null, diff.groups.map((g) => {
        const cell = (field, fmt) => h("td", { class: "num" }, fmt(g.before ? g.before[field] : null) + " → " + fmt(g.after ? g.after[field] : null));
        return h("tr", null, h("td", null, g.suite), h("td", null, g.target), cell("pass1", pct), cell("passHatK", pct), cell("costUsd", usd), cell("replyP50", ms));
      }))));
    setView(token, "Compare", [{ text: "Runs", href: "#/" }, { text: beforeId + " → " + afterId }], h("section", null,
      h("h2", null, beforeId + " → " + afterId),
      h("div", { class: "toolbar" }, badge(diff.regressions ? "fail" : "neutral", diff.regressions + " worse"), badge(diff.improvements ? "pass" : "neutral", diff.improvements + " better"),
        h("span", { class: "muted" }, "a drop of pass@1 by " + Math.round(diff.minDrop * 100) + " pp or of pass^" + diff.k + " from 100% counts as worse"),
        a(link("compare", afterId, beforeId), "swap")),
      groups,
      h("h3", null, "Tasks"),
      h("div", { class: "toolbar" }, h("label", null, hide, "Hide unchanged")),
      content));
  }

  async function showPair(token, beforeId, bi, afterId, ai) {
    const [before, after] = await Promise.all([getRun(beforeId), getRun(afterId)]);
    setView(token, "Side by side", [{ text: "Runs", href: "#/" }, { text: beforeId + " → " + afterId, href: link("compare", beforeId, afterId) }, { text: "side by side" }],
      h("section", { class: "pair" },
        h("div", null, h("p", { class: "muted" }, "Before: ", a(link("run", beforeId), beforeId)), transcriptNode(beforeId, before.run, bi)),
        h("div", null, h("p", { class: "muted" }, "After: ", a(link("run", afterId), afterId)), transcriptNode(afterId, after.run, ai))));
  }

  async function render() {
    const token = ++renderToken;
    try {
      const parts = location.hash.replace(/^#\/?/, "").split("/").filter((p) => p !== "").map(decodeURIComponent);
      if (parts[0] === "run" && parts[2] === "trial") await showTrial(token, parts[1], Number(parts[3]));
      else if (parts[0] === "run" && parts[1]) await showRun(token, parts[1]);
      else if (parts[0] === "compare" && parts[2]) await showCompare(token, parts[1], parts[2]);
      else if (parts[0] === "pair" && parts[4]) await showPair(token, parts[1], Number(parts[2]), parts[3], Number(parts[4]));
      else await showRuns(token);
    } catch (e) {
      setView(token, "Error", [{ text: "Runs", href: "#/" }], h("div", { class: "error-box" }, e && e.message ? e.message : String(e)));
    }
  }

  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
  loadLabels().then(render);
})();
`;

/** The viewer's page; the nonce goes on its one script and one style element for the Content-Security-Policy. */
export function viewerPage(nonce?: string, k = 3): string {
  const attr = nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
  return `<!doctype html>
<html lang="en" data-k="${Math.max(1, Math.floor(k))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>agent-evals</title>
<style${attr}>${STYLE}</style>
</head>
<body>
<header><h1>agent-evals</h1><nav id="crumbs" aria-label="Breadcrumb"></nav><span id="labels-file" class="labels-file muted"></span></header>
<main id="app"><p class="muted">Loading …</p></main>
<script${attr}>${SCRIPT}</script>
</body>
</html>
`;
}
