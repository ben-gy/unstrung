// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * bot.ts — the opponents, and the players in the balance sim.
 *
 * Three strengths, all deterministic given an rng, because a bot that consults
 * `Math.random()` cannot be replayed and cannot referee a balance measurement.
 *
 * The strengths are not "the same policy with more compute" — they differ in what
 * they can SEE, which is what makes them useful as sim arms:
 *
 *   loose  — a legal cut at random. The control: whatever it measures is what the
 *            geometry of the deal does on its own, with no policy on top.
 *   fair   — greedy on immediate value. The naive read of the game, and exactly
 *            the read the seam rule is designed to punish.
 *   sharp  — value now, minus what the cut hands the next player. This is the
 *            only arm that can see the point of the game, so `sharp` beating
 *            `fair` is the measurement that says the mechanic is real rather
 *            than decorative.
 */

import {
  applyCut,
  legalCuts,
  scoreOf,
  spansSeam,
  type GameState,
  type Move,
} from './game';
import { randInt, type Rng } from '@ben-gy/game-engine/rng';

export type Strength = 'loose' | 'fair' | 'sharp';

/** How many candidates `sharp` looks past. Bounds the sim at ~0.6ms per move. */
const SHARP_CANDIDATES = 10;

function valueOf(g: GameState, m: Move): number {
  return scoreOf(m.len, spansSeam(g.strands[m.s], m.i, m.len), g.seamMult);
}

/** The best immediate value available to whoever moves next. */
function bestReply(g: GameState): number {
  let best = 0;
  for (const m of legalCuts(g)) {
    const v = valueOf(g, m);
    if (v > best) best = v;
  }
  return best;
}

/**
 * Choose a cut, or null when the board is exhausted.
 *
 * Ties break on the FIRST candidate in `legalCuts` order, which is stable
 * (strand, index, length) — so a bot replayed from the same seed makes the same
 * choices, and a sim result is a fact rather than a sample of the tie-break.
 */
export function chooseCut(g: GameState, strength: Strength, rng: Rng): Move | null {
  const cuts = legalCuts(g);
  if (!cuts.length) return null;

  if (strength === 'loose') return cuts[randInt(rng, 0, cuts.length - 1)];

  const scored = cuts
    .map((m) => ({ m, v: valueOf(g, m) }))
    .sort((a, b) => b.v - a.v);

  if (strength === 'fair') return scored[0].m;

  // sharp: pay for the seam you are about to hand over.
  let best = scored[0].m;
  let bestNet = -Infinity;
  for (const cand of scored.slice(0, SHARP_CANDIDATES)) {
    const after = applyCut(g, cand.m, g.turn).state;
    const net = cand.v - bestReply(after);
    if (net > bestNet) {
      bestNet = net;
      best = cand.m;
    }
  }
  return best;
}

export const STRENGTH_LABEL: Record<Strength, string> = {
  loose: 'Casual',
  fair: 'Keen',
  sharp: 'Ruthless',
};
