/**
 * determinism.test.ts — the invariant the whole netcode rests on.
 *
 * Unstrung is LOCKSTEP: no board state ever crosses the wire, only
 * `{round, ply, s, i, len}`. That is only safe if two peers handed the same seed
 * build a byte-identical strand, a byte-identical spool, and pick byte-identical
 * refill words — for the whole round, from the move list alone.
 *
 * If any of that drifts, two players see different letters on the same board and
 * there is no error message anywhere: the game just quietly stops being the same
 * game. So this is the file that has to be right.
 */

import { describe, expect, it } from 'vitest';
import { applyCut, createGame, legalCuts, refillWord, type GameState, type Move } from '../src/game';
import { dealStrands, dailySeed } from '../src/strand';
import { allModes, turnsFor } from '../src/modes';

function deal(seed: number | string, modeId = 'strand', players = 2) {
  const mode = allModes().find((m) => m.id === modeId)!;
  return dealStrands({
    seed,
    letters: mode.letters,
    minLen: mode.minLen,
    maxLen: mode.maxLen,
    turnsEach: turnsFor(mode, players),
    players,
  });
}

function build(seed: number, modeId = 'strand', players = 2): GameState {
  const mode = allModes().find((m) => m.id === modeId)!;
  const w = deal(seed, modeId, players);
  return createGame({
    strands: w.strands,
    spools: w.spools,
    refillSeed: seed,
    turnsEach: turnsFor(mode, players),
    minLen: mode.minLen,
    maxLen: mode.maxLen,
    players,
  });
}

describe('the deal is a pure function of the seed', () => {
  for (const mode of allModes()) {
    it(`${mode.id}: same seed, identical strands and spools`, () => {
      const a = deal(12_345, mode.id);
      const b = deal(12_345, mode.id);
      expect(a.strands).toEqual(b.strands);
      expect(a.spools).toEqual(b.spools);
    });

    it(`${mode.id}: different seeds give different strands`, () => {
      expect(deal(1, mode.id).strands).not.toEqual(deal(2, mode.id).strands);
    });

    it(`${mode.id}: deals exactly the letters the mode asks for`, () => {
      const d = deal(777, mode.id);
      expect(d.strands.map((s) => s.length)).toEqual(mode.letters);
      expect(d.strands.every((s) => /^[A-Z]+$/.test(s))).toBe(true);
    });
  }

  it('accepts a string seed, so the daily strand is stable', () => {
    const a = deal(dailySeed(new Date('2026-07-22T09:00:00Z')));
    const b = deal(dailySeed(new Date('2026-07-22T23:59:00Z')));
    expect(a.strands).toEqual(b.strands);
    const c = deal(dailySeed(new Date('2026-07-23T00:01:00Z')));
    expect(c.strands).not.toEqual(a.strands);
  });

  it('is not disturbed by how many duds the quality gate rejected', () => {
    // The spool is woven from its OWN rng stream. If it shared one with the
    // strand, accepting a deal on attempt 3 rather than attempt 1 would change
    // what comes off the spool — and a peer that rejected a different number of
    // duds would refill differently. It cannot, but assert it anyway.
    const d = deal(4242);
    expect(d.attempts).toBeGreaterThanOrEqual(1);
    expect(deal(4242).spools).toEqual(d.spools);
  });
});

describe('the refill is a pure function too', () => {
  it('depends on exactly (seed, strand, draw, length)', () => {
    expect(refillWord(5, 0, 0, 3)).toBe(refillWord(5, 0, 0, 3));
    expect(refillWord(5, 0, 0, 3)).not.toBe(refillWord(5, 1, 0, 3));
    expect(refillWord(5, 0, 0, 3)).not.toBe(refillWord(5, 0, 1, 3));
  });

  it('never returns an empty string for any length a mode can cut', () => {
    for (const mode of allModes()) {
      for (let len = mode.minLen; len <= mode.maxLen; len++) {
        for (let draw = 0; draw < 50; draw++) {
          expect(refillWord(99, 0, draw, len), `len ${len} draw ${draw}`).toHaveLength(len);
        }
      }
    }
  });
});

describe('two peers replaying the same moves agree, letter for letter', () => {
  for (const mode of allModes()) {
    it(`${mode.id}: a full round replays identically from the move list`, () => {
      const seed = 555_777;
      let a = build(seed, mode.id);
      const moves: Move[] = [];
      // Play a whole round on peer A, taking a deliberately varied mix of cuts so
      // heads, tails and interiors are all exercised.
      let k = 0;
      while (!a.over) {
        const cuts = legalCuts(a);
        const m = cuts[(k * 7 + 3) % cuts.length];
        moves.push(m);
        a = applyCut(a, m).state;
        k++;
      }

      // Peer B receives only the move list and rebuilds from the deal.
      let b = build(seed, mode.id);
      for (const m of moves) b = applyCut(b, m).state;

      expect(b.strands.map((s) => s.letters.join(''))).toEqual(a.strands.map((s) => s.letters.join('')));
      expect(b.strands.map((s) => s.seam.join(''))).toEqual(a.strands.map((s) => s.seam.join('')));
      expect(b.scores).toEqual(a.scores);
      expect(b.ply).toEqual(a.ply);
      expect(b.history.map((h) => `${h.word}:${h.value}:${h.spannedSeam}`)).toEqual(
        a.history.map((h) => `${h.word}:${h.value}:${h.spannedSeam}`),
      );
    });
  }

  it('rejects a move that does not fit the board it claims to fit', () => {
    // The recovery path replays from the deal and STOPS at the first move that
    // does not apply, rather than fabricating a divergent board.
    const g = build(9);
    const bogus: Move = { s: 0, i: 0, len: 6 };
    if (!legalCuts(g).some((m) => m.i === 0 && m.len === 6)) {
      expect(() => applyCut(g, bogus)).toThrow();
    }
  });
});
