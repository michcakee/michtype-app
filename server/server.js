// michtype server: static files, live race rooms over SSE, solo tests, leaderboards.
// Zero dependencies — run with `node server/server.js`.

import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WORDS, PASSAGES, BOT_NAMES } from "./texts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "db.json");
const PORT = Number(process.env.PORT) || 3000;

const CFG = {
  maxAvgWpm: 300,          // anything above this is not humanly plausible
  roomMax: 5,
  fillBotsAfterMs: 7000,   // alone in a public room this long -> bots join
  countdownMs: 5000,
  raceLimitMs: 120000,
  doneLingerMs: 60000,
  soloDurations: [15, 30, 60],
  soloWordCount: 400,
  testTtlMs: 10 * 60000,
};

// ---------------------------------------------------------------- persistence

// With UPSTASH_REDIS_REST_URL/TOKEN set (hosted), the db lives in Redis so it survives
// restarts; otherwise it's a local JSON file.
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KV_URL = KV_TOKEN ? process.env.UPSTASH_REDIS_REST_URL : null;   // need both to use redis
const KV_KEY = "michtype:db";
async function kv(cmd) {
  const r = await fetch(KV_URL, { method: "POST", headers: { authorization: `Bearer ${KV_TOKEN}` }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const BOARDS = ["solo15", "solo30", "solo60", "race", "daily"];
let db = { names: {}, all: {}, daily: {}, accounts: {} };
for (const b of BOARDS) db.all[b] = {};
try {
  const raw = KV_URL ? await kv(["GET", KV_KEY]) : existsSync(DATA_FILE) ? readFileSync(DATA_FILE, "utf8") : null;
  if (raw) db = { ...db, ...JSON.parse(raw) };
  for (const b of BOARDS) db.all[b] ??= {};
  db.accounts ??= {};   // boards added after the db was first saved
  console.log(`db loaded from ${KV_URL ? "redis" : "file"}`);
} catch (e) {
  console.error("db load failed:", e.message);
  if (KV_URL) process.exit(1);   // don't start empty and overwrite the real leaderboard
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (KV_URL) await kv(["SET", KV_KEY, JSON.stringify(db)]);
      else {
        await mkdir(path.dirname(DATA_FILE), { recursive: true });
        await writeFile(DATA_FILE, JSON.stringify(db));
      }
    } catch (e) { console.error("db save failed:", e.message); }
  }, 1500);
}

const today = () => new Date().toISOString().slice(0, 10);

function dailyBoard(board) {
  const d = today();
  db.daily[d] ??= {};
  db.daily[d][board] ??= {};
  // keep a week of daily boards
  for (const k of Object.keys(db.daily)) if (k < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) delete db.daily[k];
  return db.daily[d][board];
}

// Records a result; returns { pb, rankDaily, rankAll }.
function recordScore(board, pid, wpm, acc, won = false) {
  const now = Date.now();
  let pb = false;
  for (const map of [db.all[board], dailyBoard(board)]) {
    const prev = map[pid];
    const entry = prev ? { ...prev } : { wpm: 0, acc: 0, at: now, races: 0, wins: 0 };
    if (wpm > entry.wpm) {
      if (map === db.all[board] && prev) pb = true;
      entry.wpm = wpm; entry.acc = acc; entry.at = now;
    }
    if (board === "race") { entry.races += 1; if (won) entry.wins += 1; }
    map[pid] = entry;
  }
  save();
  return { pb, rankDaily: rankOf(dailyBoard(board), pid), rankAll: rankOf(db.all[board], pid) };
}

const sortEntries = (map) => Object.entries(map).sort((a, b) => b[1].wpm - a[1].wpm || a[1].at - b[1].at);
const rankOf = (map, pid) => sortEntries(map).findIndex(([p]) => p === pid) + 1 || null;

// ---------------------------------------------------------------- helpers

const pubId = (pid) => crypto.createHash("sha256").update(pid).digest("hex").slice(0, 10);
const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];
const round1 = (n) => Math.round(n * 10) / 10;

