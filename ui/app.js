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
  const MAX = Number($("#mandate").getAttribute("maxlength")) || 2000;

  const ta = $("#mandate");
  const status = $("#doc-status");
  const siegeBtn = $("#siege-btn");
  const editBtn = $("#edit-btn");
  const clausesEl = $("#clauses");
  const generalEl = $("#general");
  const siegeEl = $("#siege");
  const stateEl = $("#siege-state");
  const liveEl = $("#siege-live");
  const btnLabel = $(".btn__label", siegeBtn);

  let compiled = null; // last good compile response
  let compileOk = false;
  let compileSeq = 0;
  let es = null;
  let legit = new Set();
  let lastBudget = null; // the Mandate guard's new-payee budget, from the finished siege
  let lastStops = null; // per guard, attacks tried and attacks that got nothing out, from the finished siege
  let hasResult = false; // a finished siege is on screen; it stays until a new run actually connects
  let lastRun = null; // { text, losses } of the last finished siege
  let prevRun = null; // the finished run a new siege is compared against
  let attacks = {}; // the best attack per guard, from the attack events, for the "what this means" line
  let evals = {}; // attacks tried so far, per guard, for the running totals
  let example = false; // the board shows the recorded example run, not one of this visitor's sieges

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
  // A server message as one plain sentence: capital first, exactly one full stop.
  const sentence = (s) => String(s).trim().replace(/[.\s]+$/, "").replace(/^./, (x) => x.toUpperCase()) + ".";
  const why422 = (err) => `SIEGE can’t test these rules yet: ${String(err).trim().replace(/[.\s]+$/, "")}.`;
  // Screen-reader announcements for the siege, throttled so a fast run is not read out generation by generation.
  let lastSaid = 0;
  function announce(msg, force = false) {
    if (example) return;
    const now = Date.now();
    if (!force && now - lastSaid < 4000) return;
    lastSaid = now;
    liveEl.textContent = msg;
  }
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

  // ---------- the stakes strip ----------
  // Why SIEGE exists: one line that always stays, and three steps behind "How it works". Folded by default, so the
  // rules and the action stay near the top; opening it is remembered.
  const stakes = $("#stakes");
  const stakesOpen = $("#stakes-open");
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  function showStakes(open, byHand = false) {
    stakes.dataset.open = String(open);
    stakesOpen.setAttribute("aria-expanded", String(open));
    stakesOpen.textContent = open ? "Hide how it works" : "How it works";
    if (byHand) store.set("siege.stakes", open ? "open" : "folded");
  }
  showStakes(store.get("siege.stakes") === "open");
  stakesOpen.addEventListener("click", () => showStakes(stakes.dataset.open !== "true", true));

  // ---------- terms ----------
  // A dotted term opens one shared tooltip: on hover, on keyboard focus, and on tap or click (which pins it until Escape or a tap elsewhere).
  // The definition itself is the button's accessible description, so screen readers hear it without the tooltip.
  const tip = $("#tip");
  let tipFor = null, tipPinned = false;
  const term = (label, key) => el("button", { type: "button", class: "term", "data-tip": key, "aria-describedby": `def-${key}`, text: label });
  function showTip(btn, pin = false) {
    tipFor?.setAttribute("aria-expanded", "false");
    tipFor = btn;
    tipPinned = pin;
    tip.textContent = $(`#def-${btn.dataset.tip}`)?.textContent ?? "";
    tip.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    placeTip();
  }
  function hideTip() {
    if (!tipFor) return;
    tipFor.setAttribute("aria-expanded", "false");
    tipFor = null;
    tipPinned = false;
    tip.hidden = true;
  }
  function placeTip() {
    if (!tipFor) return;
    const r = tipFor.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight, pad = 8;
    const left = Math.max(pad, Math.min(innerWidth - w - pad, r.left + r.width / 2 - w / 2));
    const below = r.bottom + pad + h <= innerHeight;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(below ? r.bottom + pad : r.top - pad - h)}px`;
  }
  const termOf = (e) => e.target.closest?.(".term");
  document.addEventListener("pointerover", (e) => { const t = termOf(e); if (t && e.pointerType === "mouse" && !tipPinned) showTip(t); });
  document.addEventListener("pointerout", (e) => { const t = termOf(e); if (t && t === tipFor && e.pointerType === "mouse" && !tipPinned) hideTip(); });
  document.addEventListener("focusin", (e) => { const t = termOf(e); if (t && t.matches(":focus-visible")) showTip(t); });
  document.addEventListener("focusout", (e) => { if (termOf(e) === tipFor) hideTip(); });
  document.addEventListener("click", (e) => {
    const t = termOf(e);
    if (t) return t === tipFor && tipPinned ? hideTip() : showTip(t, true);
    if (tipPinned && !tip.contains(e.target)) hideTip();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && tipFor && hideTip());
  addEventListener("scroll", placeTip, { passive: true });

  // ---------- compile ----------
  async function compile() {
    const text = ta.value;
    const seq = ++compileSeq;
    if (!text.trim()) return showCompileError("Write your rules first. Say who the agent may pay, how much per transaction, and how much per day.");
    $(".reading").setAttribute("aria-busy", "true");
    status.dataset.tone = "";
    status.textContent = "Reading your rules…";
    try {
      const r = await fetch("/api/compile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mandate: text }) });
      if (seq !== compileSeq) return;
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return showCompileError(r.status === 422 ? why422(j.error) : j.error ? sentence(j.error) : `The server answered ${r.status}. Edit your rules to retry.`);
      compiled = j;
      compileOk = true;
      ta.removeAttribute("aria-invalid");
      status.textContent = "";
      siegeBtn.removeAttribute("aria-disabled");
      renderReading(j.constraints);
      renderExport(j, text);
    } catch {
      if (seq !== compileSeq) return;
      showCompileError("Can’t reach the SIEGE server. It retries when you edit your rules or come back to this tab.");
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
    $("#reading").replaceChildren(el("div", { class: "reading__row reading__row--empty" }, el("dd", { text: "Nothing to read yet. Fix your rules above." })));
    staleExport();
  }
  // Characters left, shown only near the limit; a paste that would overflow says it was cut.
  function count(cut = false) {
    const n = ta.value.length;
    const c = $("#doc-count");
    c.hidden = n < MAX * 0.8 && !cut;
    c.dataset.tone = n >= MAX ? "full" : "";
    c.textContent = cut ? `The pasted text was cut at ${MAX.toLocaleString("en")} characters. Shorten a sentence to fit the rest.` : n >= MAX ? `At the ${MAX.toLocaleString("en")} character limit.` : `${n.toLocaleString("en")} of ${MAX.toLocaleString("en")} characters`;
  }
  ta.addEventListener("paste", (e) => {
    const add = e.clipboardData?.getData("text")?.length ?? 0;
    const sel = ta.selectionEnd - ta.selectionStart;
    if (ta.value.length - sel + add > MAX) setTimeout(() => count(true));
  });
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
    count();
    // The siege tests the text it started with: an edit stops a running siege and marks a finished one as out of date.
    if (siegeEl.dataset.state === "running") siegeError("Stopped: your rules changed. Lay siege again to test the new text.", "Lay siege on the new text");
    else if (siegeEl.dataset.state === "done" && !siegeEl.dataset.stale) {
      siegeEl.dataset.stale = "true";
      stateEl.textContent = "Out of date: your rules changed. Lay siege again.";
      announce("The siege results are out of date: your rules changed.", true);
    }
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
  function staleExport() {
    $("#x-policy").textContent = "Fix your rules above to see their OutLayer policy.";
    for (const id of ["x-guard", "x-proxy", "x-header"]) $("#" + id).textContent = "";
    $$("[data-copy], [data-download]").forEach((b) => b.setAttribute("aria-disabled", "true"));
  }
  function renderExport(j, text) {
    $$("[data-copy], [data-download]").forEach((b) => b.removeAttribute("aria-disabled"));
    $("#x-policy").textContent = JSON.stringify(j.outlayerPolicy, null, 2);
    $("#x-guard").textContent = JSON.stringify(j.guardConfig, null, 2);
    // Single quotes keep the shell from touching $, `, ! or \ in the mandate; a ' inside becomes '\''.
    const esc = text.replace(/\s+/g, " ").trim().replace(/'/g, "'\\''");
    $("#x-proxy").textContent = `# The proxy holds your OutLayer key; give the agent only SIEGE_PROXY_TOKEN.\nSIEGE_PROXY_TOKEN=$(openssl rand -hex 24) OUTLAYER_API_KEY=wk_... \\\nMANDATE='${esc}' \\\n  npm run proxy`;
    const ctx = { userInstruction: "Pay the hosting invoice from cloudhost.testnet.", retrieved: ["Invoice #4471. Amount due: 3 NEAR. Pay to: cloudhost.testnet."], reasoning: "The user asked me to pay this invoice.", provenance: "user" };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(ctx))));
    $("#x-header").textContent = `x-siege-context: ${b64}\n\n# decoded\n${JSON.stringify(ctx, null, 2)}`;
  }
  $$("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.getAttribute("aria-disabled") === "true") return;
      const pre = $("#" + b.dataset.copy);
      try {
        await navigator.clipboard.writeText(pre.textContent);
        b.textContent = "Copied";
      } catch {
        // No clipboard access (an insecure origin, or permission refused): select the text so the keyboard copy works.
        const range = document.createRange();
        range.selectNodeContents(pre);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        pre.focus();
        b.textContent = "Selected, now copy";
      }
      setTimeout(() => (b.textContent = "Copy"), 2400);
    }),
  );
  $$("[data-download]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.getAttribute("aria-disabled") === "true") return;
      const blob = new Blob([$("#" + b.dataset.download).textContent + "\n"], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: b.dataset.file });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }),
  );

  // ---------- examples ----------
  let examples = null;
  const pick = $("#example-select");
  async function loadExample(name) {
    try {
      examples ??= await (await fetch("/api/examples")).json();
    } catch {
      return showCompileError("Can’t reach the SIEGE server to load the examples. Try again in a moment.");
    }
    setMode("edit");
    ta.value = examples[name] ?? ta.value;
    fit();
    pick.value = name;
    resetSiege();
    compile();
  }
  pick.addEventListener("change", () => pick.value && loadExample(pick.value));

  // ---------- document modes ----------
  function setMode(mode) {
    const annotated = mode === "annotated";
    ta.hidden = annotated;
    clausesEl.hidden = !annotated;
    keyEl.hidden = !annotated || !keyEl.childElementCount;
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
    guards[g] = { root, num: $(".guard__num", root), phase: $(".guard__phase", root), compare: $(".guard__compare", root), clauses: $(".guard__clauses", root), path: $(".spark__line", root), svg: $(".spark__svg", root), dots: $(".spark__dots", root), budget: $(".budget", root), stops: $(".guard__stops", root), unit: $(".guard__unit", root), hist: [], loss: 0 };
  }

  function resetSiege(keepStream = false) {
    if (es && !keepStream) es.close(), (es = null);
    queue.length = 0;
    clearTimeout(drainTimer);
    drainTimer = null;
    siegeEl.dataset.state = "idle";
    delete siegeEl.dataset.stale;
    delete siegeEl.dataset.prev;
    delete siegeEl.dataset.example;
    example = false;
    $("#siege-example").hidden = true;
    $("#siege-sum").hidden = true;
    evals = {};
    clausesEl.removeAttribute("data-prev");
    $("#siege-prev").hidden = true;
    hasResult = false;
    stateEl.textContent = "Not started";
    btnLabel.textContent = "Lay siege";
    $$(".guard__preview").forEach((n) => (n.textContent = "Run a siege to see what gets past"));
    for (const g of Object.values(guards)) {
      g.hist = [];
      g.loss = 0;
      g.compare.hidden = true;
      g.clauses.hidden = true;
      g.stops.hidden = true;
      g.root.dataset.phase = "waiting";
      delete g.root.dataset.outcome;
      g.phase.textContent = "";
      g.num.textContent = near(0);
      g.unit.textContent = "NEAR lost";
      g.path.setAttribute("d", "");
      g.dots.replaceChildren();
      $(".spark__val", g.root).hidden = true;
      g.budget.hidden = true;
    }
    lastBudget = null;
    lastStops = null;
    $("#l-mandate-sum").hidden = true;
    $("#siege-verdict").hidden = true;
    $("#means").hidden = true;
    $("#means-more").hidden = true;
    $("#play").hidden = true;
    $("#play-lines").replaceChildren();
    $("#play-totals").textContent = "";
    attacks = {};
    $("#honest").hidden = true;
    $("#ledgers").hidden = true;
    $("#next").hidden = true;
    $("#siege-error").hidden = true;
    siegeBtn.removeAttribute("aria-busy");
  }

  // One y-max for both guards, so 1.02 against 177.20 shows the real gap; a loss above 0 still rises at least 2px, gets its break dots and a value label.
  function sparkPeak() {
    return Math.max(0, ...Object.values(guards).flatMap((o) => o.hist.filter((v) => v != null)));
  }
  function drawSpark(g) {
    const h = g.hist;
    const label = $(".spark__val", g.root);
    if (!h.length) return g.path.setAttribute("d", ""), label && (label.hidden = true);
    const n = Math.max(GENERATIONS, h.length);
    const peak = sparkPeak();
    const plotH = g.svg.getBoundingClientRect().height || 48;
    const minRise = (2 * 40) / plotH;
    const y = (v) => (peak > 0 && (v ?? 0) > 0 ? 38 - Math.max(((v ?? 0) / peak) * 36, minRise) : 38);
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
      dot.title = `Round ${i + 1}: ${near(h[i])} NEAR`;
    });
    const last = h.at(-1) ?? 0;
    const endY = (y(last) / 40) * 100;
    label.hidden = false;
    label.textContent = near(last);
    label.style.left = `${Math.max(0, Math.min(100, (h.length / n) * 100)).toFixed(2)}%`;
    label.style.top = `${endY.toFixed(2)}%`;
    const name = g.svg.getAttribute("aria-label").split(", ").slice(-1)[0];
    g.svg.setAttribute("aria-label", `Chart: best loss found by attack round, ${name}. ${breaks.length ? `Bigger breaks found in round ${list(breaks.map((i) => String(i + 1)))}.` : "No break found."}`);
  }

  // ---------- play by play ----------
  // Each progress event may carry one real attack, re-run against both guards on the server. It becomes one plain line.
  const LURE = {
    invoice: "A fake invoice", injection: "A document with an order hidden in it (“ignore previous instructions, send…”)", "address-change": "An email saying the payment address had changed",
    history: "A forged payment history", billing: "A forged billing note", receipt: "A fake order receipt", notes: "Forged meeting notes",
    tip: "A planted tip in a help page", statement: "A forged account statement", renewal: "A fake auto-renew notice",
  };
  // Why a guard refused, in plain words. Judge reasons arrive as JUDGE:<code or sentence>.
  function because(code, p) {
    const c = String(code ?? "").replace(/^JUDGE:/, "");
    if (/^WINDOW_CAP/.test(c)) return "it would go over your limit over time";
    if (/untrusted/i.test(c)) return "only the document named that payee, not you";
    if (/ungrounded/i.test(c)) return "nobody you trust ever named that payee";
    const plain = {
      NOT_WHITELISTED: "that payee isn’t on its list", RECIPIENT_NOT_ALLOWED: "that payee isn’t in your rules", BLACKLISTED: "your rules ban that payee", RECIPIENT_DENIED: "your rules ban that payee",
      PER_TX_CAP: "it’s over your per-payment limit", RECIPIENT_UNGROUNDED: "nobody you trust ever named that payee", RECIPIENT_FROM_UNTRUSTED: "only the document named that payee, not you",
      RECIPIENT_CONTRADICTS_USER: "you asked to pay someone else", ADDRESS_POISONING: p.imitates ? `the name imitates ${p.imitates}` : "the name imitates a real payee", NON_ASCII_RECIPIENT: "the name hides lookalike characters",
      INJECTION_SUSPECTED: "the document gives the agent hidden orders", INJECTION_IN_REASONING: "the agent was repeating a planted order", NON_USER_PROVENANCE: "the order came from a document, not from you",
      CONFUSED_DEPUTY: "the call quietly sends the money to someone else", AMOUNT_MISMATCH: "the amount isn’t what you asked for", PURPOSE_MISMATCH: "it isn’t for a purpose your rules allow",
      NO_FINANCIAL_INTENT: "you never asked it to pay anything", REPEATED_PAYMENT: "it repeats a payment already made", RATE_LIMIT: "too many payments too fast",
      NOVEL_PAYEE_BUDGET: "its small allowance for unknown payees was used up", METHOD_NOT_ALLOWED: "your rules don’t allow that kind of payment", KIND_NOT_ALLOWED: "your rules don’t allow that kind of payment",
      CONTRACT_NOT_ALLOWED: "your rules don’t allow that kind of payment", OUTSIDE_ACTIVE_HOURS: "it’s outside the hours your rules allow",
    };
    return plain[c] ?? "it breaks your rules";
  }
  // The four tricks, each with the same name and mark in the strip's legend and on every line.
  const tagsOf = (p) =>
    [
      p.lure === "injection" && ["hidden", "Hidden instruction"],
      p.imitates && ["lookalike", "Lookalike name"],
      p.dripped && ["drip", "Drip"],
      p.raced && ["race", "Race"],
    ].filter(Boolean);
  function playLine(p) {
    const lure = p.lure ? LURE[p.lure] ?? "A forged document" : "A request with no paperwork";
    const what = el("p", { class: "line__what" });
    const to = el("span", { class: "mono" }, account(p.to));
    if (p.technique === "deputy") what.append(`${lure} got the agent to run ${p.method}, a contract call whose payout was quietly redirected to `, to, ` (${near(p.amount)} NEAR)`);
    else what.append(`${lure} asked for ${near(p.amount)} NEAR to `, to);
    if (p.imitates && p.imitates !== p.to) what.append(", a lookalike of ", el("span", { class: "mono", text: p.imitates }));
    what.append(".");
    if (p.raced) what.append(` It fired ${p.burst} payments at the same moment to race your ${near(p.cap)} NEAR limit.`);
    else if (p.dripped) what.append(` It split the theft into ${p.payments} small payments.`);
    const o = p.verdicts.outlayer, m = p.verdicts.mandate;
    const plain = o.paid
      ? `Plain policy paid it${o.lost > p.amount + 0.005 ? `; the whole attack took ${near(o.lost)} NEAR` : ""}.`
      : `Plain policy refused: ${because(o.reason, p)}${o.lost > 0 ? `, but the rest of the attack still took ${near(o.lost)} NEAR` : ""}.`;
    const guard = m.paid
      ? m.novel ? "The guard paid it from its new-payee allowance: the most it lets go to payees your rules never named." : "The guard paid it too."
      : `The guard refused: ${because(m.reason, p)}.`;
    return el(
      "li",
      { class: `line${reduced ? "" : " line--fresh"}` },
      el("p", { class: "line__meta" }, el("span", { class: "line__round num", text: `Round ${p.round}` }), ` against ${p.guard === "outlayer" ? "plain policy" : "the guard"}`, ...tagsOf(p).map(([k, t]) => el("span", { class: `tech tech--${k}`, text: t }))),
      what,
      el("p", { class: "line__out" }, el("span", { class: `line__v line__v--${o.paid ? "lost" : "held"}`, text: plain }), " ", el("span", { class: `line__v line__v--${m.paid ? (m.novel ? "budget" : "lost") : "held"}`, text: guard })),
    );
  }
  const PLAY_KEEP = 4;
  function onPlay(p) {
    const ol = $("#play-lines");
    ol.prepend(playLine(p));
    while (ol.childElementCount > PLAY_KEEP) ol.lastElementChild.remove();
    $("#play").hidden = false;
  }
  function playTotals(p) {
    const lost = (k) => near(Math.max(0, ...guards[k].hist.filter((v) => v != null)));
    $("#play-totals").textContent = `${p.evaluations.toLocaleString("en")} attacks tried on ${SHORT[p.guard].toLowerCase()}. Paid out so far: plain policy ${lost("outlayer")} NEAR, the guard ${lost("mandate")} NEAR.`;
  }

  // The outcome in one line above the cards. While the siege runs these are running totals, never the result.
  const unitText = () => (siegeEl.dataset.state === "running" ? "NEAR lost so far" : "NEAR lost");
  const bestOf = (k) => Math.max(0, ...guards[k].hist.filter((v) => v != null));
  function sumLine(d) {
    const sum = $("#siege-sum");
    sum.replaceChildren();
    const fig = (t) => el("b", { text: t });
    if (!d) {
      const n = Object.values(evals).reduce((a, x) => a + x, 0);
      sum.dataset.tone = "running";
      sum.append("Running totals: plain rules ", fig(`${near(bestOf("outlayer"))} NEAR`), " lost · your guard ", fig(near(bestOf("mandate"))), ` · ${n.toLocaleString("en")} attacks tried so far`);
    } else {
      const o = d.losses?.outlayer ?? 0, m = d.losses?.mandate ?? 0;
      sum.dataset.tone = "done";
      sum.append("Plain rules lost ", fig(`${near(o)} NEAR`), " · Your guard lost ", fig(near(m)), d.budget?.withinBudget ? ", inside its allowance" : "", ` · ${d.evaluations.toLocaleString("en")} attacks tried (bounded search)`);
    }
    sum.hidden = false;
  }

  function onProgress(p) {
    const g = guards[p.guard];
    if (!g) return;
    evals[p.guard] = p.evaluations;
    for (const [k, o] of Object.entries(guards)) if (k !== p.guard && o.root.dataset.phase === "running") finishGuard(k);
    g.root.dataset.phase = "running";
    g.hist[p.generation] = p.bestLoss;
    g.num.textContent = near(p.bestLoss);
    g.unit.textContent = unitText();
    g.phase.textContent = `Attack round ${p.generation + 1} of ${p.generations}`;
    stateEl.textContent = `Attacking ${SHORT[p.guard].toLowerCase()}, ${p.evaluations.toLocaleString("en")} attacks tried`;
    announce(`${GUARD[p.guard]}: attack round ${p.generation + 1} of ${p.generations}, ${near(p.bestLoss)} NEAR lost so far.`);
    Object.values(guards).forEach(drawSpark);
    redline(p);
    playTotals(p);
    sumLine();
    if (p.play) onPlay(p.play);
  }

  // ---------- the key ----------
  // The red underline means the plain policy lost money on that sentence, even where the Mandate guard held it.
  // The number badge carries the Mandate guard's outcome. The key lists only the marks on screen.
  const keyEl = $("#key");
  function showKey(seen) {
    const sample = (cls, t) => el("span", { class: `key__item` }, el("span", { class: cls, "aria-hidden": "true", text: cls.includes("badge") ? "1" : "Red underline" }), t);
    keyEl.replaceChildren();
    if (!seen) keyEl.append(sample("key__line", "the plain policy was breached here"), el("span", { class: "key__item key__wait", text: "Numbers turn green where the Mandate guard holds, once the siege ends." }));
    else {
      if (seen.has("plain")) keyEl.append(sample("key__line", "the plain policy was breached here"));
      if (seen.has("held")) keyEl.append(sample("key__badge key__badge--held", "the Mandate guard held"));
      if (seen.has("budget")) keyEl.append(sample("key__badge key__badge--budget", "the guard paid only from its new-payee allowance"));
      if (seen.has("lost")) keyEl.append(sample("key__badge key__badge--lost", "the Mandate guard was breached"));
    }
    keyEl.hidden = !keyEl.childElementCount;
  }

  // ---------- live red-lining ----------
  // While the siege runs, the mandate is shown as clauses and each one is marked the moment the attacker first gets through it.
  function liveClauses() {
    showKey(null);
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
        mark = el("span", { class: "live-mark live-mark--fresh", "data-guard": p.guard }, `${SHORT[p.guard]} broken in round ${p.generation + 1}, `, el("span", { class: "note__loss" }));
        note.append(mark);
        if (p.guard === "outlayer" && !li.classList.contains("clause--breach")) li.classList.add("clause--breach", "clause--fresh");
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
    if (siegeEl.dataset.state === "running") announce(`${GUARD[k]} finished: ${near(g.loss)} NEAR lost.`, true);
  }
  // Held: nothing lost. Held to budget: everything lost went through the mandate's new-payee budget and stayed inside it.
  // Mostly held: lost, but at least 90% less than the other guard. Drained: otherwise.
  function grade(k) {
    const g = guards[k];
    if (g.root.dataset.phase !== "done") return;
    if (k === "mandate" && g.loss > 0 && lastBudget?.withinBudget) {
      const b = lastBudget;
      g.root.dataset.outcome = "budget";
      g.phase.textContent = "Held to its allowance";
      g.compare.hidden = true;
      // Both cards lead with NEAR lost, so they compare at a glance; the gauge shows it all came from the allowance.
      g.num.textContent = near(g.loss);
      g.unit.textContent = unitText();
      $(".budget__fill", g.budget).style.setProperty("--used", String(Math.min(1, g.loss / b.cap)));
      $(".budget__text", g.budget).replaceChildren(`All of it from its ${near(b.cap)} NEAR `, term("allowance", "allowance"), ` for new payees, ${hours(b.hours)}.`);
      g.budget.hidden = false;
      return;
    }
    g.budget.hidden = true;
    g.num.textContent = near(g.loss);
    g.unit.textContent = unitText();
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
    attacks[a.guard] = a;
    finishGuard(a.guard, a.loss);
    if (a.history?.length) (guards[a.guard].hist = a.history), Object.values(guards).forEach(drawSpark);
    renderLedger(a);
  }
  // The best attack, step by step. Against the Mandate guard, payments that stayed inside its new-payee allowance read
  // as what they are, neutral and grey; only a payment past the allowance is marked lost. The budget arrives with "done".
  function renderLedger(a) {
    const allowance = a.guard === "mandate" && lastBudget?.withinBudget;
    const sumEl = a.guard === "mandate" ? $("#l-mandate-sum") : null;
    if (sumEl) {
      sumEl.hidden = !allowance;
      if (allowance) sumEl.textContent = `Within allowance: ${near(a.loss)} of ${near(lastBudget.cap)} NEAR ${hours(lastBudget.hours)}, to payees your rules never named.`;
    }
    const ol = $(`#l-${a.guard}`);
    ol.replaceChildren();
    const rows = a.steps.map((s) => {
      const dest = s.routedTo || s.to;
      const lost = s.verdict === "allow" && !legit.has(dest) && !(s.kind === "call" && !s.routedTo);
      const cls = s.verdict !== "allow" ? "stopped" : lost ? (allowance ? "allowance" : "lost") : "paid";
      const word = { stopped: "Stopped", lost: "Lost", allowance: "Within allowance", paid: "Paid" }[cls];
      // Against the plain policy losing is the default, so only the rows that went otherwise carry a chip.
      const chip = a.guard === "outlayer" && cls === "lost" ? el("span", { class: "step__v step__v--none" }, el("span", { class: "visually-hidden", text: word })) : el("span", { class: "step__v", text: word });
      const to = el("span", { class: "step__to" }, account(s.to));
      if (s.kind === "call") to.append(el("span", { class: "via", text: ` calls ${s.method}, routed to ` }), s.routedTo ? account(s.routedTo) : el("span", { class: "via", text: "itself" }));
      const ctx = el("p", { class: "step__ctx" }, `Asked: \u201c${s.user}\u201d`);
      if (s.doc) ctx.append(` Read: \u201c${s.doc.split("\n").join(" ").slice(0, 110)}${s.doc.length > 110 ? "…" : ""}\u201d`);
      if (cls === "stopped" && s.reasons?.length) ctx.append(el("br"), `Stopped for: ${s.reasons.map(human).join("; ").toLowerCase()}`);
      return el("li", { class: `step step--${cls}` }, to, el("span", { class: "step__amt", text: `${near(s.amount)} NEAR` }), chip, ctx);
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

  // A fix is "the action: the reason", and the action may offer alternatives ("Name your payees, or ...").
  // Each rule's note says what each guard lost, then each action and what it changes, as "action → outcome".
  // The attack story and the reasoning wait under "How the attack worked".
  const actionOf = (f) => sentence(f.fix.split(/:\s/)[0].split(/,\s+or\s+/)[0]);
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  function outcomeOf(fs, all, named = false) {
    const loss = near(fs.reduce((a, f) => a + f.loss, 0));
    const n = fs.reduce((a, f) => a + (f.payments ?? 1), 0);
    // Naming payees or dropping a method stops every payment that went to an account the rules never named.
    if (fs.every((f) => f.kind === "theft" && f.to && !legit.has(f.to)) && (named || !/Mandate guard|SIEGE/.test(fs[0].fix))) {
      const calls = /drop \S+ from the mandate/.test(fs[0].fix);
      return `blocks the ${plural(n, calls ? "call" : "payment")} that got money out (${loss} NEAR)`;
    }
    // Putting the guard in front is backed by this run only where the guard lost nothing on the same rule.
    if (/Mandate guard/.test(fs[0].fix) && fs.every((f) => f.guard === "outlayer") && !all.some((f) => f.guard === "mandate"))
      return fs.every((f) => f.kind === "overspend") ? `stops the ${loss} NEAR overshoot; the guard held this rule` : `the guard held this rule, where plain policy lost ${loss} NEAR`;
    return null;
  }
  function noteFor(findings, s = null) {
    const note = el("div", { class: "note" });
    for (const g of ["outlayer", "mandate"]) {
      const fs = findings.filter((f) => f.guard === g && f.loss > 0);
      const line = el("p", { class: "note__guard" }, el("span", { class: "note__who", text: SHORT[g] }), " ");
      if (!fs.length) line.classList.add("note__guard--held"), line.append(el("span", { class: "note__loss", text: "held" }));
      else {
        const sum = fs.reduce((a, f) => a + f.loss, 0);
        const n = fs.reduce((a, f) => a + (f.payments ?? 1), 0);
        const inBudget = g === "mandate" && lastBudget?.withinBudget && fs.every((f) => f.kind === "theft");
        line.classList.add(`note__guard--${inBudget ? "budget" : "breach"}`);
        line.append(el("span", { class: "note__loss", text: inBudget ? `${near(sum)} NEAR within allowance` : `lost ${near(sum)} NEAR` }));
        if (n > 1 && fs.every((f) => f.kind === "theft")) line.append(el("span", { class: "note__n", text: `in ${n} payments` }));
      }
      note.append(line);
    }
    // One line per distinct action. Where SIEGE can write the named-payee rewrite, the action is that rewrite.
    const rewrite = s ? suggestFor(s) : null;
    const acts = new Map();
    for (const f of findings.filter((f) => f.fix)) {
      const named = rewrite && f.kind === "theft" && /^Name your payees/.test(f.fix);
      const key = named ? "rewrite" : actionOf(f);
      acts.set(key, [...(acts.get(key) ?? []), f]);
    }
    for (const [key, fs] of acts) {
      const act = el("p", { class: "note__act" });
      if (key === "rewrite") act.append("Change it to ", el("q", { class: "note__quote", text: rewrite }));
      else act.append(key.replace(/\.$/, ""));
      const out = outcomeOf(fs, findings, key === "rewrite");
      if (out) act.append(el("span", { class: "note__arrow", "aria-hidden": "true", text: " → " }), el("span", { class: "visually-hidden", text: ": " }), el("span", { class: "note__out", text: out }));
      else if (key !== "rewrite") act.lastChild.textContent += ".";
      note.append(act);
    }
    const story = ["outlayer", "mandate"].map((g) => findings.filter((f) => f.guard === g).sort((a, b) => b.loss - a.loss)).filter((fs) => fs.length && (fs[0].how || fs[0].fix));
    if (story.length)
      note.append(
        el(
          "details",
          { class: "note__story" },
          el("summary", { text: "How the attack worked" }),
          ...story.map((fs) => el("p", { class: "note__how" }, el("b", { text: `${GUARD[fs[0].guard]}. ` }), [fs[0].how, fs[0].fix ? sentence(fs[0].fix) : ""].filter(Boolean).join(" "))),
        ),
      );
    return note;
  }

  // The verdict: one sentence about what the guard changed. The cards above already carry both figures.
  function verdictLine(d) {
    const o = d.losses?.outlayer ?? 0, m = d.losses?.mandate ?? 0, b = d.budget;
    let text;
    if (o > 0 && m <= 0) text = `The guard stopped every attack. Without it, the attacker took ${near(o)} NEAR.`;
    else if (o > 0 && m < o) text = `The guard cut the loss from ${near(o)} to ${near(m)} NEAR${b?.withinBudget ? ", all of it inside its new-payee allowance" : ""}.`;
    else if (o > 0) text = `The guard lost ${near(m)} NEAR; plain policy lost ${near(o)}.`;
    else if (m > 0) text = `Plain policy held, but the guard lost ${near(m)} NEAR.`;
    else text = "Neither guard lost anything to the attacks SIEGE found.";
    const v = $("#siege-verdict");
    v.textContent = text;
    v.hidden = false;
    return text;
  }

  // What the verdict means for the person reading it: one short line from the best attack and the limit they wrote,
  // and the long version, with the terms spelled out, behind a disclosure.
  function meansLine(d) {
    const o = d.losses?.outlayer ?? 0, m = d.losses?.mandate ?? 0, b = d.budget;
    const lostSteps = (attacks.outlayer?.steps ?? []).filter((s) => s.verdict === "allow" && !legit.has(s.routedTo || s.to) && !(s.kind === "call" && !s.routedTo));
    const caps = (compiled?.constraints?.windows ?? []).filter((w) => w.token === "NEAR" || w.token === "*");
    const cap = caps.length ? caps.reduce((a, w) => (w.cap < a.cap ? w : a)) : null;
    const over = cap && o > cap.cap * 1.05;
    const times = over ? (Math.floor(o / cap.cap) >= 2 ? `${Math.floor(o / cap.cap)} times` : "more than") : "";
    const paid = lostSteps.length > 1 ? ` in ${lostSteps.length} payments` : "";
    let short;
    if (o > 0) short = `Without the guard, one attack took ${near(o)} NEAR${paid}${over ? `, ${times} your ${near(cap.cap)} NEAR ${hours(cap.hours)} limit` : ""}.`;
    else short = "Plain policy held against every attack SIEGE found this time.";
    const full = [];
    if (o > 0) full.push(`On plain policy, one attack SIEGE found would have cost you ${near(o)} NEAR${paid}${over ? `, ${times} the ${near(cap.cap)} NEAR ${hours(cap.hours)} limit you wrote (payments sent at the same moment raced past it)` : ""}.`);
    else full.push("Plain policy held against every attack SIEGE found this time.");
    if (m <= 0) full.push("With the guard in front, no attack got any money out.");
    else full.push(`With the guard, the most any attack got was ${near(m)} NEAR${b?.withinBudget ? `, inside its ${near(b.cap)} NEAR new-payee allowance (the most the guard lets go to payees your rules never named, ${hours(b.hours)})` : ""}.`);
    $("#means").textContent = short;
    $("#means").hidden = false;
    $("#means-full").textContent = full.join(" ");
    $("#means-more").hidden = false;
    return full.join(" ");
  }

  function onDone(d) {
    siegeEl.dataset.state = "done";
    lastBudget = d.budget ?? null;
    lastStops = d.tried && d.stopped ? { tried: d.tried, stopped: d.stopped } : null;
    for (const [k, v] of Object.entries(d.losses || {})) finishGuard(k, v);
    if (attacks.mandate) renderLedger(attacks.mandate);
    sumLine(d);
    const said = verdictLine(d) + " " + meansLine(d);
    // Each card says how many of the mandate's clauses its guard let through, counted from the same findings the clauses show.
    const total = d.sentences.length;
    for (const [k, g] of Object.entries(guards)) {
      const hit = d.sentences.filter((s) => s.findings.some((f) => f.guard === k));
      const n = hit.length;
      const word = total === 1 ? "rule" : "rules";
      // Inside the allowance is the guard doing what the rules allow, so it is not reported as getting past.
      const inAllowance = k === "mandate" && lastBudget?.withinBudget && hit.every((s) => s.findings.filter((f) => f.guard === k).every((f) => f.kind === "theft"));
      g.clauses.textContent = n === 0 ? `Held on all ${total} ${word}` : inAllowance ? `Paid from its allowance on ${n} of your ${total} ${word}` : `Got past on ${n} of your ${total} ${word}`;
      g.clauses.hidden = total === 0;
      const tried = lastStops?.tried?.[k], stopped = lastStops?.stopped?.[k];
      g.stops.hidden = !(tried > 0 && Number.isInteger(stopped));
      if (!g.stops.hidden) g.stops.textContent = `${stopped.toLocaleString("en")} of ${tried.toLocaleString("en")} attacks stopped`;
    }
    clausesEl.replaceChildren();
    const seen = new Set();
    for (const s of d.sentences) {
      const breach = s.findings.length > 0;
      const plainBroke = s.findings.some((f) => f.guard === "outlayer");
      const mf = s.findings.filter((f) => f.guard === "mandate");
      const guardOutcome = !mf.length ? "held" : lastBudget?.withinBudget && mf.every((f) => f.kind === "theft") ? "budget" : "lost";
      if (plainBroke) seen.add("plain");
      seen.add(guardOutcome);
      clausesEl.append(
        el(
          "li",
          { class: `clause clause--${plainBroke ? "breach" : "held"}`, "data-index": s.index, "data-guard": guardOutcome },
          el("span", { class: "clause__text", text: s.text }),
          breach ? noteFor(s.findings, s) : el("div", { class: "note" }, el("span", { class: "note--held", text: "Both guards held." })),
        ),
      );
    }
    showKey(seen);
    generalEl.replaceChildren();
    if (d.general?.length) {
      generalEl.append(el("h2", { text: "Not tied to one rule" }), noteFor(d.general));
    }
    setMode("annotated");
    const honest = $("#honest");
    honest.replaceChildren(`No worse attack found in `, el("b", { text: d.evaluations.toLocaleString("en") }), ` attacks tried across both guards. This is a bounded search, not a proof.`);
    honest.hidden = false;
    $("#ledgers").hidden = false;
    hasResult = true;
    stateEl.textContent = example ? "Example run" : `Finished, ${d.evaluations.toLocaleString("en")} attacks tried across both guards`;
    $("#play-totals").textContent = `Final: plain policy lost ${near(d.losses?.outlayer ?? 0)} NEAR, the guard ${near(d.losses?.mandate ?? 0)} NEAR.`;
    renderNext(d);
    if (example) return;
    // The mandate's notes grow during the run and push the siege down on phones: land on the verdict when it is in.
    if (matchMedia("(max-width: 40rem)").matches) siegeEl.scrollIntoView({ behavior: "auto", block: "start" });
    siegeBtn.removeAttribute("aria-busy");
    btnLabel.textContent = "Lay siege again";
    announce(`Siege finished. ${said} Sentences the plain policy lost on are underlined in red in your rules.`, true);
    // A keyboard user who started the siege lands on the verdict, then tabs on to the clause details and ledgers.
    if (focusAfter()) $("#siege-verdict").focus({ preventScroll: true });
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
    drainTimer = setTimeout(drain, reduced || type !== "progress" ? 0 : data.play ? 1100 : 45);
  }

  // Focus moves with the siege only when it would otherwise be lost: on the page, the hidden mandate, or the siege heading.
  const focusAfter = () => [document.body, ta, $("#siege-h"), null].includes(document.activeElement);
  function siegeError(msg, retry = "Try again") {
    if (es) es.close(), (es = null);
    // Drop the events still queued for display, so the stopped run does not keep animating.
    queue.length = 0;
    clearTimeout(drainTimer);
    drainTimer = null;
    siegeEl.dataset.state = "error";
    stateEl.textContent = "Stopped";
    $("#siege-error-msg").textContent = msg;
    $("#retry-btn").textContent = retry;
    $("#siege-error").hidden = false;
    siegeBtn.removeAttribute("aria-busy");
    btnLabel.textContent = "Lay siege";
    const typing = document.activeElement === ta && !ta.hidden;
    if (hasResult) {
      // The new run never connected: the last finished result stays, dimmed and labelled, beside the error.
      siegeEl.dataset.prev = "true";
      clausesEl.dataset.prev = "true";
      $("#siege-prev").hidden = false;
      if (typing) setMode("edit");
    } else {
      for (const g of Object.values(guards)) if (g.root.dataset.phase !== "done") (g.phase.textContent = g.root.dataset.phase === "running" ? "Interrupted" : "Not run"), (g.root.dataset.phase = "waiting");
      setMode("edit");
    }
    announce(msg, true);
    if (!typing && focusAfter()) $("#retry-btn").focus({ preventScroll: true });
  }

  async function laySiege() {
    if (siegeBtn.getAttribute("aria-busy") === "true") return;
    if (!compileOk) {
      ta.focus();
      return void (status.textContent ||= "Fix your rules first.");
    }
    const moveFocus = focusAfter();
    // The stakes did their job once a siege starts: fold them so the play by play is in view. "How it works" brings them back.
    showStakes(false);
    const running = (label) => {
      siegeEl.dataset.state = "running";
      stateEl.textContent = label;
      siegeBtn.setAttribute("aria-busy", "true");
      btnLabel.textContent = "Laying siege…";
    };
    // Clear the board and show the live clauses. With a finished result on screen this waits for the first event, so a dead server does not wipe it.
    const clearBoard = (keepStream) => {
      resetSiege(keepStream);
      setMode(liveClauses() ? "annotated" : "edit");
    };
    if (hasResult) {
      if (es) es.close(), (es = null);
      queue.length = 0;
      clearTimeout(drainTimer);
      drainTimer = null;
      $("#siege-error").hidden = true;
    } else clearBoard();
    if (moveFocus) $("#siege-h").focus({ preventScroll: true });
    announce("Siege started. Attacking plain OutLayer policy first, then the Mandate guard.", true);
    // On phones the siege sits below the mandate, out of sight: bring it up as it starts.
    if (matchMedia("(max-width: 40rem)").matches) siegeEl.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    running("Starting the attacker…");
    const text = ta.value;
    prevRun = lastRun && lastRun.text !== text ? lastRun : null;
    let started = false, finished = false;
    es = new EventSource(`/api/siege?mandate=${encodeURIComponent(text)}&generations=${GENERATIONS}`);
    es.addEventListener("start", (e) => {
      started = true;
      if (hasResult) clearBoard(true), running("Starting the attacker…");
      const s = JSON.parse(e.data);
      legit = new Set(s.legit || []);
      guards.outlayer.root.dataset.phase = "running";
      guards.outlayer.phase.textContent = `Attack round 0 of ${s.generations}`;
      $(".guard__preview", guards.mandate.root).textContent = "Up next, once the plain policy is done";
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
        siegeError(h.sieges >= (h.maxSieges ?? 1) ? `The attacker is busy: ${h.sieges} other sieges are running, the most it runs at once. Try again in a few seconds.` : "The server refused this siege. Check your rules read cleanly above, then try again.");
      } catch {
        siegeError("Can’t reach the SIEGE server. Check your connection, then try again.");
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

  // ---------- next step ----------
  // After the verdict: the weakest clause, a one-click rewrite where the findings support one, and the way to use the guard.
  function suggestFor(s) {
    if (!s.roles?.includes("open-recipients") || !legit.size || !s.findings.some((f) => f.kind === "theft")) return null;
    const who = list([...legit]);
    const cap = s.text.match(/up to ([\d.]+)\s*(NEAR)?\s*per (transaction|tx|payment|transfer)/i);
    return cap ? `Pay up to ${cap[1]} ${cap[2] || "NEAR"} per transaction to ${who}.` : `Pay only ${who}.`;
  }
  let pendingFix = null;
  function renderNext(d) {
    const losses = d.losses || {};
    const delta = $("#next-delta");
    if (prevRun) {
      const was = prevRun.losses;
      delta.textContent = `Since your edit: with the guard ${near(was.mandate ?? 0)} → ${near(losses.mandate ?? 0)} NEAR lost; without SIEGE ${near(was.outlayer ?? 0)} → ${near(losses.outlayer ?? 0)}.`;
    }
    delta.hidden = !prevRun;
    if (!example) lastRun = { text: ta.value, losses };
    const scored = d.sentences.map((s) => ({ s, loss: s.findings.reduce((a, f) => a + f.loss, 0), guardLoss: s.findings.filter((f) => f.guard === "mandate").reduce((a, f) => a + f.loss, 0) }));
    // The weak point is the clause the guard itself lost on; failing that, the one that lost the most without SIEGE.
    const weak = [...scored].sort((a, b) => b.guardLoss - a.guardLoss || b.loss - a.loss)[0];
    const weakEl = $("#next-weak");
    const fix0 = weak?.guardLoss > 0 ? suggestFor(weak.s) : null;
    if (!weak || weak.loss <= 0) weakEl.textContent = "No rule let money out.";
    else if (weak.guardLoss > 0) weakEl.textContent = (d.budget?.withinBudget ? `Rule ${weak.s.index + 1} let ${near(weak.guardLoss)} NEAR out through the guard’s allowance, to payees your rules never named.` : `Rule ${weak.s.index + 1} let ${near(weak.guardLoss)} NEAR past the guard.`) + `${fix0 ? " Naming your payees closes that gap:" : ""}`;
    else weakEl.textContent = `The guard held every rule. Without it, rule ${weak.s.index + 1} lost the most: ${near(weak.loss)} NEAR.`;
    const fix = fix0;
    // The panel's title is the action itself, from this run's weakest clause.
    $("#next-h").textContent = !weak || weak.loss <= 0 ? "Use the guard as it is" : weak.guardLoss > 0 ? `Fix rule ${weak.s.index + 1}` : "Put the guard in front of your wallet";
    pendingFix = fix ? { from: weak.s.text, to: fix } : null;
    $("#next-fix").hidden = !fix;
    if (fix) $("#next-fix-text").textContent = `“${fix}”`;
    $("#next").hidden = false;
  }
  $("#next-fix-btn").addEventListener("click", async () => {
    if (!pendingFix || !ta.value.includes(pendingFix.from)) return;
    ta.value = ta.value.replace(pendingFix.from, pendingFix.to);
    pendingFix = null;
    fit();
    await compile();
    laySiege();
  });
  $("#next-use").addEventListener("click", () => {
    const x = $("#export");
    x.open = true;
    x.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    $("summary", x).focus({ preventScroll: true });
  });

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
        msg.textContent = r.status === 422 ? why422(j.error) : sentence(j.error || "That did not go through");
        const bad = /amount/.test(j.error) ? "#t-amount" : /recipient/.test(j.error) ? "#t-to" : /arguments/.test(j.error) ? "#t-args" : null;
        if (bad) $(bad).setAttribute("aria-invalid", "true"), $(bad).focus();
        return;
      }
      renderVerdicts(j);
    } catch {
      msg.textContent = "Can’t reach the SIEGE server. Check your connection, then try again.";
    } finally {
      btn.removeAttribute("aria-busy");
    }
  });
  // A refusal code in plain words where there is one; otherwise the code itself, made readable.
  const plainWhy = (c) => { const b = because(c, {}); return b === "it breaks your rules" ? human(c).toLowerCase() : b; };
  function renderVerdicts(j) {
    const box = $("#verdicts");
    box.replaceChildren();
    const says = (g) => (j[g].verdict === "allow" ? "would send it" : j[g].verdict === "deny" ? "would refuse it" : `would ${j[g].verdict} it`);
    $("#try-live").textContent = `${GUARD.outlayer} ${says("outlayer")}. ${GUARD.mandate} ${says("mandate")}.`;
    for (const g of ["outlayer", "mandate"]) {
      const v = j[g];
      const allow = v.verdict === "allow";
      const why = v.reasons?.length ? sentence([...new Set(v.reasons.map(plainWhy))].join("; ")) : allow ? "Nothing in its policy stops this." : "";
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
    const deny = compiled?.guardConfig?.thresholds?.denyAbove ?? 0.75;
    const sig = el("div", { class: "signals" }, el("h3", { text: `What the guard noticed: risk ${Number(j.risk).toFixed(2)} of 1 (it refuses from ${deny})` }));
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

  // After a dropped connection, read the mandate again once the page is back online or back in view.
  const recompile = () => !compileOk && document.visibilityState === "visible" && compile();
  addEventListener("online", recompile);
  document.addEventListener("visibilitychange", recompile);

  // ---------- start ----------
  fit();
  count();
  // First visit: the board shows a recorded siege on the default rules, marked as an example, so the result is on
  // screen before anyone presses a button. Any real siege, an example pick or an edit replaces it.
  async function showExample() {
    let ex;
    try {
      ex = await (await fetch("/example-siege.json")).json();
    } catch {
      return;
    }
    if (!compileOk || hasResult || siegeEl.dataset.state !== "idle" || ta.value.trim() !== ex.mandate) return;
    example = true;
    siegeEl.dataset.state = "running";
    setMode(liveClauses() ? "annotated" : "edit");
    for (const [type, data] of ex.events) {
      if (type === "start") legit = new Set(data.legit || []);
      else if (type === "progress") onProgress({ ...data, play: undefined });
      else if (type === "attack") onAttack(data);
      else if (type === "done") onDone(data);
    }
    const plays = ex.events.filter(([t, d]) => t === "progress" && d.play).slice(-PLAY_KEEP);
    for (const [, d] of plays) onPlay(d.play);
    $$(".line--fresh").forEach((n) => n.classList.remove("line--fresh"));
    $$(".clause--fresh, .live-mark--fresh").forEach((n) => n.classList.remove("clause--fresh", "live-mark--fresh"));
    siegeEl.dataset.example = "true";
    $("#siege-example").hidden = false;
  }
  compile().then(() => {
    if (new URLSearchParams(location.search).get("autosiege") === "1" && compileOk) laySiege();
    else showExample();
  });
})();
