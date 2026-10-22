// michtype client

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ?guest gives this tab its own identity (handy for racing yourself in two tabs)
const idStore = new URLSearchParams(location.search).has("guest") ? sessionStorage : localStorage;
let PID = idStore.getItem("mt.pid");
if (!PID) { PID = crypto.randomUUID(); idStore.setItem("mt.pid", PID); }
let NAME = idStore.getItem("mt.name") || "guest" + Math.floor(1000 + Math.random() * 9000);

async function api(path, body = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: PID, ...body }) });
  return r.json();
}

// ------------------------------------------------------------------ typing engine

class TypingBox {
  constructor(el, { strict = false, onStart, onType, onFinish, onKey } = {}) {
    Object.assign(this, { el, strict, onStart, onType, onFinish, onKey });
    this.enabled = true;
    this.words = [];
  }

  load(words) {
    Object.assign(this, { words, typed: [""], idx: 0, keys: 0, goodKeys: 0, startedAt: 0, done: false, shift: 0 });
    this.el.innerHTML = "";
    this.inner = document.createElement("div");
    this.inner.className = "tb-inner";
    this.wordEls = words.map(() => this.inner.appendChild(Object.assign(document.createElement("div"), { className: "word" })));
    this.ghostEl = this.inner.appendChild(Object.assign(document.createElement("div"), { className: "ghost hidden" }));
    this.caret = this.inner.appendChild(Object.assign(document.createElement("div"), { className: "caret idle" }));
    this.el.append(this.inner);
    this.wordEls.forEach((_, i) => this.paint(i));
    requestAnimationFrame(() => this.place());
  }

  paint(i) {
    const w = this.words[i], t = this.typed[i] ?? "", el = this.wordEls[i];
    if (!el) return;
    let html = "";
    for (let j = 0; j < Math.max(w.length, t.length); j++) {
      if (j >= w.length) html += `<span class="l extra">${esc(t[j])}</span>`;
      else if (j < t.length) html += `<span class="l ${t[j] === w[j] ? "ok" : "bad"}">${esc(w[j])}</span>`;
      else html += `<span class="l">${esc(w[j])}</span>`;
    }
    el.innerHTML = html;
    el.classList.toggle("err", i < this.idx && t !== w);
  }

  input(kind, data) {
    if (this.done || !this.enabled || !this.words.length) return;
    if (kind === "text") for (const ch of data) { if (this.done) break; ch === " " ? this.space() : this.char(ch); }
    else this.back(kind === "backword");
    this.place();
    this.onType?.();
  }

  begin() {
    if (this.startedAt) return;
    this.startedAt = performance.now();
    this.caret.classList.remove("idle");
    this.onStart?.();
  }

  char(ch) {
    const w = this.words[this.idx], t = this.typed[this.idx];
    if (t.length >= w.length + 8) return;
    this.begin();
    this.keys++;
    if (t.length < w.length && w[t.length] === ch) this.goodKeys++;
    if (t.length < w.length) this.onKey?.(w[t.length], w[t.length] === ch);
    this.typed[this.idx] = t + ch;
    this.paint(this.idx);
    if (this.idx === this.words.length - 1 && this.typed[this.idx] === w) this.finish();
  }

  space() {
    const w = this.words[this.idx], t = this.typed[this.idx];
    if (t === "") return;
    this.keys++;
    if (this.strict && t !== w) return this.shake();   // races: fix the word before moving on
    if (t === w) this.goodKeys++;
    if (this.idx === this.words.length - 1) return this.finish();
    this.idx++;
    this.typed.push("");
    this.paint(this.idx - 1);
  }

  back(wholeWord) {
    const t = this.typed[this.idx];
    if (t.length) { this.typed[this.idx] = wholeWord ? "" : t.slice(0, -1); return this.paint(this.idx); }
    // can only step back into a word that was left wrong
    if (this.idx > 0 && this.typed[this.idx - 1] !== this.words[this.idx - 1]) {
      this.typed.pop();
      this.idx--;
      if (wholeWord) this.typed[this.idx] = "";
      this.paint(this.idx + 1);
      this.paint(this.idx);
    }
  }

  finish() {
    this.done = true;
    this.paint(this.idx);
    this.onFinish?.();
  }

  stop() { this.done = true; }

  // chars of the text typed correctly from the start (race progress)
  get progress() {
    if (this.done && this.idx === this.words.length - 1 && this.typed[this.idx] === this.words[this.idx]) return this.textLength;
    let n = 0;
    for (let i = 0; i < this.idx; i++) n += this.words[i].length + 1;
    const w = this.words[this.idx] ?? "", t = this.typed[this.idx] ?? "";
    let j = 0;
    while (j < t.length && t[j] === w[j]) j++;
    return n + j;
  }
  get textLength() { return this.words.join(" ").length; }

