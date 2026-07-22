// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * modes.ts — the three shapes a round of Unstrung can take.
 *
 * Principle #14: a mode must change how the game PLAYS, not a number. These three
 * change the rule, the geometry, and the shape of the endgame respectively:
 *
 *  - Strand   — the baseline. Three-letter words are live, so the strand stays
 *               workable right down to the last few tiles.
 *  - Deepcut  — min length FOUR. That is a rule change, not a dial: every
 *               three-letter escape hatch is gone, so a position can genuinely
 *               dry up and you must cut to *place* a seam you can then reach with
 *               a real word. Measured: it ends ~3 cuts earlier on a strand 6
 *               letters longer.
 *  - Twinfold — TWO independent strands. You can never be blocked, so the
 *               question stops being "what can I find" and becomes "which strand
 *               do I spend" — and in versus, a rich strand you leave alive is a
 *               gift you cannot take back.
 *
 * The host's pick travels frozen inside the round start (`roundOpts()`); guests
 * render `rounds.state().hostOpts` and never their own. `modeOf()` validates an
 * id off the wire — an unknown id must fall back, never reach the generator as
 * `undefined`.
 */

export interface Mode {
  id: string;
  name: string;
  /** One line, shown on the mode picker. */
  blurb: string;
  /** How many independent strands are dealt. */
  strands: number;
  /** Letters in each strand. Length === `strands`. */
  letters: number[];
  /** Shortest cuttable word. */
  minLen: number;
  /** Longest cuttable word — the blade's reach. See GameState.maxLen. */
  maxLen: number;
  /** Cuts each player gets. The round ends when everyone has taken theirs. */
  turnsEach: number;
  /** Seconds a player gets per turn in live versus before the host auto-plays. */
  turnSeconds: number;
}

export const MODES: Record<string, Mode> = {
  strand: {
    id: 'strand',
    name: 'Strand',
    blurb: 'One strand of 26. Everything from three letters up.',
    strands: 1,
    letters: [26],
    minLen: 3,
    maxLen: 5,
    turnsEach: 12,
    turnSeconds: 45,
  },
  deepcut: {
    id: 'deepcut',
    name: 'Deepcut',
    blurb: 'A longer strand, and nothing under four letters counts.',
    strands: 1,
    letters: [30],
    minLen: 4,
    maxLen: 6,
    turnsEach: 10,
    turnSeconds: 60,
  },
  twinfold: {
    id: 'twinfold',
    name: 'Twinfold',
    blurb: 'Two strands at once. Never stuck — only ever choosing.',
    strands: 2,
    letters: [14, 14],
    minLen: 3,
    maxLen: 5,
    turnsEach: 12,
    turnSeconds: 45,
  },
};

export const MODE_IDS = ['strand', 'deepcut', 'twinfold'] as const;
export const DEFAULT_MODE = 'strand';

/**
 * Resolve a mode id that may have come off the wire, out of a URL, or out of
 * localStorage. `MODES[id]` alone would let 'constructor' through as a Mode of
 * undefined fields, so the key is checked with `Object.hasOwn`.
 */
export function modeOf(id: unknown): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return MODES[DEFAULT_MODE];
}

export function allModes(): Mode[] {
  return MODE_IDS.map((id) => MODES[id]);
}

/**
 * How many cuts each player gets, given how many are playing.
 *
 * `turnsEach` is quoted for two players; more players share the same round rather
 * than lengthening it, because 12 cuts each at four players is 48 turns and three
 * turns of waiting between each of yours. Floored at 5 so a four-player round is
 * still a game rather than a coin toss.
 */
export function turnsFor(mode: Mode, players: number): number {
  if (players <= 1) return mode.turnsEach;
  return Math.max(5, Math.round((mode.turnsEach * 2) / players));
}