function cleanName(name) {
  const n = String(name ?? "").replace(/[^\p{L}\p{N}_\-. ]/gu, "").trim().slice(0, 16);
  return n || "guest";
}
function validPid(pid) { return typeof pid === "string" && /^[a-zA-Z0-9-]{16,64}$/.test(pid); }
function nameOf(pid) { return db.names[pid] || "guest"; }

// ---------------------------------------------------------------- accounts
// An account claims a username and points at a player id (pid). The pid stays the
// player's secret key; signing in on another device hands that pid to the device.

const accountOf = (pid) => Object.values(db.accounts).find((a) => a.pid === pid) ?? null;
const usernameKey = (u) => String(u ?? "").trim().toLowerCase();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password), salt, 64, (err, key) => (err ? reject(err) : resolve({ salt, hash: key.toString("hex") }))));
}

const failedLogins = new Map(); // usernameKey -> { count, until }
function loginLocked(key) {
  const f = failedLogins.get(key);
  return f && f.count >= 5 && Date.now() < f.until;
}
function noteFailedLogin(key) {
  const f = failedLogins.get(key) ?? { count: 0, until: 0 };
  if (Date.now() > f.until) f.count = 0;
  f.count++;
  f.until = Date.now() + 60000;
  failedLogins.set(key, f);
}

// Moves one player's scores onto another (keeps the better score, adds up race counts).
function mergePlayer(from, to) {
  const maps = [...Object.values(db.all), ...Object.values(db.daily).flatMap((d) => Object.values(d))];
  for (const map of maps) {
    const a = map[from];
    if (!a) continue;
    const b = map[to];
    if (!b) map[to] = a;
    else {
      const best = a.wpm > b.wpm ? a : b;
      map[to] = { ...b, wpm: best.wpm, acc: best.acc, at: best.at, races: (a.races ?? 0) + (b.races ?? 0), wins: (a.wins ?? 0) + (b.wins ?? 0) };
    }
    delete map[from];
  }
  delete db.names[from];
}

async function signup(pid, { username, password }) {
  const name = String(username ?? "").trim();
  if (!/^[a-zA-Z0-9_.-]{3,16}$/.test(name)) return { error: "Usernames are 3–16 letters, numbers, dots, dashes or underscores." };
  if (String(password ?? "").length < 6 || String(password).length > 200) return { error: "Passwords need at least 6 characters." };
  if (accountOf(pid)) return { error: "You're already signed in." };
  const key = usernameKey(name);
  if (db.accounts[key]) return { error: "That username is taken." };
  const { salt, hash } = await hashPassword(password);
  if (db.accounts[key]) return { error: "That username is taken." };
  db.accounts[key] = { name, salt, hash, pid, created: Date.now() };
  // a guest using this name elsewhere gets bumped back to a guest name
  for (const [p, n] of Object.entries(db.names)) if (p !== pid && usernameKey(n) === key) db.names[p] = "guest" + (1000 + rand(9000));
  db.names[pid] = name;
  save();
  return { name, account: true };
}

async function login(pid, { username, password }) {
  const key = usernameKey(username);
  if (loginLocked(key)) return { error: "Too many tries. Wait a minute and try again." };
  const acct = db.accounts[key];
  const check = await hashPassword(password, acct?.salt ?? "00000000000000000000000000000000");
  if (!acct || !crypto.timingSafeEqual(Buffer.from(check.hash, "hex"), Buffer.from(acct.hash, "hex"))) {
    noteFailedLogin(key);
    return { error: "Wrong username or password." };
  }
  failedLogins.delete(key);
  // bring this browser's guest scores along, unless it belongs to another account
  if (pid !== acct.pid && !accountOf(pid)) { leaveRoom(pid); mergePlayer(pid, acct.pid); }
  db.names[acct.pid] = acct.name;
  save();
  return { pid: acct.pid, name: acct.name, account: true };
}

// ---------------------------------------------------------------- SSE connections

const conns = new Map(); // pid -> Set<res>

function send(pid, event, data) {
  const set = conns.get(pid);
  if (!set) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) res.write(msg);
}

setInterval(() => { for (const set of conns.values()) for (const res of set) res.write(": ping\n\n"); }, 20000);

// ---------------------------------------------------------------- race rooms

const rooms = new Map();     // roomId -> room
const playerRoom = new Map(); // pid -> roomId