  // monkeytype-style: correct words + their spaces
  get correctChars() {
    let n = 0;
    for (let i = 0; i < this.idx; i++) if (this.typed[i] === this.words[i]) n += this.words[i].length + 1;
    const t = this.typed[this.idx] ?? "";
    if (this.words[this.idx]?.startsWith(t)) n += t.length;
    return n;
  }
  get accuracy() { return this.keys ? Math.round((this.goodKeys / this.keys) * 100) : 100; }

  place() {
    const el = this.wordEls?.[this.idx];
    if (!el) return;
    const letters = el.children, n = (this.typed[this.idx] ?? "").length;
    const y = el.offsetTop;
    const x = n < letters.length ? letters[n].offsetLeft : letters[letters.length - 1].offsetLeft + letters[letters.length - 1].offsetWidth;
    this.caret.style.transform = `translate(${x}px, ${y}px)`;
    const shift = Math.max(0, y - el.offsetHeight);   // keep the active line in the middle row
    if (shift !== this.shift) { this.shift = shift; this.inner.style.transform = `translateY(${-shift}px)`; }
  }

  // hollow caret at a character offset into the text (your best run's pace)
  setGhost(offset) {
    if (offset == null || !this.wordEls?.length) return this.ghostEl?.classList.add("hidden");
    let i = 0;
    while (i < this.words.length - 1 && offset > this.words[i].length) { offset -= this.words[i].length + 1; i++; }
    const el = this.wordEls[i], letters = el.children, n = Math.max(0, Math.min(Math.round(offset), letters.length));
    const x = n < letters.length ? letters[n].offsetLeft : letters[n - 1].offsetLeft + letters[n - 1].offsetWidth;
    this.ghostEl.style.transform = `translate(${x}px, ${el.offsetTop}px)`;
    this.ghostEl.classList.remove("hidden");
  }

  shake() {
    this.el.classList.remove("shake");
    void this.el.offsetWidth;
    this.el.classList.add("shake");
  }
}

// ------------------------------------------------------------------ input routing

const kb = $("#kb");
let view = "type";
const activeBox = () => (view === "type" ? solo.box : view === "race" ? race.box : null);

function focusKb() { if ($("#auth")?.open) return; if (activeBox()) kb.focus({ preventScroll: true }); updateBlur(); }
function updateBlur() {
  for (const b of [solo.box, race.box]) b.el.classList.toggle("blurred", document.activeElement !== kb && b === activeBox());
}

kb.addEventListener("beforeinput", (e) => {
  e.preventDefault();
  const box = activeBox();
  if (!box) return;
  if (e.inputType === "insertText" && e.data) box.input("text", e.data);
  else if (e.inputType === "deleteContentBackward") box.input("back");
  else if (e.inputType === "deleteWordBackward") box.input("backword");
  else return;
  if (box.startedAt) document.body.classList.add("typing");
});
kb.addEventListener("blur", () => setTimeout(updateBlur, 0));
kb.addEventListener("focus", updateBlur);

window.addEventListener("keydown", (e) => {
  if ($("#auth").open) return;
  const inField = e.target instanceof HTMLInputElement && e.target !== kb;
  if (e.key === "Tab" && view === "type") { e.preventDefault(); newSolo(); return; }
  if (inField) return;
  if (view === "race" && e.key === "Enter" && !race.room) { e.preventDefault(); quickRace(); return; }
  if (view === "race" && e.key === "Enter" && race.room?.state === "done") { e.preventDefault(); raceAgain(); return; }
  if (document.activeElement !== kb && activeBox() && e.key.length === 1 && !e.ctrlKey && !e.metaKey) focusKb();
});
window.addEventListener("mousemove", () => document.body.classList.remove("typing"));
window.addEventListener("resize", () => { solo.box.place(); race.box.place(); });

// ------------------------------------------------------------------ views

