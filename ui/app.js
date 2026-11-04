// SIEGE web UI: compile as you type, lay siege over SSE, red-line the mandate, try a transaction, export.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const near = (n) => Number(n).toFixed(2);
  const GUARD = { outlayer: "Plain OutLayer policy", mandate: "Mandate guard" };
  const SHORT = { outlayer: "Plain policy", mandate: "Mandate guard" };
  const GENERATIONS = 30;

  const ta = $("#mandate");
  const status = $("#doc-status");
  const siegeBtn = $("#siege-btn");
  const editBtn = $("#edit-btn");
  const clausesEl = $("#clauses");
  const generalEl = $("#general");
  const siegeEl = $("#siege");
  const stateEl = $("#siege-state");

  let compiled = null; // last good compile response
  let compileOk = false;
  let compileSeq = 0;
  let es = null;
  let legit = new Set();
  let lastBudget = null; // the Mandate guard's new-payee budget, from the finished siege

  // ---------- helpers ----------
  const human = (code) => {
    const s = String(code).replace(/^JUDGE:/, "judge: ").replace(/_/g, " ").toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const list = (xs) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs.at(-1));
  const monoList = (xs) => {
    const f = document.createDocumentFragment();
    xs.forEach((x, i) => {
      if (i) f.append(i === xs.length - 1 ? " and " : ", ");
      f.append(el("span", { class: "mono", text: x }));
    });
    return f;
  };
  const hours = (h) => (h === 24 ? "per day" : h === 1 ? "per hour" : h === 168 ? "per week" : h % 24 === 0 ? `per ${h / 24} days` : `per ${h} hours`);

  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // Render an account id in mono, marking the characters that differ from the real payee it imitates.
  function account(id) {
    const span = el("span");
    if (!id) return span;
    let best = null, bd = Infinity;
    for (const l of legit) {
      if (l === id) return span.append(id), span;
      const name = l.split(".")[0];
      const dd = id.includes(name) ? 1 : lev(id, l);
      if (dd < bd) (bd = dd), (best = l);
    }
    if (!best || bd > 2) return span.append(id), span;
    let p = 0;
    while (p < id.length && p < best.length && id[p] === best[p]) p++;
    let s = 0;
    while (s < id.length - p && s < best.length - p && id[id.length - 1 - s] === best[best.length - 1 - s]) s++;
    span.append(id.slice(0, p), el("mark", { text: id.slice(p, id.length - s), title: `imitates ${best}` }), id.slice(id.length - s));
    return span;
  }

  // ---------- compile ----------
  async function compile() {
    const text = ta.value;
    const seq = ++compileSeq;
    if (!text.trim()) return showCompileError("Write a mandate first. Say who the agent may pay, how much per transaction, and how much per day.");
    $(".reading").setAttribute("aria-busy", "true");
    status.dataset.tone = "";
    status.textContent = "Reading the mandate…";
    try {
      const r = await fetch("/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mandate: text }) });
      if (seq !== compileSeq) return;
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return showCompileError(r.status === 422 ? `This mandate does not compile: ${j.error}.` : j.error || `The server answered ${r.status}.`);
      compiled = j;
      compileOk = true;
      ta.removeAttribute("aria-invalid");
      status.textContent = "";
      siegeBtn.removeAttribute("aria-disabled");
      renderReading(j.constraints);
      renderExport(j, text);
    } catch {
      if (seq !== compileSeq) return;
      showCompileError("Can't reach the SIEGE server. Start it with npm start, then edit the mandate to retry.");
    } finally {
      if (seq === compileSeq) $(".reading").removeAttribute("aria-busy");
    }
  }
  function showCompileError(msg) {
    compileOk = false;
    ta.setAttribute("aria-invalid", "true");
    status.dataset.tone = "error";
    status.textContent = msg;
    siegeBtn.setAttribute("aria-disabled", "true");
    $(".reading").removeAttribute("aria-busy");
  }
  // Grow the mandate to fit its text (where field-sizing: content is missing, as on Safari and Firefox).
  const sizesItself = CSS.supports("field-sizing", "content");
  function fit() {
    if (sizesItself || ta.hidden) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }
  let debounce;
  ta.addEventListener("input", () => {
    fit();
    clearTimeout(debounce);
    debounce = setTimeout(compile, 400);
  });

  function renderReading(c) {
    const dl = $("#reading");
    dl.replaceChildren();
    const row = (k, v) => dl.append(el("div", { class: "reading__row" }, el("dt", { text: k }), el("dd", {}, v)));
    row("May pay", typeof c.payees === "string" ? c.payees.charAt(0).toUpperCase() + c.payees.slice(1) : c.payees.length ? monoList(c.payees) : "Nobody by transfer");
    if (c.suffixes?.length) row("Also any account under", monoList(c.suffixes));
    if (c.denied?.length) row("Never pays", monoList(c.denied));
    const per = Object.entries(c.perTransaction || {});
    row("Per transaction", per.length ? per.map(([t, v]) => `${v} ${t === "*" ? "of any token" : t}`).join(", ") : "No cap");
    row("Over time", c.windows?.length ? c.windows.map((w) => `${w.cap} ${w.token === "*" ? "of any token" : w.token} ${hours(w.hours)}`).join(", ") : "No cap over time");
    row("Kinds", c.kinds.length ? list(c.kinds.map((k) => (k === "call" ? "contract calls" : k === "transfer" ? "transfers" : k + "s"))).replace(/^./, (x) => x.toUpperCase()) : "None");
    if (c.methods?.length) row("Methods", monoList(c.methods));
    if (c.swaps?.length) row("Swaps", c.swaps.map((p) => (Array.isArray(p) ? p.join(" to ") : String(p))).join(", "));
    if (c.activeHoursUtc) row("Hours", `${c.activeHoursUtc.join?.(" to ") ?? JSON.stringify(c.activeHoursUtc)} UTC`);
    row("Purposes", c.purposes?.length ? list(c.purposes).replace(/^./, (x) => x.toUpperCase()) : "Any purpose");
  }

  // ---------- export ----------
  function renderExport(j, text) {
    $("#x-policy").textContent = JSON.stringify(j.outlayerPolicy, null, 2);
    $("#x-guard").textContent = JSON.stringify(j.guardConfig, null, 2);
    const esc = text.replace(/\s+/g, " ").trim().replace(/(["\\$`])/g, "\\$1");
    $("#x-proxy").textContent = `MANDATE="${esc}" \\\n  npm run proxy`;
    const ctx = { userInstruction: "Pay the hosting invoice from cloudhost.testnet.", retrieved: ["Invoice #4471. Amount due: 3 NEAR. Pay to: cloudhost.testnet."], reasoning: "The user asked me to pay this invoice.", provenance: "user" };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(ctx))));
    $("#x-header").textContent = `x-siege-context: ${b64}\n\n# decoded\n${JSON.stringify(ctx, null, 2)}`;
  }
  $$("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const t = $("#" + b.dataset.copy).textContent;
      try {
        await navigator.clipboard.writeText(t);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Select and copy";
      }
      setTimeout(() => (b.textContent = "Copy"), 1600);
    }),
  );

  // ---------- examples ----------
  let examples = null;
  const pick = $("#example-select");
  async function loadExample(name) {
    try {
      examples ??= await (await fetch("/api/examples")).json();
    } catch {
      return showCompileError("Can't reach the SIEGE server to load the examples.");
    }
    setMode("edit");
    ta.value = examples[name] ?? ta.value;
    fit();
    $$("[data-example]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.example === name)));
    pick.value = name;
    resetSiege();
    compile();
  }
  $$("[data-example]").forEach((b) => b.addEventListener("click", () => loadExample(b.dataset.example)));
  pick.addEventListener("change", () => pick.value && loadExample(pick.value));

  // ---------- document modes ----------
  function setMode(mode) {
    const annotated = mode === "annotated";
    ta.hidden = annotated;
    clausesEl.hidden = !annotated;
    generalEl.hidden = !annotated || !generalEl.childElementCount;
    editBtn.hidden = !annotated;
    fit();
  }
  editBtn.addEventListener("click", () => {
    setMode("edit");
    ta.focus();
  });

  // ---------- siege ----------
  const guards = {};
  for (const g of ["outlayer", "mandate"]) {
    const root = $(`#g-${g}`);
    guards[g] = { root, num: $(".guard__num", root), phase: $(".guard__phase", root), compare: $(".guard__compare", root), path: $(".spark__line", root), svg: $(".spark__svg", root), dots: $(".spark__dots", root), budget: $(".budget", root), hist: [], loss: 0 };
  }

  function resetSiege() {
    if (es) es.close(), (es = null);
    queue.length = 0;
    clearTimeout(drainTimer);
    drainTimer = null;
    siegeEl.dataset.state = "idle";
    stateEl.textContent = "Not started";
    for (const g of Object.values(guards)) {
      g.hist = [];
      g.loss = 0;
      g.compare.hidden = true;
      g.root.dataset.phase = "waiting";
      delete g.root.dataset.outcome;
      g.phase.textContent = "Waiting";
      g.num.textContent = near(0);
      g.path.setAttribute("d", "");
      g.dots.replaceChildren();
      g.budget.hidden = true;
    }
    lastBudget = null;
    $("#siege-verdict").hidden = true;
    $("#honest").hidden = true;
    $("#ledgers").hidden = true;
    $("#siege-error").hidden = true;
    siegeBtn.removeAttribute("aria-busy");
  }

  function drawSpark(g) {
    const h = g.hist;
    if (!h.length) return g.path.setAttribute("d", "");
    const n = Math.max(GENERATIONS, h.length);
    // Each line is scaled to its own peak, so a 1 NEAR loss is as visible as a 100 NEAR one; the figure above gives the size.
    const peak = Math.max(0, ...h.filter((v) => v != null));
    const y = (v) => (peak > 0 ? 38 - ((v ?? 0) / peak) * 36 : 38);
    let d = `M0 ${y(h[0]).toFixed(2)}`;
    h.forEach((v, i) => {
      const x0 = (i / n) * 100, x1 = ((i + 1) / n) * 100;
      d += ` L${x0.toFixed(2)} ${y(v).toFixed(2)} L${x1.toFixed(2)} ${y(v).toFixed(2)}`;
    });
    g.path.setAttribute("d", d);
    // A dot at each generation where the best attack got bigger, so a late jump reads as a find, not a glitch.
    const breaks = [];
    h.forEach((v, i) => v > 0 && v > (i ? h[i - 1] ?? 0 : 0) && breaks.push(i));
    const have = g.dots.childElementCount;
    if (have > breaks.length) g.dots.replaceChildren();
    breaks.forEach((i, k) => {
      const left = `${(((i + 0.5) / n) * 100).toFixed(2)}%`, top = `${((y(h[i]) / 40) * 100).toFixed(2)}%`;
      const dot = g.dots.children[k] ?? g.dots.appendChild(el("span", { class: "spark__dot" }));
      dot.style.left = left;
      dot.style.top = top;
      dot.title = `Generation ${i + 1}: ${near(h[i])} NEAR`;
    });
    const name = g.svg.getAttribute("aria-label").split(", ").slice(-1)[0];
    g.svg.setAttribute("aria-label", `Chart: best loss found by generation, ${name}. ${breaks.length ? `Bigger breaks found at generation ${list(breaks.map((i) => String(i + 1)))}.` : "No break found."}`);
  }

  function onProgress(p) {
    const g = guards[p.guard];
    if (!g) return;
    for (const [k, o] of Object.entries(guards)) if (k !== p.guard && o.root.dataset.phase === "running") finishGuard(k);
    g.root.dataset.phase = "running";
    g.hist[p.generation] = p.bestLoss;
    g.num.textContent = near(p.bestLoss);
    g.phase.textContent = `Generation ${p.generation + 1} of ${p.generations}`;
    stateEl.textContent = `Attacking ${SHORT[p.guard].toLowerCase()}, ${p.evaluations.toLocaleString("en")} attacks tried`;
    Object.values(guards).forEach(drawSpark);
    redline(p);
  }

  // ---------- live red-lining ----------
  // While the siege runs, the mandate is shown as clauses and each one is marked the moment the attacker first gets through it.
  function liveClauses() {
    clausesEl.replaceChildren();
    generalEl.replaceChildren();
    for (const s of compiled?.sentences ?? []) {
      clausesEl.append(el("li", { class: "clause clause--pending", "data-index": s.index }, el("span", { class: "clause__text", text: s.text }), el("div", { class: "note note--live" })));
    }
    return clausesEl.childElementCount > 0;
  }
  function redline(p) {
    for (const m of p.marks ?? []) {
      const li = clausesEl.querySelector(`[data-index="${m.index}"]`);
      if (!li) continue;
      const note = $(".note--live", li);
      let mark = note && $(`[data-guard="${p.guard}"]`, note);
      if (!note) continue;
      if (!mark) {
        mark = el("span", { class: "live-mark live-mark--fresh", "data-guard": p.guard }, `${SHORT[p.guard]} broken at generation ${p.generation + 1}, `, el("span", { class: "note__loss" }));
        note.append(mark);
        if (!li.classList.contains("clause--breach")) li.classList.replace("clause--pending", "clause--breach"), li.classList.add("clause--fresh");
      }
      $(".note__loss", mark).textContent = `lost ${near(m.loss)} NEAR`;
    }
  }
  function finishGuard(k, loss) {
    const g = guards[k];
    g.loss = loss ?? g.hist.at(-1) ?? 0;
    g.root.dataset.phase = "done";
    g.num.textContent = near(g.loss);
    Object.keys(guards).forEach(grade);
  }
  // Held: nothing lost. Held to budget: everything lost went through the mandate's new-payee budget and stayed inside it.
  // Mostly held: lost, but at least 90% less than the other guard. Drained: otherwise.
  function grade(k) {
    const g = guards[k];
    if (g.root.dataset.phase !== "done") return;
    if (k === "mandate" && g.loss > 0 && lastBudget?.withinBudget) {
      const b = lastBudget;
      g.root.dataset.outcome = "budget";
      g.phase.textContent = "Held to budget";
      g.compare.textContent = `All of it went to new payees, inside the ${near(b.cap)} NEAR ${hours(b.hours)} the mandate allows them.`;
      g.compare.hidden = false;
      $(".budget__fill", g.budget).style.setProperty("--used", String(Math.min(1, g.loss / b.cap)));
      $(".budget__text", g.budget).textContent = `${near(g.loss)} of ${near(b.cap)} NEAR budget used`;
      g.budget.hidden = false;
      return;
    }
    g.budget.hidden = true;
    const [ok, other] = Object.entries(guards).find(([x]) => x !== k);
    const theirs = other.root.dataset.phase === "done" ? other.loss : null;
    const v = g.loss;
    const cut = theirs > 0 ? 1 - v / theirs : 0;
    const tier = v <= 0 ? "held" : cut >= 0.9 ? "partial" : "breach";
    g.root.dataset.outcome = tier;
    g.phase.textContent = tier === "held" ? "Held" : tier === "partial" ? "Mostly held" : "Drained";
    g.compare.textContent = tier === "partial" ? `${Math.floor(cut * 100)}% less lost than ${SHORT[ok].toLowerCase()}` : "";
    g.compare.hidden = tier !== "partial";
  }

  function onAttack(a) {
    finishGuard(a.guard, a.loss);
    if (a.history?.length) (guards[a.guard].hist = a.history), Object.values(guards).forEach(drawSpark);
    const ol = $(`#l-${a.guard}`);
    ol.replaceChildren();
    const rows = a.steps.map((s) => {
      const dest = s.routedTo || s.to;
      const lost = s.verdict === "allow" && !legit.has(dest) && !(s.kind === "call" && !s.routedTo);
      const cls = s.verdict !== "allow" ? "stopped" : lost ? "lost" : "paid";
      const word = cls === "stopped" ? "Stopped" : cls === "lost" ? "Lost" : "Paid";
      const to = el("span", { class: "step__to" }, account(s.to));
      if (s.kind === "call") to.append(el("span", { class: "via", text: ` calls ${s.method}, routed to ` }), s.routedTo ? account(s.routedTo) : el("span", { class: "via", text: "itself" }));
      const ctx = el("p", { class: "step__ctx" }, `Asked: \u201c${s.user}\u201d`);
      if (s.doc) ctx.append(` Read: \u201c${s.doc.split("\n").join(" ").slice(0, 110)}${s.doc.length > 110 ? "…" : ""}\u201d`);
      if (cls === "stopped" && s.reasons?.length) ctx.append(el("br"), `Stopped for: ${s.reasons.map(human).join("; ").toLowerCase()}`);
      return el("li", { class: `step step--${cls}` }, to, el("span", { class: "step__amt", text: `${near(s.amount)} NEAR` }), el("span", { class: "step__v", text: word }), ctx);
    });
    const LIMIT = 5;
    rows.forEach((r, i) => (i >= LIMIT && (r.hidden = true), ol.append(r)));
    const old = ol.nextElementSibling;
    if (old?.classList.contains("ledger__more")) old.remove();
    if (rows.length > LIMIT) {
      const more = el("button", { type: "button", class: "btn btn--quiet btn--s ledger__more", "aria-expanded": "false", text: `Show all ${rows.length} steps` });
      more.addEventListener("click", () => {
        const open = more.getAttribute("aria-expanded") === "true";
        rows.forEach((r, i) => i >= LIMIT && (r.hidden = open));
        more.setAttribute("aria-expanded", String(!open));
        more.textContent = open ? `Show all ${rows.length} steps` : "Show fewer";
      });
      ol.after(more);
    }
    if (!rows.length) ol.append(el("li", { class: "step step--stopped" }, el("span", { class: "step__ctx", text: "The search kept no attack steps for this guard." })));
  }

  function noteFor(findings) {
    const note = el("div", { class: "note" });
    for (const g of ["outlayer", "mandate"]) {
      const fs = findings.filter((f) => f.guard === g).sort((a, b) => b.loss - a.loss);
      if (!fs.length) {
        if (findings.length) note.append(el("div", { class: "note__guard note__guard--held" }, el("span", { class: "note__who" }, `${SHORT[g]}: `, el("span", { class: "note__loss", text: "held" }))));
        continue;
      }
      const sum = fs.reduce((a, f) => a + f.loss, 0);
      const fixes = [...new Set(fs.map((f) => f.fix).filter(Boolean))];
      const inBudget = g === "mandate" && lastBudget?.withinBudget && fs.every((f) => f.kind === "theft");
      note.append(
        el(
          "div",
          { class: `note__guard note__guard--${inBudget ? "budget" : "breach"}` },
          el("span", { class: "note__who" }, `${SHORT[g]}: `, el("span", { class: "note__loss", text: inBudget ? `lost ${near(sum)} NEAR, inside its ${near(lastBudget.cap)} NEAR new-payee budget` : `lost ${near(sum)} NEAR` })),
          ...fixes.map((f) => el("span", { class: "note__fix" }, el("b", { text: "Fix: " }), f)),
          fs[0].how && el("details", { class: "note__story" }, el("summary", { text: "How it was attacked" }), el("p", { class: "note__how", text: fs[0].how })),
        ),
      );
    }
    return note;
  }

  function verdictLine(d) {
    const o = d.losses?.outlayer ?? 0, m = d.losses?.mandate ?? 0, b = d.budget;
    const first = o > 0 ? `Plain policy lost ${near(o)} NEAR.` : "Plain policy lost nothing.";
    const second =
      m <= 0 ? "Mandate guard lost 0.00 NEAR." : b?.withinBudget ? `Mandate guard lost ${near(m)}, capped by its ${near(b.cap)} NEAR new-payee budget.` : `Mandate guard lost ${near(m)} NEAR.`;
    const v = $("#siege-verdict");
    v.replaceChildren(el("span", { class: "siege__verdict-a", text: first }), " ", el("span", { class: "siege__verdict-b", text: second }));
    v.hidden = false;
  }

  function onDone(d) {
    lastBudget = d.budget ?? null;
    for (const [k, v] of Object.entries(d.losses || {})) finishGuard(k, v);
    verdictLine(d);
    clausesEl.replaceChildren();
    for (const s of d.sentences) {
      const breach = s.findings.length > 0;
      clausesEl.append(
        el(
          "li",
          { class: `clause clause--${breach ? "breach" : "held"}`, "data-index": s.index },
          el("span", { class: "clause__text", text: s.text }),
          breach ? noteFor(s.findings) : el("div", { class: "note" }, el("span", { class: "note--held", text: "Held against both guards." })),
        ),
      );
    }
    generalEl.replaceChildren();
    if (d.general?.length) {
      generalEl.append(el("h3", { text: "Not tied to one sentence" }), noteFor(d.general));
    }
    setMode("annotated");
    const honest = $("#honest");
    honest.replaceChildren(`No worse attack found in `, el("b", { text: d.evaluations.toLocaleString("en") }), ` evaluations. This is a bounded search, not a proof.`);
    honest.hidden = false;
    $("#ledgers").hidden = false;
    siegeEl.dataset.state = "done";
    stateEl.textContent = `Finished, ${d.evaluations.toLocaleString("en")} evaluations`;
    siegeBtn.removeAttribute("aria-busy");
    siegeBtn.firstChild.textContent = "Lay siege again ";
  }

  // The engine is fast; pace the stream so each generation is seen. Reduced motion shows it at once.
  const queue = [];
  let drainTimer = null;
  function push(type, data) {
    queue.push([type, data]);
    if (!drainTimer) drain();
  }
  function drain() {
    const item = queue.shift();
    if (!item) return void (drainTimer = null);
    const [type, data] = item;
    if (type === "progress") onProgress(data);
    else if (type === "attack") onAttack(data);
    else if (type === "done") onDone(data);
    drainTimer = setTimeout(drain, reduced || type !== "progress" ? 0 : 45);
  }

  function siegeError(msg) {
    if (es) es.close(), (es = null);
    siegeEl.dataset.state = "error";
    stateEl.textContent = "Stopped";
    $("#siege-error-msg").textContent = msg;
    $("#siege-error").hidden = false;
    siegeBtn.removeAttribute("aria-busy");
    for (const g of Object.values(guards)) if (g.root.dataset.phase === "running") (g.root.dataset.phase = "waiting"), (g.phase.textContent = "Interrupted");
  }

  async function laySiege() {
    if (siegeBtn.getAttribute("aria-busy") === "true") return;
    if (!compileOk) {
      ta.focus();
      return void (status.textContent ||= "Fix the mandate first.");
    }
    resetSiege();
    setMode(liveClauses() ? "annotated" : "edit");
    // On phones the siege sits below the mandate, out of sight: bring it up as it starts.
    if (matchMedia("(max-width: 40rem)").matches) siegeEl.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    siegeEl.dataset.state = "running";
    stateEl.textContent = "Starting the attacker…";
    siegeBtn.setAttribute("aria-busy", "true");
    const text = ta.value;
    let started = false, finished = false;
    es = new EventSource(`/api/siege?mandate=${encodeURIComponent(text)}&generations=${GENERATIONS}`);
    es.addEventListener("start", (e) => {
      started = true;
      const s = JSON.parse(e.data);
      legit = new Set(s.legit || []);
      guards.outlayer.root.dataset.phase = "running";
      guards.outlayer.phase.textContent = `Generation 0 of ${s.generations}`;
    });
    es.addEventListener("progress", (e) => push("progress", JSON.parse(e.data)));
    es.addEventListener("attack", (e) => push("attack", JSON.parse(e.data)));
    es.addEventListener("done", (e) => {
      finished = true;
      es.close();
      es = null;
      push("done", JSON.parse(e.data));
    });
    es.addEventListener("error", async () => {
      if (finished) return;
      if (es) es.close(), (es = null);
      if (started) return siegeError("The siege stopped before it finished. The connection to the server dropped.");
      try {
        const h = await (await fetch("/healthz", { cache: "no-store" })).json();
        siegeError(h.sieges > 0 ? "The attacker is busy with other sieges. Try again in a few seconds." : "The server refused this siege. Check the mandate compiles, then try again.");
      } catch {
        siegeError("Can't reach the SIEGE server. Check it is running, then try again.");
      }
    });
  }
  siegeBtn.addEventListener("click", laySiege);
  $("#retry-btn").addEventListener("click", laySiege);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      laySiege();
    }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) $("#siege-btn kbd").textContent = "\u2318 Enter";

  // ---------- try a transaction ----------
  const form = $("#try-form");
  const syncKind = () => $$(".call-only").forEach((n) => (n.hidden = !$("#k-call").checked));
  $$('input[name="kind"]').forEach((r) => r.addEventListener("change", syncKind));
  syncKind();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#try-msg");
    msg.textContent = "";
    const fd = Object.fromEntries(new FormData(form));
    $$(".input", form).forEach((i) => i.removeAttribute("aria-invalid"));
    const btn = $("#try-btn");
    btn.setAttribute("aria-busy", "true");
    try {
      const r = await fetch("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mandate: ta.value, tx: { ...fd, amount: Number(fd.amount) } }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.textContent = r.status === 422 ? `The mandate does not compile: ${j.error}.` : `${(j.error || "That did not go through").replace(/^./, (x) => x.toUpperCase())}.`;
        const bad = /amount/.test(j.error) ? "#t-amount" : /recipient/.test(j.error) ? "#t-to" : /arguments/.test(j.error) ? "#t-args" : null;
        if (bad) $(bad).setAttribute("aria-invalid", "true"), $(bad).focus();
        return;
      }
      renderVerdicts(j);
    } catch {
      msg.textContent = "Can't reach the SIEGE server. Check it is running, then try again.";
    } finally {
      btn.removeAttribute("aria-busy");
    }
  });
  function renderVerdicts(j) {
    const box = $("#verdicts");
    box.replaceChildren();
    for (const g of ["outlayer", "mandate"]) {
      const v = j[g];
      const allow = v.verdict === "allow";
      const why = v.reasons?.length ? v.reasons.map(human).join("; ") : allow ? "Nothing in its policy stops this." : "";
      box.append(
        el(
          "div",
          { class: `verdict verdict--${allow ? "allow" : "deny"}` },
          el("span", { class: "verdict__who", text: GUARD[g] }),
          el("span", { class: "verdict__says", text: allow ? "Would send it" : v.verdict === "deny" ? "Would refuse it" : `Would ${v.verdict} it` }),
          el("span", { class: "verdict__why", text: why }),
        ),
      );
    }
    const sig = el("div", { class: "signals" }, el("h4", { text: `What the classifier saw, risk ${Number(j.risk).toFixed(2)}` }));
    const ul = el("ul");
    if (!j.signals?.length) ul.append(el("li", {}, el("span", { class: "w", text: "0" }), el("span", { text: "No signals" }), el("span", { class: "d", text: "Nothing about this transaction looked off." })));
    for (const s of j.signals || []) ul.append(el("li", {}, el("span", { class: "w", text: Number(s.weight).toFixed(2) }), el("span", { text: human(s.code) }), el("span", { class: "d", text: s.detail })));
    sig.append(ul);
    box.append(sig);
    box.hidden = false;
  }

  // ---------- columns ----------
  // On wide screens both columns are sticky. A column taller than the window sticks by its bottom edge, so all of it can be read.
  const cols = [$(".doc"), siegeEl];
  const wide = matchMedia("(min-width: 70.0625rem)");
  const GAP = 24;
  function stick() {
    for (const c of cols) c.style.setProperty("--stick-top", wide.matches ? `${Math.min(GAP, innerHeight - c.offsetHeight - GAP)}px` : "");
  }
  new ResizeObserver(stick).observe(cols[0]);
  new ResizeObserver(stick).observe(cols[1]);
  addEventListener("resize", () => (stick(), fit()));

  // ---------- start ----------
  fit();
  compile().then(() => {
    if (new URLSearchParams(location.search).get("autosiege") === "1" && compileOk) laySiege();
  });
})();
