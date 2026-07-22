/**
 * mechanism.test.ts — audit the RULES, not the outcome (principle #21).
 *
 * A balance sim measures how a round turned out, and a broken mechanic just
 * shifts that distribution — which is indistinguishable from intended
 * difficulty. Scrapwall's turrets could not shoot half the horde and its 200-run
 * seeded sim was perfectly green, because "the guns are half dead" reads as
 * "wave 7 is hard".
 *
 * So this file audits the event stream — every cut the sim actually made — at
 * ZERO TOLERANCE, against invariants re-derived here from INDEPENDENT constants.
 *
 * That independence is the whole thing, and it is easy to get wrong. Boxbox's
 * first mechanism audit imported the game's own `penaltyFor` and compared the
 * game's arithmetic to itself: a tautology that stayed green when the penalty
 * formula was mutated. So this file must NOT import `scoreOf`, `spansSeam`,
 * `spliceStrand`, `refillWord` or `SEAM_MULT`. It restates the rules — length
 * squared, tripled across a seam, fresh thread spliced in at the cut — from the
 * rulebook, and checks the game against them. If the game's formula is mutated,
 * these go red; that is mutation-verified in `npm test` notes and in the PR.
 */

import { describe, expect, it } from 'vitest';
import { playMatch, cfgOf, type MatchResult } from './helpers/sim';
import { allModes, turnsFor } from '../src/modes';
import { WORDS } from '../src/dict';
import { createGame, applyCut } from '../src/game';
import { dealStrands } from '../src/strand';
import type { Strength } from '../src/bot';

// ── the rulebook, restated. NOT imported from the game. ────────────────────

/** A word scores its length squared. */
const BASE = (len: number): number => len * len;
/** Bridging a seam triples it. */
const SEAM_FACTOR = 3;

interface Violation {
  kind: string;
  detail: string;
}

/**
 * Replay a finished match from the DEAL, tracking the strand independently, and
 * audit every cut against the restated rules.
 *
 * The strand model here is built from the rulebook rather than from
 * `spliceStrand`: letters are removed, fresh thread of the same length goes into
 * the gap, and the two boundaries between old and new thread are seams.
 */
function audit(r: MatchResult, seed: number): Violation[] {
  const v: Violation[] = [];
  const { cfg } = r;
  const players = r.scores.length;
  const woven = dealStrands({
    seed,
    letters: cfg.letters,
    minLen: cfg.minLen,
    maxLen: cfg.maxLen,
    turnsEach: cfg.turnsEach,
    players,
  });

  // Independent board: letters, and a parallel set of seam positions.
  const letters = woven.strands.map((s) => [...s]);
  const seams = woven.strands.map(() => new Set<number>());
  const scores = new Array(players).fill(0);
  const cutsTaken = new Array(players).fill(0);
  let seamCuts = 0;

  // The fresh thread that ACTUALLY arrived is read off the game's own board after
  // the cut — the audit checks the rules the thread must obey (right length, no
  // seam inside it, joins on both sides), not which word the game chose.
  let live = createGame({
    strands: woven.strands,
    spools: woven.spools,
    refillSeed: seed,
    turnsEach: cfg.turnsEach,
    minLen: cfg.minLen,
    maxLen: cfg.maxLen,
    players,
  });

  r.history.forEach((h, idx) => {
    const L = letters[h.s];

    // 1. The move must be in range, legal by length, and an actual word.
    if (h.i < 0 || h.i + h.len > L.length) {
      v.push({ kind: 'out-of-range', detail: `ply ${idx}: ${h.i}+${h.len} of ${L.length}` });
      return;
    }
    if (h.len < cfg.minLen || h.len > cfg.maxLen) {
      v.push({ kind: 'illegal-length', detail: `ply ${idx}: len ${h.len}` });
    }
    const word = L.slice(h.i, h.i + h.len).join('');
    if (word !== h.word) {
      v.push({ kind: 'word-mismatch', detail: `ply ${idx}: board says ${word}, game says ${h.word}` });
    }
    if (!WORDS.has(word)) {
      v.push({ kind: 'not-a-word', detail: `ply ${idx}: ${word}` });
    }

    // 2. Whose turn it was. Seats cycle; nobody may exceed their allowance.
    if (h.player !== idx % players) {
      v.push({ kind: 'out-of-turn', detail: `ply ${idx}: seat ${h.player}, expected ${idx % players}` });
    }
    cutsTaken[h.player]++;
    if (cutsTaken[h.player] > cfg.turnsEach) {
      v.push({ kind: 'over-allowance', detail: `seat ${h.player} took ${cutsTaken[h.player]}` });
    }

    // 3. THE SIGNATURE RULE. A seam strictly inside the word triples the score;
    //    a seam at the word's left edge does not (you must bridge it, not butt
    //    against it). Derived from this file's own seam set.
    let bridged = false;
    for (let k = h.i + 1; k < h.i + h.len; k++) if (seams[h.s].has(k)) bridged = true;
    if (bridged !== h.spannedSeam) {
      v.push({ kind: 'seam-misreported', detail: `ply ${idx}: audit ${bridged}, game ${h.spannedSeam}` });
    }
    if (bridged) seamCuts++;

    const expected = BASE(h.len) * (bridged ? SEAM_FACTOR : 1);
    if (expected !== h.value) {
      v.push({ kind: 'wrong-score', detail: `ply ${idx}: expected ${expected}, got ${h.value}` });
    }
    scores[h.player] += expected;

    // 4. Advance the independent board, then check the game's board agrees.
    const after = applyCut(live, { s: h.s, i: h.i, len: h.len }, h.player).state;
    const fresh = after.strands[h.s].letters.slice(h.i, h.i + h.len);
    if (fresh.length !== h.len) {
      v.push({ kind: 'refill-length', detail: `ply ${idx}: ${fresh.length} letters for a ${h.len} cut` });
    }
    // The fresh thread must never carry a seam INSIDE it — that is what keeps the
    // guaranteed free move worth base value, which is the entire reason the
    // refill is a short word rather than a long one.
    for (let k = h.i + 1; k < h.i + fresh.length; k++) {
      if (after.strands[h.s].seam[k]) {
        v.push({ kind: 'seam-inside-fresh-thread', detail: `ply ${idx} at ${k}` });
      }
    }

    const left = L.slice(0, h.i);
    const right = L.slice(h.i + h.len);
    const nextSeams = new Set<number>();
    for (const k of seams[h.s]) {
      if (k < h.i) nextSeams.add(k);
      else if (k >= h.i + h.len) nextSeams.add(k); // index is unchanged: same length in, same out
    }
    // A join wherever old thread meets new.
    if (left.length) nextSeams.add(h.i);
    if (right.length) nextSeams.add(h.i + fresh.length);
    nextSeams.delete(0);
    letters[h.s] = [...left, ...fresh, ...right];
    seams[h.s] = nextSeams;

    const gameSeams = new Set(
      after.strands[h.s].seam.map((b, k) => (b ? k : -1)).filter((k) => k >= 0),
    );
    if (gameSeams.size !== nextSeams.size || [...nextSeams].some((k) => !gameSeams.has(k))) {
      v.push({
        kind: 'seam-set-diverged',
        detail: `ply ${idx}: audit [${[...nextSeams].sort((a, b) => a - b)}] vs game [${[...gameSeams].sort((a, b) => a - b)}]`,
      });
    }
    if (letters[h.s].join('') !== after.strands[h.s].letters.join('')) {
      v.push({ kind: 'board-diverged', detail: `ply ${idx}` });
    }

    live = after;
  });

  // 5. The ledger closes.
  r.scores.forEach((s, i) => {
    if (s !== scores[i]) v.push({ kind: 'score-ledger', detail: `seat ${i}: game ${s}, audit ${scores[i]}` });
  });

  return v;
}