function show(v) {
  const nav = v;
  if (v === "daily" || v === "type") {
    const mode = v === "daily" ? "daily" : solo.mode === "daily" ? "time" : solo.mode;
    const changed = mode !== solo.mode;
    solo.mode = mode;
    v = "type";
    if (changed || !solo.test || solo.ended) newSolo();
  }
  if (view === "race" && v !== "race" && race.room) leaveRace();
  view = v;
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === nav));
  $$(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + v));
  document.body.classList.remove("typing");
  if (v === "type") requestAnimationFrame(() => solo.box.place());
  if (v === "board") loadBoard();
  if (v === "race") renderRace();
  history.replaceState(null, "", nav === "type" ? "/" : "/" + nav + (v === "race" && race.room?.code ? "/" + race.room.code : ""));
  focusKb();
}
$$("[data-view]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); show(b.dataset.view); }));
$$(".typebox").forEach((el) => el.addEventListener("click", focusKb));

// ------------------------------------------------------------------ name

const chip = $("#name-chip");
let ACCOUNT = false;
function renderChip() {
  chip.textContent = NAME;
  chip.classList.toggle("locked", ACCOUNT);
  chip.title = ACCOUNT ? "Signed in" : "Change your name";
  $("#auth-btn").textContent = ACCOUNT ? "Sign out" : "Sign in";
}
let noteTimer;
function nameNote(msg) {
  $("#name-note").textContent = msg;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { $("#name-note").textContent = ""; }, 5000);
}
async function setName(n) {
  const res = await api("/api/hello", { name: n });
  NAME = res.name;
  ACCOUNT = !!res.account;
  idStore.setItem("mt.name", NAME);
  if (res.error) nameNote(res.error);
  renderChip();
}
chip.addEventListener("click", () => {
  if (ACCOUNT || chip.querySelector("input")) return;
  chip.innerHTML = `<input maxlength="16" value="${esc(NAME)}" aria-label="Your name">`;
  const inp = chip.querySelector("input");
  inp.focus(); inp.select();
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { inp.value = NAME; inp.blur(); } });
  inp.addEventListener("blur", () => setName(inp.value), { once: true });
});

// ------------------------------------------------------------------ sign in

const auth = { mode: "login", dialog: $("#auth") };
const AUTH_COPY = {
  login: { title: "Welcome back", sub: "Sign in to get your scores on this device. Any scores you set here as a guest come with you.", submit: "Sign in", pass: "current-password" },
  signup: { title: "Keep your scores", sub: "Create an account to lock in your name and use your scores on any device. Everything you've done as a guest stays.", submit: "Create account", pass: "new-password" },
};
function setAuthMode(mode) {
  auth.mode = mode;
  const c = AUTH_COPY[mode];
  $$("#auth-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#auth-title").textContent = c.title;
  $("#auth-sub").textContent = c.sub;
  $("#auth-submit").textContent = c.submit;
  $("#auth-pass").autocomplete = c.pass;
  $("#auth-error").textContent = "";
}
$$("#auth-tabs button").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.mode)));
$("#auth-cancel").addEventListener("click", () => auth.dialog.close());
$("#auth-btn").addEventListener("click", () => {
  if (ACCOUNT) {   // signing out leaves this browser as a fresh guest
    idStore.setItem("mt.pid", crypto.randomUUID());
    idStore.removeItem("mt.name");
    location.reload();
    return;
  }
  setAuthMode("login");
  $("#auth-form").reset();
  auth.dialog.showModal();
  $("#auth-user").focus();
});
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#auth-submit");
  btn.disabled = true;
  const body = { username: $("#auth-user").value, password: $("#auth-pass").value };
  let res;
  try { res = await api(auth.mode === "login" ? "/api/login" : "/api/signup", body); } catch { res = { error: "Couldn't reach the server. Try again." }; }
  btn.disabled = false;
  if (res.error) { $("#auth-error").textContent = res.error; return; }
  if (auth.mode === "login") {   // this device now uses the account's player id
    idStore.setItem("mt.pid", res.pid);
    idStore.setItem("mt.name", res.name);
    location.reload();
    return;
  }
  NAME = res.name;
  ACCOUNT = true;
  idStore.setItem("mt.name", NAME);
  renderChip();
  auth.dialog.close();
  nameNote("");
});

// ------------------------------------------------------------------ key stats (weak-key map + practice)

const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const lifetimeKeys = () => { try { return JSON.parse(store.get("mt.keys", "{}")); } catch { return {}; } };
function saveKeys(test) {
  const all = lifetimeKeys();
  for (const [k, [hit, miss]] of Object.entries(test)) {
    const [h, m] = all[k] ?? [0, 0];
    all[k] = [Math.min(h + hit, 2000), Math.min(m + miss, 2000)];
  }
  store.set("mt.keys", JSON.stringify(all));
}
function weakKeys() {
  const rate = ([, [h, m]]) => m / (h + m);
  return Object.entries(lifetimeKeys())
    .filter((e) => e[1][0] + e[1][1] >= 10 && rate(e) > 0.02)
    .sort((a, b) => rate(b) - rate(a))
    .slice(0, 4).map(([k]) => k);
}

