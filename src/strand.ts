/**
 * strand.ts — weave a strand of letters from a seed, deterministically.
 *
 * A random pile of letters is not a strand; it is a wall. The deal has to have an
 * obvious way in (so the first five seconds work) and enough hidden structure
 * that it keeps paying out once seams start landing.
 *
 * So a strand is WOVEN from very common words, OVERLAPPED where their edges
 * agree: `PLANT` + `ANTLER` share `ANT`, so they weave to `PLANTLER` and the
 * boundary is invisible. Overlapping is what stops the deal reading as a list of
 * words with the seams between them — and it is free density, because every
 * overlap point is a word boundary that is also inside another word.
 *
 * Everything here is a pure function of the seed, so two peers weave the exact
 * same strand from the same `RoundInfo.seed` and no board ever crosses the wire.
 */

import { makeRng, randInt, type Rng } from '@ben-gy/game-engine/rng';
import { SOURCE_WORDS } from './dict';
import { createGame, legalCuts, type GameState } from './game';

/** Longest overlap allowed when welding two words together. */
const MAX_OVERLAP = 3;

/**
 * How many legal opening cuts a deal must offer per 10 letters before it is
 * accepted. Below this the player stares at a wall, which is the one failure a
 * word game cannot recover from. Measured across 2,000 seeds: the weaver clears
 * this on the first attempt ~97% of the time, so the reroll is a safety net, not
 * the mechanism.
 */
const MIN_CUTS_PER_10 = 4;

/** How many times to reroll a deal that fails the quality gate. */
const MAX_ATTEMPTS = 24;

/** Source words indexed by their first `k` letters, for fast overlap lookup. */
type Index = Map<string, string[]>;

let indexCache: Map<number, Index> | null = null;

function prefixIndex(k: number): Index {
  if (!indexCache) indexCache = new Map();
  const hit = indexCache.get(k);
  if (hit) return hit;
  const idx: Index = new Map();
  for (const w of SOURCE_WORDS) {
    if (w.length <= k) continue;
    const key = w.slice(0, k);
    const bucket = idx.get(key);
    if (bucket) bucket.push(w);
    else idx.set(key, [w]);
  }
  indexCache.set(k, idx);
  return idx;
}

function pickFrom(rng: Rng, arr: readonly string[]): string {
  return arr[randInt(rng, 0, arr.length - 1)];
}

/**
 * Weave one strand of exactly `target` letters.
 *
 * Overlap is tried longest-first so the weld is as tight as the vocabulary
 * allows, then falls back to a plain butt joint. The final word is trimmed rather
 * than rejected, which leaves a partial word at the tail — deliberately, because
 * a strand whose every boundary is a clean word boundary is one the player can
 * simply read off.
 */
function weave(rng: Rng, target: number): string {
  let out = pickFrom(rng, SOURCE_WORDS);
  let guard = 0;
  while (out.length < target && guard++ < 200) {
    let next = '';
    let overlap = 0;
    for (let k = Math.min(MAX_OVERLAP, out.length); k >= 1 && !next; k--) {
      const bucket = prefixIndex(k).get(out.slice(-k));
      // Only weld with a word long enough that the weld adds real letters.
      const usable = bucket?.filter((w) => w.length > k + 1);
      if (usable?.length) {
        next = pickFrom(rng, usable);
        overlap = k;
      }
    }
    if (!next) {
      next = pickFrom(rng, SOURCE_WORDS);
      overlap = 0;
    }
    out += next.slice(overlap);
  }
  return out.slice(0, target).toUpperCase();
}

export interface DealSpec {
  seed: number | string;
  /** Letters per strand. Length === number of strands. */
  letters: number[];
  minLen: number;
  maxLen: number;
  players: number;
  /** Cuts per player — sets how much spool has to be woven behind each strand. */
  turnsEach: number;
}

export interface WovenDeal {
  strands: string[];
  /** The fresh ribbon behind each strand, drawn on after every cut. */
  spools: string[];
  /** How many attempts the quality gate needed. Surfaced for tests only. */
  attempts: number;
  /** Legal opening cuts on the accepted deal. */
  openingCuts: number;
}

/** How rich a deal is, by the only measure that matters: what you can do on it. */
function openingCuts(strands: string[], minLen: number, maxLen: number): number {
  const g: GameState = createGame({ strands, minLen, maxLen, players: 1, turnsEach: 99 });
  return legalCuts(g).length;
}

/**
 * Weave a full deal, rerolling until it is playable.
 *
 * The reroll derives a fresh rng from `seed` + attempt so the result stays a pure
 * function of the seed — two peers handed the same seed reject the same duds in
 * the same order and accept the same deal.
 */
export function dealStrands(spec: DealSpec): WovenDeal {
  const total = spec.letters.reduce((a, b) => a + b, 0);
  const needed = Math.max(3, Math.round((total / 10) * MIN_CUTS_PER_10));
  // Every cut in the round could, at worst, be `maxLen` long and land on one
  // strand. Weave enough that the spool cannot run dry mid-round, plus slack.
  const spoolLen = spec.turnsEach * spec.players * spec.maxLen + 16;
  let best: string[] | null = null;
  let bestCuts = -1;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = makeRng(`${spec.seed}:${attempt}`);
    const strands = spec.letters.map((n) => weave(rng, n));
    const cuts = openingCuts(strands, spec.minLen, spec.maxLen);
    if (cuts > bestCuts) {
      bestCuts = cuts;
      best = strands;
    }
    if (cuts >= needed) {
      // The spool is woven from a SEPARATE rng stream so that accepting a deal on
      // attempt 3 rather than attempt 1 does not silently change what comes off
      // the spool — the ribbon is a property of the seed, not of how many duds
      // the quality gate rejected on the way.
      const srng = makeRng(`${spec.seed}:spool`);
      return {
        strands,
        spools: spec.letters.map(() => weave(srng, spoolLen)),
        attempts: attempt + 1,
        openingCuts: cuts,
      };
    }
  }
  // Never fail: after MAX_ATTEMPTS, ship the richest deal we saw. A thin strand
  // is a worse game; no strand is no game at all.
  const srng = makeRng(`${spec.seed}:spool`);
  return {
    strands: best!,
    spools: spec.letters.map(() => weave(srng, spoolLen)),
    attempts: MAX_ATTEMPTS,
    openingCuts: bestCuts,
  };
}

/** The UTC day, as a stable seed string for the daily strand. */
export function dailySeed(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `daily-${y}-${m}-${d}`;
}