const MATRIX: Array<{ modeId: string; seats: number }> = [];
for (const mode of allModes()) for (const seats of [2, 3, 4]) MATRIX.push({ modeId: mode.id, seats });

describe('mechanism: every cut obeys the rulebook', () => {
  for (const { modeId, seats } of MATRIX) {
    it(`${modeId}, ${seats} players: zero violations across 40 seeded matches`, () => {
      const mode = allModes().find((m) => m.id === modeId)!;
      const cfg = { ...cfgOf(modeId), turnsEach: turnsFor(mode, seats) };
      const all: Violation[] = [];
      for (let k = 0; k < 40; k++) {
        const seed = 7919 * k + 13;
        const r = playMatch({ cfg, seed, policies: new Array(seats).fill('fair') as Strength[] });
        all.push(...audit(r, seed));
      }
      // Zero tolerance, and a COUNT of rule violations rather than an average or
      // a duration — a duration metric for exactly this kind of bug moved only
      // 0.17s -> 0.38s between broken and fixed code in a sibling game, i.e. it
      // would have shipped it.
      expect(all.slice(0, 5).map((x) => `${x.kind}: ${x.detail}`)).toEqual([]);
      expect(all.length).toBe(0);
    });
  }
});

describe('mechanism: the seam rule actually fires', () => {
  /**
   * The assertion that would have caught sporeline's dead signature mechanic and
   * this game's own empty-string refill bug (the "guaranteed short word" was ''
   * for two hours, because the source list started at four letters — the board
   * dried out and every OUTCOME metric merely looked like a hard game).
   */
  for (const { modeId, seats } of MATRIX) {
    it(`${modeId}, ${seats} players: seam-bridging cuts happen, and pay triple`, () => {
      const mode = allModes().find((m) => m.id === modeId)!;
      const cfg = { ...cfgOf(modeId), turnsEach: turnsFor(mode, seats) };
      let bridged = 0;
      let total = 0;
      for (let k = 0; k < 40; k++) {
        const r = playMatch({ cfg, seed: 104_729 * k + 7, policies: new Array(seats).fill('fair') as Strength[] });
        for (const h of r.history) {
          total++;
          if (h.spannedSeam) {
            bridged++;
            expect(h.value, `${h.word} bridged a seam`).toBe(BASE(h.len) * SEAM_FACTOR);
          } else {
            expect(h.value, `${h.word} did not bridge`).toBe(BASE(h.len));
          }
        }
      }
      expect(total).toBeGreaterThan(100);
      expect(bridged, 'no cut in the whole matrix ever bridged a seam').toBeGreaterThan(0);
    });
  }
});

describe('mechanism: the board can never dry out', () => {
  /**
   * Structural, so zero tolerance. The refill splices in a whole word of exactly
   * `minLen`, so a legal cut provably exists after every cut — and if that ever
   * stops being true, rounds end early, one seat gets an extra cut, and the
   * parity fix that the whole design rests on quietly unwinds.
   */
  for (const { modeId, seats } of MATRIX) {
    it(`${modeId}, ${seats} players: every round runs its full length`, () => {
      const mode = allModes().find((m) => m.id === modeId)!;
      const turns = turnsFor(mode, seats);
      const cfg = { ...cfgOf(modeId), turnsEach: turns };
      for (let k = 0; k < 40; k++) {
        const r = playMatch({ cfg, seed: 31 * k + 3, policies: new Array(seats).fill('loose') as Strength[] });
        expect(r.plies, `seed ${k} ended at ply ${r.plies}`).toBe(turns * seats);
      }
    });
  }
});