function keyMap(test) {
  const misses = Object.values(test).reduce((n, [, m]) => n + m, 0);
  const worst = Math.max(1, ...Object.values(test).map(([, m]) => m));
  const rows = KEY_ROWS.map((row) => `<div class="kb-row">${[...row].map((k) => {
    const m = test[k]?.[1] ?? 0;
    return `<div class="key${m ? " hot" : ""}" style="--heat:${((m / worst) * 0.85).toFixed(2)}">${k}${m ? `<small>${m}</small>` : ""}</div>`;
  }).join("")}</div>`).join("");
  const weak = weakKeys();
  return `<div class="keys">
    <h2>${misses ? `Missed keys <span>this test, ${misses} in total</span>` : "No missed keys this test"}</h2>
    <div class="kb">${rows}</div>
    ${weak.length ? `<div class="res-actions"><button class="link" id="drill">Practice ${weak.join(", ")}</button><span class="note quiet" style="margin:0">Your most-missed keys across all tests.</span></div>` : ""}
  </div>`;
}

// ------------------------------------------------------------------ practice + daily

const solo = {
  mode: "time", duration: Number(store.get("mt.dur", 30)) || 30, focus: "",
  test: null, t0: 0, timer: null, samples: [], curve: [], keys: {}, ghost: null, ended: false, gen: 0,
  box: new TypingBox($("#solo-box"), {
    onStart: () => startSoloClock(),
    onFinish: () => endSolo(),
    onKey: (exp, ok) => {
      const k = exp.toLowerCase();
      if (!/^[a-z]$/.test(k)) return;
      const s = (solo.keys[k] ??= [0, 0]);
      s[ok ? 0 : 1]++;
    },
  }),
};

const getGhost = (d) => { try { return JSON.parse(store.get("mt.ghost." + d, "null")); } catch { return null; } };

function markDuration() { $$("#modebar button[data-dur]").forEach((b) => b.classList.toggle("active", Number(b.dataset.dur) === solo.duration)); }
$$("#modebar button[data-dur]").forEach((b) => b.addEventListener("click", () => {
  solo.duration = Number(b.dataset.dur);
  store.set("mt.dur", solo.duration);
  newSolo();
}));

async function newSolo() {
  const gen = ++solo.gen;
  clearInterval(solo.timer);
  Object.assign(solo, { samples: [], curve: [], keys: {}, ended: false, t0: 0 });
  const daily = solo.mode === "daily", drill = solo.mode === "drill";
  document.body.classList.remove("typing");
  $("#solo-results").classList.add("hidden");
  $("#solo-play").classList.remove("hidden");
  $("#modebar").classList.toggle("hidden", daily);
  $("#daily-head").classList.toggle("hidden", !daily);
  $("#solo-timer").textContent = daily ? "0" : solo.duration;
  $("#solo-wpm").textContent = "";
  const tag = $("#drill-tag");
  tag.classList.toggle("hidden", !drill);
  if (drill) {
    tag.innerHTML = `Practicing ${esc(solo.focus.split("").join(", "))}, not ranked. <button class="link" id="stop-drill">Back to normal tests</button>`;
    $("#stop-drill").addEventListener("click", () => { solo.mode = "time"; newSolo(); });
  }
  solo.ghost = solo.mode === "time" ? getGhost(solo.duration) : null;
  $("#ghost-note").classList.toggle("hidden", !solo.ghost);
  markDuration();
  const t = await api("/api/solo/start", { duration: solo.duration, mode: solo.mode, focus: solo.focus });
  if (gen !== solo.gen) return;
  solo.test = t;
  solo.box.strict = daily;
  solo.box.load(t.words);
  if (daily) {
    $("#daily-title").textContent = `Daily #${t.no}`;
    $("#daily-sub").textContent = t.done
      ? "You've already set today's score. Any run from now on is practice."
      : "Everyone types the same passage today. Your first finished run goes on the board.";
  }
  focusKb();
}

