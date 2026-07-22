# Unstrung

**Cut words out of one long strand of letters — every cut splices in fresh thread, and a word that spans the seam scores triple.**

🎮 Play: https://unstrung.benrichardson.dev

## What it is

You are given a single strand of letters — one unbroken run, wrapped across the screen like a line of
text. Find a **contiguous** stretch that reads as a word and cut it out. Fresh thread is immediately
spliced into the gap, and the two joins where old thread meets new are **seams**. They are visible,
they are permanent, and they are the whole game:

> **A word that spans a seam scores triple.**

That single rule turns cutting from harvesting into *manufacturing*. You are not just taking points,
you are choosing what the strand can spell next — and the seam you leave behind is the one your
opponent gets to use. Taking the small word instead of the big one, so the join lands somewhere they
cannot reach, is a real decision that exists from the first move.

It also means the game gets bigger as it goes, with no extra machinery: your first cut has no seams to
bridge and scores base value, while a cut ten moves later sits in a strand riddled with them. An early
lead banks very little, and the last few cuts are where a round is actually decided.

The fresh thread is always a short word, so there is *always* something to play — but that free move
is the cheap one. The points are in the bridges you build.

Everyone gets the same number of cuts. Highest total wins. Solo, against the machine, or with up to
three friends over a shared link.

## How to play

- **Drag** across a run of touching letters that spells a word — or **tap the first letter, then the
  last**. A word chip shows what you have, what it is worth, and whether it bridges a seam.
- **Desktop:** click-drag or click-then-click. Arrow keys move a cursor, `Shift+Arrow` extends the
  selection, `Enter` cuts, `Esc` clears — the game is fully playable from the keyboard.
- A word scores its **length squared**, tripled if it spans a seam. Nothing under the mode's minimum
  and nothing over the blade's reach.
- The round ends when everyone has spent their cuts. The results screen shows every player's words,
  and the **best line the solver could find on your exact strand** — what you left on the table.

### Modes

| Mode | What changes |
|---|---|
| **Strand** | One strand of 26, three letters and up. The baseline. |
| **Deepcut** | A longer strand, and **nothing under four letters counts** — no filler, so you cut to *place* a seam you can reach with a real word. |
| **Twinfold** | **Two** independent strands. You are never stuck, only ever choosing which one to spend — and a rich strand you leave alive is a gift you cannot take back. |

## Multiplayer

Live **peer-to-peer** for 2–4 players, plus an async seed-share (a link that deals a friend the exact
same strand) and a daily strand on a worldwide UTC seed.

Three ways into a room: **scan the QR**, open the invite link, or type the four-character code.

There is **no game server**. The netcode is *lockstep*: after the deal there is zero randomness and
zero hidden information — the strand, the spool and every refill word are pure functions of the seed —
so peers exchange only `{round, ply, strand, index, length}` and **no board state ever crosses the
wire**. A public signalling relay is used once, to introduce the two browsers to each other.

Because every peer derives the board the same way, the host owns exactly one thing: the turn clock.
If the host leaves, the promoted peer picks it up and the round carries on to a result.

## Tech

- Vite 6 + vanilla TypeScript
- DOM rendering (a tile game made of letters: crisp type at any DPR, real 44px targets, free reflow)
- Shared engine ([`@ben-gy/game-engine`](https://github.com/ben-gy/gh-game-engine)): P2P netcode,
  multi-round sessions, lobby + join QR, deterministic RNG, procedural audio, mobile hardening
- Vitest: 308 tests, including a balance simulation, a mechanism audit, a contrast gate and the full
  P2P contract suite
- GitHub Pages hosting

The word list is **curated, not a tournament dictionary** — leniency scales with length, so obscure
three-letter words do not count and real long words do. See `scripts/gen-dictionary.mjs`.

No cookies, no fingerprinting, no third-party fonts, no accounts. Anonymous, cookie-less page-view
counts via Cloudflare Web Analytics.

## Local dev

```bash
npm install
npm run dev
npm test
npm run build
npm run preview
```

`npm run gen:dict` rebuilds the word lists; `npm run gen:icons` rebuilds the home-screen icons.

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
