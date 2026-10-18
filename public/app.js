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
  constructor(el, { strict = false, onStart, onType, onFinish } = {}) {
    Object.assign(this, { el, strict, onStart, onType, onFinish });
    this.enabled = true;
    this.words = [];
  }

  load(words) {
    Object.assign(this, { words, typed: [""], idx: 0, keys: 0, goodKeys: 0, startedAt: 0, done: false, shift: 0 });
    this.el.innerHTML = "";
    this.inner = document.createElement("div");
    this.inner.className = "tb-inner";
    this.wordEls = words.map(() => this.inner.appendChild(Object.assign(document.createElement("div"), { className: "word" })));
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

function focusKb() { if (activeBox()) kb.focus({ preventScroll: true }); updateBlur(); }
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
  if (view === "race" && v !== "race" && race.room) leaveRace();
  view = v;
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + v));
  document.body.classList.remove("typing");
  if (v === "type") { if (!solo.test || solo.ended) newSolo(); requestAnimationFrame(() => solo.box.place()); }
  if (v === "board") loadBoard();
  if (v === "race") renderRace();
  history.replaceState(null, "", v === "type" ? "/" : "/" + v + (v === "race" && race.room?.code ? "/" + race.room.code : ""));
  focusKb();
}
$$("[data-view]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); show(b.dataset.view); }));
$$(".typebox").forEach((el) => el.addEventListener("click", focusKb));

// ------------------------------------------------------------------ name

const chip = $("#name-chip");
function renderChip() { chip.innerHTML = `${esc(NAME)} <span class="sub">✎</span>`; }
async function setName(n) {
  const res = await api("/api/hello", { name: n });
  NAME = res.name;
  idStore.setItem("mt.name", NAME);
  renderChip();
}
chip.addEventListener("click", () => {
  if (chip.querySelector("input")) return;
  chip.innerHTML = `<input maxlength="16" value="${esc(NAME)}">`;
  const inp = chip.querySelector("input");
  inp.focus(); inp.select();
  const done = () => setName(inp.value);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { inp.value = NAME; inp.blur(); } });
  inp.addEventListener("blur", done, { once: true });
});

// ------------------------------------------------------------------ solo

const solo = {
  duration: Number(store.get("mt.dur", 30)) || 30,
  test: null, t0: 0, timer: null, samples: [], ended: false, gen: 0,
  box: new TypingBox($("#solo-box"), { onStart: () => startSoloClock(), onFinish: () => endSolo() }),
};

function markDuration() { $$(".modebar button").forEach((b) => b.classList.toggle("active", Number(b.dataset.dur) === solo.duration)); }
$$(".modebar button").forEach((b) => b.addEventListener("click", () => {
  solo.duration = Number(b.dataset.dur);
  store.set("mt.dur", solo.duration);
  markDuration();
  newSolo();
}));
$("#solo-restart").addEventListener("click", () => newSolo());

async function newSolo() {
  const gen = ++solo.gen;
  clearInterval(solo.timer);
  Object.assign(solo, { samples: [], ended: false, t0: 0 });
  document.body.classList.remove("typing");
  $("#solo-results").classList.add("hidden");
  $("#solo-play").classList.remove("hidden");
  $("#solo-timer").textContent = solo.duration;
  $("#solo-wpm").textContent = "";
  markDuration();
  const t = await api("/api/solo/start", { duration: solo.duration });
  if (gen !== solo.gen) return;
  solo.test = t;
  solo.box.load(t.words);
  focusKb();
}

function startSoloClock() {
  solo.t0 = performance.now();
  let lastSec = 0;
  solo.timer = setInterval(() => {
    const el = (performance.now() - solo.t0) / 1000;
    $("#solo-timer").textContent = Math.max(0, Math.ceil(solo.duration - el));
    const wpm = el > 0.5 ? Math.round(solo.box.correctChars / 5 / (el / 60)) : 0;
    $("#solo-wpm").textContent = wpm ? wpm + " wpm" : "";
    if (Math.floor(el) > lastSec) { lastSec = Math.floor(el); solo.samples.push(wpm); }
    if (el >= solo.duration) endSolo();
  }, 100);
}