function startSoloClock() {
  solo.t0 = performance.now();
  const daily = solo.mode === "daily";
  let lastSec = 0, lastHalf = 0;
  solo.timer = setInterval(() => {
    const el = (performance.now() - solo.t0) / 1000;
    $("#solo-timer").textContent = daily ? Math.floor(el) : Math.max(0, Math.ceil(solo.duration - el));
    const chars = daily ? solo.box.progress : solo.box.correctChars;
    const wpm = el > 0.5 ? Math.round(chars / 5 / (el / 60)) : 0;
    $("#solo-wpm").textContent = wpm ? wpm + " wpm" : "";
    if (Math.floor(el) > lastSec) { lastSec = Math.floor(el); solo.samples.push(wpm); }
    if (Math.floor(el * 2) > lastHalf) { lastHalf = Math.floor(el * 2); solo.curve.push(chars); }
    if (solo.ghost) {
      // curve[i] = chars at (i + 1) * 0.5s
      const c = solo.ghost.curve, f = el * 2 - 1, i = Math.floor(f);
      const at = i < 0 ? (c[0] ?? 0) * Math.max(0, el * 2) : i >= c.length - 1 ? c.at(-1) : c[i] + (c[i + 1] - c[i]) * (f - i);
      solo.box.setGhost(at);
    }
    if (!daily && el >= solo.duration) endSolo();
    if (daily && el > 300) endSolo();
  }, 100);
}

async function endSolo() {
  if (solo.ended) return;
  solo.ended = true;
  clearInterval(solo.timer);
  solo.box.stop();
  solo.box.setGhost(null);
  document.body.classList.remove("typing");
  const box = solo.box, gen = solo.gen, mode = solo.mode, prevGhost = solo.ghost;
  const typed = box.typed.slice(0, box.idx + 1);
  if (typed.length > 1 && typed[typed.length - 1] === "") typed.pop();
  const elapsedMs = performance.now() - solo.t0;
  const elapsed = Math.min(mode === "daily" ? Infinity : solo.duration, elapsedMs / 1000);
  saveKeys(solo.keys);
  let res;
  try { res = await api("/api/solo/finish", { testId: solo.test.testId, typed, acc: box.accuracy, elapsedMs: Math.round(elapsedMs) }); } catch { res = { error: "offline" }; }
  if (gen !== solo.gen) return;
  if (res.error) res = { wpm: Math.round(box.correctChars / 5 / (elapsed / 60)), acc: box.accuracy, seconds: Math.round(elapsed * 10) / 10, offline: res.error };
  if (mode === "time" && !res.offline && res.wpm > (prevGhost?.wpm ?? 0)) {
    store.set("mt.ghost." + solo.duration, JSON.stringify({ wpm: res.wpm, curve: solo.curve }));
  }
  renderSoloResults(res, mode, prevGhost);
}

function sparkline(runs) {
  const series = runs.filter((r) => r.data.length >= 2);
  if (!series.length) return "";
  const W = 800, H = 96, P = 4, len = Math.max(...series.map((r) => r.data.length));
  const max = Math.max(10, ...series.flatMap((r) => r.data)) * 1.15;
  const path = (data) => data.map((v, i) => (i ? "L" : "M") + (P + (i / (len - 1)) * (W - P * 2)).toFixed(1) + " " + (H - 18 - (v / max) * (H - 26)).toFixed(1)).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Speed over the test">
    <line x1="${P}" x2="${W - P}" y1="${H - 18}" y2="${H - 18}"/>
    ${series.map((r) => `<path class="${r.cls}" d="${path(r.data)}"/>`).join("")}
    <text x="${P}" y="${H - 2}">1s</text><text x="${W - P}" y="${H - 2}" text-anchor="end">${len}s</text>
  </svg>`;
}

// the stored best run is chars every half second; turn it into wpm per second
const ghostSeries = (g) => (g?.curve ?? []).filter((_, i) => i % 2 === 1).map((c, i) => Math.round(c / 5 / ((i + 1) / 60)));

function renderSoloResults(r, mode, prevGhost) {
  $("#solo-play").classList.add("hidden");
  $("#daily-head").classList.add("hidden");
  const el = $("#solo-results");
  const stat = (k, v) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  const offline = `<p class="note quiet">Couldn't reach the server, so this run wasn't saved.</p>`;
  let top, note = "", chart = "", actions;
  if (mode === "daily") {
    top = stat("Accuracy", r.acc + "%") + stat("Time", (r.seconds ?? "–") + "s") + (r.rankDaily ? stat("Today", "#" + r.rankDaily) : "");
    note = r.offline ? offline
      : r.ranked ? `<p class="note">That's your score for today. A new passage comes out tomorrow.</p>`
      : `<p class="note quiet">Practice run. Your first run today is the one on the board.</p>`;
    actions = `<button class="btn" id="share">Copy result</button>
      <button class="link" id="to-board">See today's board</button><button class="link" id="again">Type it again</button>`;
  } else {
    const best = prevGhost?.wpm;
    top = stat("Accuracy", r.acc + "%") + (r.rawWpm != null ? stat("Raw", Math.round(r.rawWpm)) : "") +
      (r.rankAll ? stat(`${solo.duration}s rank`, "#" + r.rankAll) : "") + (best ? stat("Your best", Math.round(Math.max(best, r.wpm))) : "");
    note = r.offline ? offline
      : mode === "drill" ? `<p class="note quiet">Practice tests aren't ranked.</p>`
      : best && r.wpm > best ? `<p class="note">New best for ${solo.duration}s, up ${Math.round(r.wpm - best)} wpm. Next time the hollow caret races this run.</p>`
      : !best ? `<p class="note quiet">Next time, a hollow caret replays this run while you type. Try to stay ahead of it.</p>` : "";
    chart = sparkline([{ data: ghostSeries(mode === "time" ? prevGhost : null), cls: "best" }, { data: solo.samples, cls: "line" }]) +
      (mode === "time" && prevGhost ? `<div class="legend"><span><i></i>This run</span><span><i class="best"></i>Your previous best</span></div>` : "");
    actions = `<button class="btn" id="again">Next test <kbd>Tab</kbd></button><button class="link" id="to-board">Leaderboard</button>`;
  }
  el.innerHTML = `
    <div class="res-top"><div class="stat big"><div class="k">${mode === "daily" ? `Daily #${r.no ?? ""}` : "Words per minute"}</div>
      <div class="v">${Math.round(r.wpm)}${mode === "daily" ? "<small>wpm</small>" : ""}</div></div>${top}</div>
    ${note}${chart}
    <div class="res-actions">${actions}</div>
    ${keyMap(solo.keys)}`;
  el.classList.remove("hidden");
  $("#again").addEventListener("click", newSolo);
  $("#to-board").addEventListener("click", () => { boardState.board = mode === "daily" ? "daily" : "solo" + solo.duration; show("board"); });
  $("#drill")?.addEventListener("click", () => { solo.mode = "drill"; solo.focus = weakKeys().join(""); newSolo(); });
  $("#share")?.addEventListener("click", async (e) => {
    const text = `michtype daily #${r.no}\n${Math.round(r.wpm)} wpm, ${r.acc}% accuracy, ${r.seconds}s\n${location.origin}/daily`;
    try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied"; } catch { e.target.textContent = "Couldn't copy"; }
  });
}