function newRoom(isPublic) {
  let code = null;
  if (!isPublic) {
    do code = Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[rand(32)]).join("");
    while ([...rooms.values()].some((r) => r.code === code));
  }
  const room = {
    id: crypto.randomUUID(), code, isPublic, state: "waiting", text: pick(PASSAGES),
    players: new Map(), createdAt: Date.now(), startAt: 0, endAt: 0, hostPid: null,
    finishCount: 0, round: 0, humansDoneAt: 0, dirty: true,
  };
  rooms.set(room.id, room);
  return room;
}

function makePlayer(pid, name, bot = false) {
  return { pid, pub: bot ? "bot-" + rand(1e9) : pubId(pid), name, bot, progress: 0, wpm: 0, acc: 100,
           finished: false, place: 0, finishMs: 0, flagged: false, botWpm: 0, left: false };
}

function humans(room) { return [...room.players.values()].filter((p) => !p.bot && !p.left); }

function roomView(room) {
  return {
    id: room.id, code: room.code, isPublic: room.isPublic, state: room.state, text: room.text, round: room.round,
    startAt: room.startAt, endAt: room.endAt, serverNow: Date.now(), limitMs: CFG.raceLimitMs,
    host: room.hostPid ? pubId(room.hostPid) : null,
    players: [...room.players.values()].filter((p) => !p.left || room.state !== "waiting").map((p) => ({
      id: p.pub, name: p.name, bot: p.bot, progress: p.progress, wpm: round1(p.wpm), acc: p.acc,
      finished: p.finished, place: p.place, left: p.left,
    })),
  };
}

function broadcast(room, event = "room", extra = {}) {
  const view = roomView(room);
  for (const p of room.players.values()) if (!p.bot && !p.left) send(p.pid, event, { ...view, you: p.pub, ...extra });
  room.dirty = false;
}

function leaveRoom(pid) {
  const roomId = playerRoom.get(pid);
  playerRoom.delete(pid);
  const room = rooms.get(roomId);
  if (!room) return;
  const p = room.players.get(pid);
  if (!p) return;
  if (room.state === "waiting" || room.state === "countdown") room.players.delete(pid);
  else p.left = true;
  if (room.hostPid === pid) room.hostPid = humans(room)[0]?.pid ?? null;
  if (humans(room).length === 0) rooms.delete(room.id);
  else room.dirty = true;
}

function joinRoom(room, pid) {
  leaveRoom(pid);
  room.players.set(pid, makePlayer(pid, nameOf(pid)));
  playerRoom.set(pid, room.id);
  room.hostPid ??= pid;
  room.dirty = true;
  broadcast(room);
}

function addBots(room, count) {
  const used = new Set([...room.players.values()].map((p) => p.name));
  for (let i = 0; i < count && room.players.size < CFG.roomMax; i++) {
    let name; do name = pick(BOT_NAMES); while (used.has(name)); used.add(name);
    const bot = makePlayer("bot" + rand(1e9), name, true);
    bot.botWpm = 35 + Math.random() * 75;
    room.players.set(bot.pid, bot);
  }
  room.dirty = true;
}

function startCountdown(room) {
  room.state = "countdown";
  room.startAt = Date.now() + CFG.countdownMs;
  room.dirty = true;
}

