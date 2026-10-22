# michtype

A fast, minimal multiplayer typing game.

- Timed tests (15/30/60s), with a hollow ghost caret that replays your best run as you type.
- Daily challenge: one passage per day for everyone. Your first finished run is ranked, and you
  can copy a result to share.
- Missed-key map after every test, plus a practice mode built from your most-missed keys.
- Live races against other people (bots fill empty seats) and private rooms with invite links.
- Daily and all-time leaderboards.
- Optional accounts (username + password, hashed with scrypt). Guests can play without one;
  signing up or in keeps the scores they already set.

## Run

```bash
npm start            # http://localhost:3000  (PORT=4317 npm start to change)
npm run dev          # restarts on server changes
```

No dependencies — just Node 20+.

## How it fits together

- `server/server.js` — static files, the JSON API, live race rooms pushed over Server-Sent
  Events, solo test scoring, leaderboards (saved to `data/db.json`).
- `server/texts.js` — word pool for solo tests, race passages, bot names.
- `public/` — the client (`index.html`, `style.css`, `app.js`). `TypingBox` in `app.js` is the
  typing engine; races use it in strict mode (a wrong word must be fixed before moving on).

## Anti-cheat

- Solo scores are recomputed on the server from the typed words against the words it issued,
  and can't be submitted before the test's time has passed.
- Race progress is capped by elapsed time at 300 WPM; anyone over is flagged and their result
  is not recorded.
- Player ids stay private; other clients only see a hashed id.

## Testing races alone

Open `/race?guest` in a second tab — it gets its own identity, so the two tabs can race each other.