// ------------------------------------------------------------------ race

const race = {
  room: null, you: null, offset: 0, key: null, result: null, sendTimer: null, lastSent: 0, error: "",
  box: new TypingBox($("#race-box"), { strict: true, onType: () => queueProgress(), onFinish: () => sendProgress() }),
};
race.box.enabled = false;

const serverNow = () => Date.now() + race.offset;

async function quickRace() { setLobbyError(""); race.joined = true; await api("/api/race/quick"); }
async function raceAgain() { race.result = null; await api("/api/race/again"); }
async function leaveRace() {
  race.joined = false;
  race.room = null; race.key = null; race.result = null;
  await api("/api/race/leave");
  renderRace();
  history.replaceState(null, "", view === "race" ? "/race" : location.pathname);
}
function setLobbyError(msg) { $("#lobby-error").textContent = msg; }

$("#quick-race").addEventListener("click", quickRace);
$("#create-room").addEventListener("click", async () => { setLobbyError(""); race.joined = true; await api("/api/race/create"); });
$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  race.joined = true;
  const res = await api("/api/race/join", { code: $("#join-code").value });
  if (res.error) race.joined = false;
  setLobbyError(res.error ?? "");
});
$("#leave-room").addEventListener("click", leaveRace);
$("#start-race").addEventListener("click", () => api("/api/race/start", { bots: $("#add-bots").checked ? 3 : 0 }));
$("#copy-link").addEventListener("click", async () => {
  const url = `${location.origin}/race/${race.room.code}`;
  try { await navigator.clipboard.writeText(url); } catch {}
  race.copied = true;
  renderRace();
  setTimeout(() => { race.copied = false; renderRace(); }, 1400);
});

function queueProgress() {
  if (race.sendTimer) return;
  const wait = Math.max(0, 120 - (performance.now() - race.lastSent));
  race.sendTimer = setTimeout(sendProgress, wait);
  renderLanes();
}
function sendProgress() {
  clearTimeout(race.sendTimer);
  race.sendTimer = null;
  race.lastSent = performance.now();
  api("/api/race/progress", { progress: race.box.progress, acc: race.box.accuracy });
  renderLanes();
}