function finishRace(room) {
  room.state = "done";
  room.endAt = Date.now();
  const winner = [...room.players.values()].find((p) => p.place === 1);
  for (const p of room.players.values()) {
    if (p.bot || p.flagged || !p.finished) continue;
    const res = recordScore("race", p.pid, round1(p.wpm), p.acc, p === winner);
    send(p.pid, "raceResult", { wpm: round1(p.wpm), acc: p.acc, place: p.place, ...res });
  }
  broadcast(room);
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    const hs = humans(room);
    if (room.state === "waiting" && room.isPublic) {
      if (hs.length >= 2) startCountdown(room);
      else if (now - room.createdAt > CFG.fillBotsAfterMs) { addBots(room, 2 + rand(2)); startCountdown(room); }
    } else if (room.state === "countdown" && now >= room.startAt) {
      room.state = "racing"; room.dirty = true;
    } else if (room.state === "racing") {
      const elapsedMin = (now - room.startAt) / 60000;
      for (const p of room.players.values()) {
        if (p.finished) continue;
        if (p.bot) {
          const jitter = 0.75 + Math.random() * 0.5;
          p.progress = Math.min(room.text.length, p.progress + (p.botWpm * 5 / 60) * 0.25 * jitter);
          p.wpm = (p.progress / 5) / Math.max(elapsedMin, 1 / 60);
          p.acc = 92 + rand(8);
          if (p.progress >= room.text.length) finishPlayer(room, p, now);
          room.dirty = true;
        }
      }
      const active = [...room.players.values()].filter((p) => !p.left);
      const humansDone = humans(room).every((p) => p.finished);
      if (humansDone) room.humansDoneAt ||= now;
      // end when everyone is in, the humans have been done for 4s (don't wait on slow bots), or time is up
      if (active.every((p) => p.finished) || (humansDone && now - room.humansDoneAt > 4000) ||
          now - room.startAt > CFG.raceLimitMs) finishRace(room);
    } else if (room.state === "done" && now - room.endAt > CFG.doneLingerMs) {
      for (const p of hs) playerRoom.delete(p.pid);
      rooms.delete(room.id);
      continue;
    }
    if (room.dirty) broadcast(room);
  }
  for (const [id, t] of tests) if (now - t.issuedAt > CFG.testTtlMs) tests.delete(id);
}
setInterval(tick, 250);

function finishPlayer(room, p, now) {
  p.finished = true;
  p.progress = room.text.length;
  p.finishMs = now - room.startAt;
  p.wpm = (room.text.length / 5) / (p.finishMs / 60000);
  p.place = ++room.finishCount;
}

function handleProgress(pid, { progress, acc }) {
  const room = rooms.get(playerRoom.get(pid));
  if (!room || room.state !== "racing") return { ok: false };
  const p = room.players.get(pid);
  if (!p || p.finished || p.left) return { ok: false };
  const now = Date.now();
  const elapsedMin = Math.max((now - room.startAt) / 60000, 1 / 600);
  let prog = Math.max(0, Math.min(room.text.length, Math.floor(Number(progress) || 0)));
  // anti-cheat: progress can't outrun the average WPM cap (+ a little slack for the first word)
  const allowed = CFG.maxAvgWpm * 5 * elapsedMin + 12;
  if (prog > allowed) { p.flagged = true; prog = Math.floor(allowed); }
  p.progress = prog;
  p.acc = Math.max(0, Math.min(100, Math.round(Number(acc) || 0)));
  p.wpm = (prog / 5) / elapsedMin;
  if (prog >= room.text.length) finishPlayer(room, p, now);
  room.dirty = true;
  return { ok: true };
}

// ---------------------------------------------------------------- solo tests

const tests = new Map(); // testId -> { pid, duration, words, issuedAt }

// The daily challenge: one passage per UTC day, the same for everyone.
const DAILY_EPOCH = Date.UTC(2026, 9, 18);
function dailyInfo() {
  const n = Math.floor((Date.now() - DAILY_EPOCH) / 864e5);
  return { no: n + 1, text: PASSAGES[((n * 7) % PASSAGES.length + PASSAGES.length) % PASSAGES.length] };
}

