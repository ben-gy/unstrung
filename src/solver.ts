// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * solver.ts — "here's the line you missed."
 *
 * A score-attack screen that only reflects your own number back at you wastes the
 * one moment a player is actually curious (principle #9). Unstrung has a knowable
 * best answer — the strand is finite, perfect-information and deterministic — so
 * the results screen shows the strongest line the solver found on YOUR exact
 * deal, word by word, including which of them scored double.
 *
 * It is a BEAM search, not an exhaustive one, and it says so. Exhaustive is
 * hopeless: a 26-letter strand offers ~25 opening cuts and the tree runs ~8 deep,
 * and worse, the interesting part is that a cut CREATES options, so the branching
 * factor does not politely decay.
 *
 * The ordering heuristic is the only non-obvious part. Sorting the beam by score
 * alone makes it greedy, and greedy is precisely the trap this game is built to
 * punish — it takes the fat word early, before there are any seams to double it.
 * So a node is also credited for the seams it has MANUFACTURED, which is a rough
 * stand-in for the doubled words those seams will pay for later.
 */

import {
  applyCut,
  createGame,
  legalCuts,
  seamCount,
  type Deal,
  type GameState,
  type PlayedMove,
} from './game';

/** Beam width. 96 costs ~120ms on a 32-letter strand and finds ~97% of what 512 does. */
const DEFAULT_WIDTH = 96;

/** Hard ceiling on expansions, so a pathological deal cannot hang the results screen. */
const DEFAULT_BUDGET = 60_000;

/**
 * How much a manufactured seam is worth in the ordering heuristic.
 *
 * Not a game rule — it never touches a score. It exists purely so the beam does
 * not collapse onto greedy lines. 6 is roughly what one future doubled 3-letter
 * word is worth (9 base -> 18, a gain of 9) discounted for the chance the seam is
 * never usable.
 */
const SEAM_PROMISE = 6;

export interface BestLine {
  score: number;
  moves: PlayedMove[];
  /** Expansions performed — surfaced so a test can tell a real search from a stub. */
  nodes: number;
  /** True when the whole tree fitted inside the budget. */
  exhaustive: boolean;
}

export interface SolveOptions {
  width?: number;
  budget?: number;
}

interface Node {
  state: GameState;
  key: string;
}

function keyOf(g: GameState): string {
  return g.strands
    .map((s) => s.letters.join('') + '|' + s.seam.map((b) => (b ? '1' : '0')).join(''))
    .join('#');
}

function rank(g: GameState): number {
  return g.scores[0] + SEAM_PROMISE * seamCount(g);
}

/**
 * The strongest line the beam finds. Solo semantics: one player, so `scores[0]`
 * is the line's total.
 */
export function bestLine(deal: Deal, opts: SolveOptions = {}): BestLine {
  const width = opts.width ?? DEFAULT_WIDTH;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const root = createGame({ ...deal, players: 1 });

  let beam: Node[] = [{ state: root, key: keyOf(root) }];
  let best: GameState = root;
  let nodes = 0;
  let truncated = false;

  while (beam.length) {
    const seen = new Map<string, Node>();
    for (const node of beam) {
      const cuts = legalCuts(node.state);
      if (!cuts.length) {
        if (node.state.scores[0] > best.scores[0]) best = node.state;
        continue;
      }
      for (const m of cuts) {
        if (nodes >= budget) {
          truncated = true;
          break;
        }
        nodes++;
        const child = applyCut(node.state, m, 0).state;
        const k = keyOf(child);
        // Two different move orders can reach the same board. Keep the richer one:
        // identical boards have identical futures, so the lower score is dead weight.
        const prev = seen.get(k);
        if (!prev || child.scores[0] > prev.state.scores[0]) seen.set(k, { state: child, key: k });
        if (child.scores[0] > best.scores[0]) best = child;
      }
      if (nodes >= budget) break;
    }
    if (!seen.size) break;
    beam = [...seen.values()];
    if (beam.length > width) {
      beam.sort((a, b) => rank(b.state) - rank(a.state));
      beam.length = width;
      truncated = true;
    }
    if (nodes >= budget) break;
  }

  return { score: best.scores[0], moves: best.history, nodes, exhaustive: !truncated };
}