function onRoom(room) {
  // a room left over from before a reload: drop it instead of pulling the player back in
  if (!race.joined) { api("/api/race/leave"); return; }
  race.room = room;
  race.you = room.you;
  race.offset = room.serverNow - Date.now();
  const key = room.id + ":" + room.round;
  if (key !== race.key) {           // a new race (or new room)
    race.key = key;
    race.result = null;
    race.box.load(room.text.split(" "));
    race.box.enabled = false;
    $("#lanes").innerHTML = "";
  }
  if (view !== "race") show("race");
  else {
    renderRace();
    if (room.code) history.replaceState(null, "", "/race/" + room.code);
  }
}

function renderRace() {
  const room = race.room;
  $("#race-lobby").classList.toggle("hidden", !!room);
  $("#race-room").classList.toggle("hidden", !room);
  if (!room) return;
  const isHost = room.host === race.you;
  const humans = room.players.filter((p) => !p.bot && !p.left).length;
  const status = {
    waiting: room.isPublic ? `<b>Looking for racers.</b> ${humans} here so far` : isHost ? `<b>Your room.</b> Send the link, then start when everyone's in.` : `<b>Waiting for the host</b> to start the race.`,
    countdown: `<b>Get ready.</b>`,
    racing: `<b>Go.</b>`,
    done: `<b>Race over.</b>`,
  }[room.state];
  $("#race-status").innerHTML = status;
  const copy = $("#copy-link");
  copy.classList.toggle("hidden", !room.code);
  if (room.code) copy.textContent = race.copied ? "Link copied" : `Copy invite link (${room.code})`;
  $("#host-controls").classList.toggle("hidden", !(isHost && !room.isPublic && room.state === "waiting"));
  renderLanes();
  renderRaceResults();
}