function startSolo(pid, { duration, mode, focus }) {
  const testId = crypto.randomUUID();
  if (mode === "daily") {
    const { no, text } = dailyInfo();
    tests.set(testId, { pid, mode, duration: 0, words: text.split(" "), issuedAt: Date.now() });
    return { testId, mode, no, words: text.split(" "), done: !!dailyBoard("daily")[pid] };
  }
  duration = Number(duration);
  if (!CFG.soloDurations.includes(duration)) duration = 30;
  // drills lean on the letters a player keeps missing
  const letters = mode === "drill" ? String(focus ?? "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 6) : "";
  const pool = letters ? WORDS.filter((w) => [...letters].some((c) => w.includes(c))) : [];
  const words = [];
  while (words.length < CFG.soloWordCount) {
    const w = pool.length && Math.random() < 0.75 ? pick(pool) : pick(WORDS);
    if (w !== words[words.length - 1]) words.push(w);
  }
  tests.set(testId, { pid, mode: letters ? "drill" : "time", duration, words, issuedAt: Date.now() });
  return { testId, mode: letters ? "drill" : "time", duration, words };
}

function finishDaily(pid, t, typed, acc, elapsedMs) {
  const text = t.words.join(" ");
  if (typed.join(" ") !== text) return { error: "passage not finished" };
  elapsedMs = Number(elapsedMs);
  if (!(elapsedMs >= 1000) || elapsedMs > Date.now() - t.issuedAt + 500) return { error: "bad time" };
  const wpm = round1(text.length / 5 / (elapsedMs / 60000));
  const accuracy = Math.max(0, Math.min(100, Math.round(Number(acc) || 0)));
  const first = !dailyBoard("daily")[pid];
  const ranked = first && wpm <= CFG.maxAvgWpm;
  const res = ranked ? recordScore("daily", pid, wpm, accuracy) : { pb: false, rankDaily: rankOf(dailyBoard("daily"), pid), rankAll: null };
  return { wpm, acc: accuracy, seconds: round1(elapsedMs / 1000), board: "daily", ranked, first, no: dailyInfo().no, ...res };
}

// Scores the typed words against the issued ones (monkeytype-style: only fully
// correct words and the spaces after them count toward WPM).
function finishSolo(pid, { testId, typed, acc, elapsedMs }) {
  const t = tests.get(testId);
  if (!t || t.pid !== pid) return { error: "unknown test" };
  tests.delete(testId);
  if (!Array.isArray(typed) || typed.length > t.words.length) return { error: "bad input" };
  if (t.mode === "daily") return finishDaily(pid, t, typed.map(String), acc, elapsedMs);
  if (Date.now() - t.issuedAt < t.duration * 1000 - 500) return { error: "too fast" };
  let correct = 0, raw = 0;
  typed.forEach((w, i) => {
    w = String(w).slice(0, 40);
    const last = i === typed.length - 1;
    raw += w.length + (last ? 0 : 1);
    if (w === t.words[i]) correct += w.length + (last ? 0 : 1);
    else if (last && t.words[i].startsWith(w)) correct += w.length;
  });
  const mins = t.duration / 60;
  const wpm = round1(correct / 5 / mins);
  const rawWpm = round1(raw / 5 / mins);
  const accuracy = Math.max(0, Math.min(100, Math.round(Number(acc) || 0)));
  const board = "solo" + t.duration;
  const ranked = t.mode === "time" && wpm > 0 && wpm <= CFG.maxAvgWpm;
  const res = ranked ? recordScore(board, pid, wpm, accuracy) : { pb: false, rankDaily: null, rankAll: null };
  return { wpm, rawWpm, acc: accuracy, board, ranked, ...res };
}

// ---------------------------------------------------------------- leaderboard

function leaderboard(board, period, pid) {
  if (!BOARDS.includes(board)) board = "solo30";
  if (board === "daily") period = "daily";   // the challenge resets every day
  const map = period === "all" ? db.all[board] : (db.daily[today()]?.[board] ?? {});
  const sorted = sortEntries(map);
  const row = ([p, e], i) => ({ rank: i + 1, name: nameOf(p), wpm: e.wpm, acc: e.acc, at: e.at,
                                races: e.races, wins: e.wins, you: p === pid });
  const top = sorted.slice(0, 50).map(row);
  const youIdx = sorted.findIndex(([p]) => p === pid);
  return { board, period, top, dailyNo: dailyInfo().no, you: youIdx >= 50 ? row(sorted[youIdx], youIdx) : null, total: sorted.length };
}

// ---------------------------------------------------------------- http

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
               ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 64 * 1024) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
  });
}

async function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    const data = await readFile(path.join(PUBLIC_DIR, "index.html")); // SPA fallback (e.g. /r/CODE)
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(data);
  }
}

