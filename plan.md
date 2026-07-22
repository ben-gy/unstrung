# Game Plan: Unstrung

## Overview
- **Name:** Unstrung
- **Repo name:** unstrung
- **Tagline:** Cut words out of one long strand of letters — and every cut splices the ends together, so the words you make next were never there before.
- **Genre (directory category):** word

## Core Loop
You are given a single strand of letters — one unbroken run, e.g. `PLANTERMSHAPEDGE…`. Find a
**contiguous** stretch that reads as a word, cut it out, and the letters on either side of the gap
**splice together**. That join is a **seam**, and it is permanent and visible.

The signature rule, one sentence: **a word that spans a seam scores double.**

That single rule is the whole game:
- Cutting is not just harvesting, it is *manufacturing*. `PLANTERMS` → cut `ANTE` → `PL|RMS`, and the
  seam between `L` and `R` is a brand-new adjacency that did not exist in the deal.
- It makes the game get **bigger as it goes**, with zero new state: early cuts have no seams to span
  and score base value; late cuts sit in a strand riddled with seams and score double. An early lead
  banks very little (principle #18's "make the early game small and the late game big"), which is
  also exactly what cancels the first-mover edge in versus.
- It makes a *small* word a real option. Taking `ANT` instead of `ANTE` leaves a different letter
  against the seam, and therefore a different set of future words. You are choosing what the board
  becomes, not just what you score now.

**Solo (the default, instant):** score attack on a seeded strand. Cut until you cannot find anything,
then end the run. The results screen shows the **best line the solver found on your exact strand** —
the words, in order, that you left on the table.

**Versus (live P2P 2–4, or vs bots):** everyone plays **one shared strand**, alternating cuts. There
is no hidden information and no randomness after the deal, so denial is the game: the fat word you
take is a seam you hand them. Highest total when nobody can move.

**Win condition:** solo — beat your best / close the gap to the solver's line. Versus — highest score
when the strand is exhausted (no player can make a legal cut on their turn; a player with no move
passes, and the round ends when everyone passes in succession).

**Lose condition:** there isn't one — a run always ends in a score. The tension is the shrinking
strand and the fact that every cut is also a gift.

## Controls
- **Desktop:** click the first letter then the last letter of your word (or click-drag across them);
  `Enter` to cut, `Esc` to clear. Arrow keys move a cursor, `Shift+Arrow` extends the selection —
  so the game is fully keyboard-playable.
- **Mobile:** drag a finger across the letters (Pointer Events, `setPointerCapture`, per-pointerId
  state, `pointercancel` treated as an abort). Tap-first-then-tap-last also works, so a one-handed
  tap is never worse than a drag. **No D-pad and no joystick** — this is a board/tile game, so per
  principle #19 the control is `@ben-gy/game-engine/drag`'s classifier semantics over the tile row.
  Tiles are ≥44px hit targets (the visible tile may be smaller than its hit box). The strand *wraps*
  into rows like text, so a 30-letter strand fits a 375px phone at full tile size.

## Multiplayer
- **Mode:** live P2P **plus** async-seed (daily strand + share links carrying seed+mode) **plus**
  solo-vs-bots. Solo is the default and needs nothing.
- **If live P2P — shape:** **versus.** Justification, honestly: the strand is a single shrinking
  shared resource and *what you leave behind* is the entire strategic content — "I take the small
  word so the seam lands where you can't use it" is a decision that only exists because someone else
  wants the strand too. Co-op on one strand collapses to alternating solitaire: with a shared score
  there is no reason not to always take the biggest word, and the one strong player would simply call
  every move (the exact "one player solos it while the other watches" failure the plan template warns
  about). A *co-op* shape does exist for this mechanic — a shared target score against a turn clock,
  with each diver's hand of allowed opening letters differing — and it is logged in
  `EXPANSION_IDEAS.md` rather than half-built here. Shared-world doesn't apply: two people editing one
  strand non-competitively is just one person editing a strand.
- **Players:** 2–4. **Topology: LOCKSTEP, not a snapshot star.** After the deal there is zero
  randomness and zero hidden information, so every peer runs the identical pure reducer over the
  identical move list. Peers exchange only `{ round, ply, strand#, start, len }` — **no board state
  ever crosses the wire**, so the classic desync surface does not exist.
  - **Channels (≤12 bytes):** `cut` (a move), `pass` (no legal move / clock expiry), `sync` (host's
    move-list digest + turn clock, 1Hz, for late joiners and drift detection).
  - **Room entry — all three ways in:** the stock `createRoomEntry` + `createLobby` give **scan the
    QR / open the link / type the code**. The QR toggle is the engine's and is not removed. The room
    code is also shown on the results screen via `qrPanelHtml()` so a third player can be pulled in
    between rounds without going back to the lobby.
  - **Late joiner:** not seated (rematch's `seated:false`) → spectator view that replays the move list
    from the host's `sync` digest, plus "you're in the next one" with the ready toggle live.
  - **If the host leaves:** the *only* host-authoritative thing is the **turn clock** (and the pass
    it broadcasts on expiry). Every peer already holds a byte-identical board, because it derived it
    from the same move list. `onHostChange` → the promoted peer starts the clock interval from the
    current ply and keeps adjudicating timeouts, so the round keeps running and can still finish.
    Proven by `tests/takeover.test.ts` and by the two-tab smoke test.
- **End of round → rematch.** `createRounds` from `@ben-gy/game-engine/rematch`; the Net is created
  **once** per session and never left for a rematch. "Play again" is a vote plus a new round number;
  the host broadcasts a new seed and the frozen roster. While waiting, each peer sees who has voted
  and a **visible countdown** (`state().startsInMs`); the host can force-start. A player who declines
  or closes the tab is dropped from the roster and the round starts without them — no deadlock. If
  the **host** leaves on the results screen the promoted peer can run the rematch (it inherits no
  tally; the match tally is kept per-peer from the rounds it saw and is labelled as such). A running
  **match tally** persists across rounds. "Back to lobby" does **not** leave the room.

## Juice Plan
- **The cut**: selected tiles flash white, lift, and burst into particles; the strand then *slides
  closed* with a 220ms eased transform (FLIP), with a `setTimeout` backstop releasing the transform so
  a backgrounded tab can never strand a tile mid-slide (a real shipped bug in this fleet).
- **The seam** lands with a sparkle and a permanent zigzag notch between the two tiles; a word that
  spans a seam plays a distinct rising chime and the score pop reads **×2** in the seam colour.
- **Sound** (`@ben-gy/game-engine/sound`): `select` per letter added (pitch rises with selection
  length), `blip` on de-select, `coin` on a plain cut, `powerup` on a seam cut, `hit` on an invalid
  word, `win`/`lose` at the end, `blip`×3 + `select` for the 3-2-1-GO countdown. `sfx.unlock()` on
  first gesture; mute persisted.
- **Screen shake** on any cut worth ≥40, scaled by value, disabled under `prefers-reduced-motion`.
- **Score pops** rise and fade from the cut; a combo-ish "seam streak" counter in the HUD.
- **Tweens** everywhere: tile insert/remove, HUD number roll-up, turn banner slide.
- Palette: warm parchment/ink on a deep slate, with the seam colour carrying the only saturated hue.

## Style Direction
**Vibe:** clean-minimal with a printed/letterpress feel — this is a word game, so type is the art.
**Palette:** deep slate ground (`#151a21`), warm bone tiles (`#e8e2d4`) with ink glyphs (`#14181d`),
a single saturated **seam amber** (`#f0a92e`) and a **cut teal** (`#3fc4b0`) for selection. Amber and
teal are distinguishable under deuteranopia/protanopia *and* differ in luminance, and every meaningful
state also carries a **shape** cue (seam = notch, selection = raised outline, used = flat), so nothing
is carried by colour alone. All held to ≥3:1 by `tests/contrast.test.ts`.
**Theme:** dark.
**Reference feel:** the calm of a well-set crossword grid, the snap of a good tile game.

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite.
- **Render:** **DOM/CSS.** It is a tile/word game — crisp text at any DPR, trivial responsive wrap,
  real hit targets, accessible by default, and no canvas layout traps.
- **Engine modules used (imported, never copied):** `net`, `rematch`, `turn`, `lobby`, `qr` (via
  lobby), `rng`, `sound`, `storage`, `mobile` + `mobile.css`, `identity`, `feedback` (copied per the
  factory rule, as it is a generated file).
- **Persistence:** `storage.ts` — mute, high scores per mode, daily-strand results, how-to-play seen.

### Modules
- `src/dict.ts` — the curated dictionary (length-scaled SCOWL bands), a `Set` + max word length.
- `src/strand.ts` — deterministic strand generation from a seed (overlapping common words), plus the
  reject/reroll quality gate.
- `src/game.ts` — the pure reducer: `legalCuts`, `applyCut`, `scoreOf`, seam bookkeeping, pass/end.
- `src/solver.ts` — bounded best-line search (memoised DFS + node budget) for the par benchmark and
  the bot's lookahead.
- `src/bot.ts` — 3 strengths, deterministic.
- `src/modes.ts` — the three modes.
- `src/render.ts`, `src/select.ts` (pointer/keyboard selection), `src/ui.ts`, `src/net-game.ts`,
  `src/countdown.ts`, `src/palette.ts`, `src/main.ts`.

### Modes (genuine spread — principle #14)
| Mode | Strands | Letters | Min word | What changes about how it plays |
|---|---|---|---|---|
| **Strand** | 1 | 26 | 3 | The baseline. Short words are live, so the strand stays workable to the end. |
| **Deepcut** | 1 | 32 | **4** | No filler. Three-letter escapes are illegal, so you must build *structure*: you cut to place a seam you can reach with a real word, and a position can genuinely dry up. |
| **Twinfold** | **2** | 16 + 16 | 3 | Two independent strands. You are never blocked, so the game becomes *which strand to spend* — and in versus, leaving a rich strand alive is a gift you can't take back. |
The host's pick travels frozen inside the round start via `roundOpts()`; guests render
`state().hostOpts`, never their own. Unknown ids off the wire fall back via `modeOf()`.

## Non-Goals
- No ring/wrapping strand geometry (logged as an expansion), no letter tray or rack, no timer in solo,
  no public noticeboard/matchmaking this run, no chat.

## How To Play (player-facing copy)
> The strand is one long run of letters. Drag across a **run of touching letters** that spells a word,
> and cut it out.
> The letters on either side then **splice together** — that join is a **seam**, and it stays.
> **A word that spans a seam scores double.** So every cut builds the board you'll play next.
> Longer is better (a word scores its length, squared). Cut until nothing's left to find.