async function endSolo() {
  if (solo.ended) return;
  solo.ended = true;
  clearInterval(solo.timer);
  solo.box.stop();
  document.body.classList.remove("typing");
  const box = solo.box, gen = solo.gen;
  const typed = box.typed.slice(0, box.idx + 1);
  if (typed.length > 1 && typed[typed.length - 1] === "") typed.pop();
  const elapsed = Math.min(solo.duration, (performance.now() - solo.t0) / 1000);
  const local = { wpm: Math.round(box.correctChars / 5 / (elapsed / 60)), acc: box.accuracy };
  let res;
  try { res = await api("/api/solo/finish", { testId: solo.test.testId, typed, acc: box.accuracy }); } catch { res = {}; }
  if (gen !== solo.gen) return;
  renderSoloResults(res.error ? { ...local, rawWpm: null, offline: true } : res);
}

function sparkline(samples) {
  if (samples.length < 2) return "";
  const W = 800, H = 110, P = 22;
  const max = Math.max(...samples, 10) * 1.15;
  const pts = samples.map((v, i) => [P + (i / (samples.length - 1)) * (W - P * 2), H - 16 - (v / max) * (H - 26)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c2f74a" stop-opacity=".22"/><stop offset="1" stop-color="#c2f74a" stop-opacity="0"/></linearGradient></defs>
    <line x1="${P}" x2="${W - P}" y1="${H - 16}" y2="${H - 16}"/>
    <path class="area" d="${d} L${pts.at(-1)[0]} ${H - 16} L${P} ${H - 16} Z"/>
    <path class="line" d="${d}"/>
    <text x="${P}" y="${H - 2}">1s</text><text x="${W - P}" y="${H - 2}" text-anchor="end">${samples.length}s</text>
  </svg>`;
}

function renderSoloResults(r) {
  $("#solo-play").classList.add("hidden");
  const el = $("#solo-results");
  const rank = r.rankDaily ? `<span class="badge soft">#${r.rankDaily} today</span>` : "";
  const pb = r.pb ? `<span class="badge">new best</span>` : "";
  el.innerHTML = `
    <div class="res-top">
      <div class="stat big"><div class="k">wpm ${pb}</div><div class="v">${Math.round(r.wpm)}</div></div>
      <div class="stat"><div class="k">accuracy</div><div class="v">${r.acc}%</div></div>
      ${r.rawWpm != null ? `<div class="stat"><div class="k">raw</div><div class="v">${Math.round(r.rawWpm)}</div></div>` : ""}
      <div class="stat"><div class="k">test</div><div class="v">${solo.duration}s</div></div>
      <div class="stat"><div class="k">rank</div><div class="v">${r.rankAll ? "#" + r.rankAll : "–"}</div></div>
    </div>
    ${sparkline(solo.samples)}
    <div class="res-actions">
      <button class="btn" id="again">next test <kbd>tab</kbd></button>
      <button class="ghost" id="to-board">leaderboard</button>
      ${rank}
      ${r.offline ? `<span class="sub">couldn't reach the server — score not saved</span>` : ""}
      ${r.ranked === false ? `<span class="sub">not ranked</span>` : ""}
    </div>`;
  el.classList.remove("hidden");
  $("#again").addEventListener("click", newSolo);
  $("#to-board").addEventListener("click", () => { boardState.board = "solo" + solo.duration; show("board"); });
}

// ------------------------------------------------------------------ race

const race = {
  room: null, you: null, offset: 0, key: null, result: null, sendTimer: null, lastSent: 0, error: "",
  box: new TypingBox($("#race-box"), { strict: true, onType: () => queueProgress(), onFinish: () => sendProgress() }),
};
race.box.enabled = false;

const serverNow = () => Date.now() + race.offset;

async function quickRace() { setLobbyError(""); await api("/api/race/quick"); }
async function raceAgain() { race.result = null; await api("/api/race/again"); }
async function leaveRace() {
  race.room = null; race.key = null; race.result = null;
  await api("/api/race/leave");
  renderRace();
  history.replaceState(null, "", view === "race" ? "/race" : location.pathname);
}
function setLobbyError(msg) { $("#lobby-error").textContent = msg; }

$("#quick-race").addEventListener("click", quickRace);
$("#create-room").addEventListener("click", async () => { setLobbyError(""); await api("/api/race/create"); });
$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await api("/api/race/join", { code: $("#join-code").value });
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
    waiting: room.isPublic ? `<b>finding racers…</b> ${humans} here` : isHost ? `<b>your room.</b> share the link, then start` : `<b>waiting for the host</b> to start`,
    countdown: `<b>get ready</b>`,
    racing: `<b>go!</b>`,
    done: `<b>race over.</b>`,
  }[room.state];
  $("#race-status").innerHTML = status;
  const copy = $("#copy-link");
  copy.classList.toggle("hidden", !room.code);
  if (room.code) copy.textContent = race.copied ? "link copied ✓" : `room ${room.code} · copy link`;
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
      el.innerHTML = `<div class="who"></div><div class="track"><div class="fill"></div><div class="dot"></div><span class="flag">⚑</span></div><div class="spd"></div>`;
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
      <div class="stat big"><div class="k">${me?.finished ? ordinal(me.place) + " place" : "didn't finish"} ${r?.pb ? '<span class="badge">new best</span>' : ""}</div>
        <div class="v">${me ? Math.round(me.wpm) : 0}<span class="sub" style="font-size:1.2rem"> wpm</span></div></div>
      <div class="stat"><div class="k">accuracy</div><div class="v">${me?.acc ?? 0}%</div></div>
      ${r?.rankAll ? `<div class="stat"><div class="k">race rank</div><div class="v">#${r.rankAll}</div></div>` : ""}
    </div>
    <ol class="podium">${rows.map((p) => `<li class="${p.id === race.you ? "you" : ""}">
      <span class="place p${p.place}">${p.finished ? ordinal(p.place) : "–"}</span><span>${esc(p.name)}</span>
      <span>${Math.round(p.wpm)} wpm</span><span>${p.acc}%</span></li>`).join("")}</ol>
    <div class="res-actions">
      <button class="btn" id="race-again">race again <kbd>enter</kbd></button>
      <button class="ghost" id="race-board">leaderboard</button>
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
    const label = left > 0 ? String(left) : "go";
    if (label !== lastCount) {
      lastCount = label;
      cd.textContent = label;
      cd.classList.remove("hidden", "go");
      if (label === "go") { void cd.offsetWidth; cd.classList.add("go"); }
    }
  } else if (lastCount !== null) { lastCount = null; cd.classList.add("hidden"); }
  if (room.state === "racing") {
    const left = Math.max(0, Math.ceil((room.startAt + room.limitMs - now) / 1000));
    const status = race.box.done ? `<b>finished!</b> waiting for others…` : `<b>go!</b> ${left}s left`;
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
  const data = await (await fetch(`/api/leaderboard?board=${board}&period=${period}&pid=${encodeURIComponent(PID)}`)).json();
  if (boardState.board !== board || boardState.period !== period) return;
  const isRace = board === "race";
  $("#board-thead").innerHTML = `<tr><th>#</th><th>name</th><th class="num">${isRace ? "best" : "wpm"}</th><th class="num">acc</th>
    ${isRace ? `<th class="num">wins</th><th class="num hide-sm">races</th>` : `<th class="num hide-sm">when</th>`}</tr>`;
  const row = (r) => `<tr class="${r.you ? "you" : ""}"><td class="rank">${r.rank}</td><td>${esc(r.name)}</td>
    <td class="num wpm">${r.wpm.toFixed(1)}</td><td class="num">${r.acc}%</td>
    ${isRace ? `<td class="num">${r.wins}</td><td class="num hide-sm">${r.races}</td>` : `<td class="num hide-sm sub">${ago(r.at)}</td>`}</tr>`;
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
if (first === "race" && second) {
  show("race");
  const res = await api("/api/race/join", { code: second });
  if (res.error) setLobbyError(res.error);
} else show(["race", "board"].includes(first) ? first : "type");