const routes = {
  "POST /api/hello": (pid, b) => {
    const acct = accountOf(pid);
    if (acct) return { name: acct.name, id: pubId(pid), account: true };
    const want = cleanName(b.name), owner = db.accounts[usernameKey(want)];
    const taken = owner && owner.pid !== pid;
    if (!taken) db.names[pid] = want;
    else db.names[pid] ??= "guest" + (1000 + rand(9000));
    save();
    return { name: db.names[pid], id: pubId(pid), account: false, ...(taken ? { error: "That name belongs to an account. Sign in to use it." } : {}) };
  },
  "POST /api/signup": (pid, b) => signup(pid, b),
  "POST /api/login": (pid, b) => login(pid, b),
  "POST /api/solo/start": (pid, b) => startSolo(pid, b),
  "POST /api/solo/finish": (pid, b) => finishSolo(pid, b),
  "POST /api/race/quick": (pid) => {
    const room = [...rooms.values()].find((r) => r.isPublic && r.players.size < CFG.roomMax &&
      (r.state === "waiting" || (r.state === "countdown" && r.startAt - Date.now() > 2000)));
    joinRoom(room ?? newRoom(true), pid);
    return { ok: true };
  },
  "POST /api/race/create": (pid) => { joinRoom(newRoom(false), pid); return { ok: true }; },
  "POST /api/race/join": (pid, b) => {
    const code = String(b.code ?? "").toUpperCase().trim();
    const room = [...rooms.values()].find((r) => r.code === code);
    if (!room) return { error: "room not found" };
    if (room.state !== "waiting" && room.state !== "done") return { error: "race already started" };
    if (room.state === "done") resetRoom(room);
    if (room.players.size >= CFG.roomMax && !room.players.has(pid)) return { error: "room is full" };
    joinRoom(room, pid);
    return { ok: true };
  },
  "POST /api/race/start": (pid, b) => {
    const room = rooms.get(playerRoom.get(pid));
    if (!room || room.isPublic || room.hostPid !== pid || room.state !== "waiting") return { error: "can't start" };
    if (b.bots) addBots(room, Math.min(Number(b.bots) || 0, CFG.roomMax - room.players.size));
    startCountdown(room);
    return { ok: true };
  },
  "POST /api/race/again": (pid) => {
    const room = rooms.get(playerRoom.get(pid));
    if (room && !room.isPublic) {   // private rooms stay together
      if (room.state === "done") resetRoom(room);
      else return { ok: true };
      broadcast(room);
      return { ok: true };
    }
    return routes["POST /api/race/quick"](pid);
  },
  "POST /api/race/progress": (pid, b) => handleProgress(pid, b),
  "POST /api/race/leave": (pid) => { leaveRoom(pid); return { ok: true }; },
};

function resetRoom(room) {
  room.round++; room.state = "waiting"; room.text = pick(PASSAGES); room.finishCount = 0; room.startAt = 0; room.endAt = 0; room.humansDoneAt = 0;
  for (const [pid, p] of room.players) {
    if (p.bot || p.left) { room.players.delete(pid); continue; }
    room.players.set(pid, makePlayer(pid, nameOf(pid)));
  }
  room.dirty = true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/events") {
      const pid = url.searchParams.get("pid");
      if (!validPid(pid)) return json(res, 400, { error: "bad pid" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 2000\n\n");
      if (!conns.has(pid)) conns.set(pid, new Set());
      conns.get(pid).add(res);
      const room = rooms.get(playerRoom.get(pid));
      if (room) send(pid, "room", { ...roomView(room), you: pubId(pid) });
      req.on("close", () => {
        const set = conns.get(pid);
        set?.delete(res);
        if (set?.size === 0) {
          conns.delete(pid);
          // give a reconnecting tab a moment before dropping them from their room
          setTimeout(() => { if (!conns.has(pid)) leaveRoom(pid); }, 5000);
        }
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      return json(res, 200, leaderboard(url.searchParams.get("board"), url.searchParams.get("period"), url.searchParams.get("pid")));
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      return json(res, 200, { online: conns.size, racing: [...rooms.values()].filter((r) => r.state === "racing").length });
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: "bad request" }); }
      if (!validPid(body.pid)) return json(res, 400, { error: "bad pid" });
      const out = await route(body.pid, body);
      return json(res, out?.error ? 400 : 200, out);
    }
    if (req.method === "GET") return serveStatic(req, res, decodeURIComponent(url.pathname));
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => console.log(`michtype running on http://localhost:${PORT}`));