function renderLanes() {
  const room = race.room;
  if (!room) return;
  const lanes = $("#lanes");
  const len = room.text.length;
  const elapsedMin = Math.max((serverNow() - room.startAt) / 60000, 1 / 600);
  for (const p of room.players) {
    let el = lanes.querySelector(`[data-id="${p.id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "lane";
      el.dataset.id = p.id;
      el.innerHTML = `<div class="who"></div><div class="track"><div class="fill"></div><div class="dot"></div></div><div class="spd"></div>`;
      lanes.append(el);
    }
    const you = p.id === race.you;
    let prog = p.progress, wpm = p.wpm;
    if (you && room.state === "racing" && !p.finished) { prog = race.box.progress; wpm = prog / 5 / elapsedMin; }
    const pct = Math.min(100, (prog / len) * 100);
    el.classList.toggle("you", you);
    el.classList.toggle("left", !!p.left);
    el.querySelector(".who").innerHTML = `${esc(p.name)}${you ? "<small>you</small>" : p.bot ? "<small>bot</small>" : ""}`;
    el.querySelector(".fill").style.width = pct + "%";
    el.querySelector(".dot").style.left = pct + "%";
    el.querySelector(".spd").innerHTML = p.finished
      ? `<span class="place p${p.place}">${ordinal(p.place)}</span>`
      : room.state === "racing" || room.state === "done" ? `<b>${Math.round(wpm)}</b> wpm` : "";
  }
  for (const el of $$(".lane", lanes)) if (!room.players.some((p) => p.id === el.dataset.id)) el.remove();
}

const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] ?? "th");

function renderRaceResults() {
  const room = race.room, el = $("#race-results");
  if (!room || room.state !== "done") { el.classList.add("hidden"); return; }
  const rows = [...room.players].sort((a, b) => (a.place || 99) - (b.place || 99) || b.progress - a.progress);
  const me = room.players.find((p) => p.id === race.you);
  const r = race.result;
  el.innerHTML = `
    <div class="res-top">
      <div class="stat big"><div class="k">${me?.finished ? ordinal(me.place) + " place" : "Didn't finish"}</div>
        <div class="v">${me ? Math.round(me.wpm) : 0}<small>wpm</small></div></div>
      <div class="stat"><div class="k">Accuracy</div><div class="v">${me?.acc ?? 0}%</div></div>
      ${r?.rankAll ? `<div class="stat"><div class="k">Race rank</div><div class="v">#${r.rankAll}</div></div>` : ""}
    </div>
    ${r?.pb ? `<p class="note">New best race speed.</p>` : ""}
    <ol class="podium">${rows.map((p) => `<li class="${p.id === race.you ? "you" : ""}">
      <span class="place p${p.place}">${p.finished ? ordinal(p.place) : "–"}</span><span>${esc(p.name)}</span>
      <span>${Math.round(p.wpm)} wpm</span><span>${p.acc}%</span></li>`).join("")}</ol>
    <div class="res-actions">
      <button class="btn" id="race-again">Race again <kbd>Enter</kbd></button>
      <button class="link" id="race-board">Leaderboard</button>
    </div>`;
  el.classList.remove("hidden");
  $("#race-again").addEventListener("click", raceAgain);
  $("#race-board").addEventListener("click", () => { boardState.board = "race"; show("board"); });
}

// countdown + typing gate (an interval rather than rAF so it keeps ticking in background tabs)
let lastCount = null;
function raceFrame() {
  const room = race.room, cd = $("#countdown");
  if (!room || view !== "race") { cd.classList.add("hidden"); return; }
  const now = serverNow();
  const live = (room.state === "countdown" || room.state === "racing") && now >= room.startAt && !race.box.done;
  if (live && !race.box.enabled) { race.box.enabled = true; race.box.begin(); focusKb(); }
  if (!live) race.box.enabled = false;
  race.box.el.classList.toggle("locked", !live);
  if (room.state === "countdown" || (room.state === "racing" && now - room.startAt < 600)) {
    const left = Math.ceil((room.startAt - now) / 1000);
    const label = left > 0 ? String(left) : "Go";
    if (label !== lastCount) {
      lastCount = label;
      cd.textContent = label;
      cd.classList.remove("hidden", "go");
      if (label === "Go") { void cd.offsetWidth; cd.classList.add("go"); }
    }
  } else if (lastCount !== null) { lastCount = null; cd.classList.add("hidden"); }
  if (room.state === "racing") {
    const left = Math.max(0, Math.ceil((room.startAt + room.limitMs - now) / 1000));
    const status = race.box.done ? `<b>Finished.</b> Waiting for the others.` : `<b>Go.</b> ${left}s left`;
    if ($("#race-status").innerHTML !== status) $("#race-status").innerHTML = status;
  }
}
setInterval(raceFrame, 50);

// ------------------------------------------------------------------ leaderboard

const boardState = { board: "solo30", period: "daily" };
$$("#board-tabs button").forEach((b) => b.addEventListener("click", () => { boardState.board = b.dataset.board; loadBoard(); }));
$$("#period-tabs button").forEach((b) => b.addEventListener("click", () => { boardState.period = b.dataset.period; loadBoard(); }));

async function loadBoard() {
  const { board, period } = boardState;
  $$("#board-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.board === board));
  $$("#period-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.period === period));
  $("#period-tabs").classList.toggle("hidden", board === "daily");
  const data = await (await fetch(`/api/leaderboard?board=${board}&period=${period}&pid=${encodeURIComponent(PID)}`)).json();
  if (boardState.board !== board || boardState.period !== period) return;
  const isRace = board === "race";
  $("#board-thead").innerHTML = `<tr><th>Rank</th><th>Name</th><th class="num">${isRace ? "Best wpm" : "Wpm"}</th><th class="num">Accuracy</th>
    ${isRace ? `<th class="num">Wins</th><th class="num hide-sm">Races</th>` : `<th class="num hide-sm">When</th>`}</tr>`;
  const row = (r) => `<tr class="${r.you ? "you" : ""}"><td class="rank">${r.rank}</td><td>${esc(r.name)}</td>
    <td class="num wpm">${r.wpm.toFixed(1)}</td><td class="num">${r.acc}%</td>
    ${isRace ? `<td class="num">${r.wins}</td><td class="num hide-sm">${r.races}</td>` : `<td class="num hide-sm">${ago(r.at)}</td>`}</tr>`;
  $("#board-body").innerHTML = data.top.map(row).join("") + (data.you ? `<tr class="gap"><td colspan="6">⋯</td></tr>` + row(data.you) : "");
  $("#board-empty").classList.toggle("hidden", data.top.length > 0);
}

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

// ------------------------------------------------------------------ live connection

function connect() {
  const es = new EventSource(`/api/events?pid=${encodeURIComponent(PID)}`);
  es.addEventListener("room", (e) => onRoom(JSON.parse(e.data)));
  es.addEventListener("raceResult", (e) => { race.result = JSON.parse(e.data); renderRaceResults(); });
}

async function pollOnline() {
  try { $("#online").textContent = (await (await fetch("/api/stats")).json()).online; } catch {}
}

// ------------------------------------------------------------------ boot

renderChip();
await setName(NAME);
connect();
setTimeout(pollOnline, 600);
setInterval(pollOnline, 15000);

const [, first, second] = location.pathname.split("/");
if (first === "daily") show("daily");
else if (first === "race" && second) {
  show("race");
  race.joined = true;
  const res = await api("/api/race/join", { code: second });
  if (res.error) { race.joined = false; setLobbyError(res.error); }
} else show(["race", "board"].includes(first) ? first : "type");
