/**
 * game.test.ts — the rules, one at a time.
 *
 * The seam bookkeeping is the fiddly half of this game and every edge here is a
 * case that can silently produce a board nobody can read: a cut at the head, a
 * cut at the tail, a seam that should vanish with the letters that carried it,
 * a seam at index 0 that must never exist.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCut,
  createGame,
  cutsLeft,
  hasLegalCut,
  isLegal,
  legalCuts,
  scoreOf,
  seamCount,
  seatAt,
  spansSeam,
  spliceStrand,
  refillWord,
  wordAt,
  SEAM_MULT,
  type GameState,
} from '../src/game';

function board(letters: string, opts: Partial<Parameters<typeof createGame>[0]> = {}): GameState {
  return createGame({
    strands: [letters],
    turnsEach: 99,
    minLen: 3,
    maxLen: 6,
    players: 1,
    refill: 'none',
    ...opts,
  });
}

describe('reading the strand', () => {
  it('reads a contiguous run left to right', () => {
    const g = board('PLANTER');
    expect(wordAt(g.strands[0], 0, 5)).toBe('PLANT');
    expect(wordAt(g.strands[0], 2, 4)).toBe('ANTE');
  });

  it('refuses to read past the end', () => {
    const g = board('PLANT');
    expect(wordAt(g.strands[0], 3, 5)).toBe('');
    expect(wordAt(g.strands[0], -1, 2)).toBe('');
  });
});

describe('legality', () => {
  it('accepts a real word inside the length window', () => {
    const g = board('PLANTER');
    expect(isLegal(g, { s: 0, i: 0, len: 5 })).toBe(true);
  });

  it('rejects anything below the minimum length', () => {
    const g = board('PLANTER', { minLen: 4 });
    // AN is short; ANT is a word but under the mode's floor.
    expect(isLegal(g, { s: 0, i: 2, len: 3 })).toBe(false);
    expect(isLegal(g, { s: 0, i: 2, len: 4 })).toBe(true);
  });

  it('rejects anything above the blade length', () => {
    const g = board('PLANTER', { maxLen: 4 });
    expect(isLegal(g, { s: 0, i: 0, len: 5 })).toBe(false);
  });

  it('rejects letters that are not a word', () => {
    const g = board('XQZPLANT');
    expect(isLegal(g, { s: 0, i: 0, len: 3 })).toBe(false);
  });

  it('rejects a strand index that does not exist', () => {
    const g = board('PLANTER');
    expect(isLegal(g, { s: 4, i: 0, len: 5 })).toBe(false);
  });

  it('enumerates cuts in a stable order — the auto-play tiebreak depends on it', () => {
    const g = board('PLANTER');
    const a = legalCuts(g);
    const b = legalCuts(g);
    expect(a).toEqual(b);
    const keys = a.map((m) => `${m.s}:${m.i}:${m.len}`);
    expect([...keys].sort()).toEqual([...new Set(keys)].sort());
    // sorted by strand, then index, then length
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1];
      const cur = a[i];
      expect(cur.s > prev.s || cur.i > prev.i || (cur.i === prev.i && cur.len > prev.len)).toBe(true);
    }
  });
});

describe('splicing and seams', () => {
  it('joins the two ends and marks the join', () => {
    const st = { letters: [...'PLANTERMS'], seam: new Array(9).fill(false) };
    // cut ANTE (index 2, len 4) -> PL | RMS
    const next = spliceStrand(st, 2, 4);
    expect(next.letters.join('')).toBe('PLRMS');
    expect(next.seam).toEqual([false, false, true, false, false]);
  });

  it('leaves NO seam when the cut takes the head', () => {
    const st = { letters: [...'PLANTERS'], seam: new Array(8).fill(false) };
    const next = spliceStrand(st, 0, 5);
    expect(next.letters.join('')).toBe('ERS');
    // Nothing was joined — the strand just got shorter.
    expect(next.seam.some(Boolean)).toBe(false);
  });

  it('leaves NO seam when the cut takes the tail', () => {
    const st = { letters: [...'PLANTERS'], seam: new Array(8).fill(false) };
    const next = spliceStrand(st, 5, 3);
    expect(next.letters.join('')).toBe('PLANT');
    expect(next.seam.some(Boolean)).toBe(false);
  });

  it('never leaves a seam at index 0', () => {
    // A seam sat between letters 4 and 5; cutting the first five letters would
    // naively inherit it as seam[0], a join before the first letter.
    const seam = new Array(8).fill(false);
    seam[5] = true;
    const st = { letters: [...'PLANTERS'], seam };
    const next = spliceStrand(st, 0, 5);
    expect(next.seam[0]).toBe(false);
  });

  it('drops seams that were carried by the letters removed', () => {
    const seam = new Array(9).fill(false);
    seam[3] = true; // inside the cut
    const st = { letters: [...'PLANTERMS'], seam };
    const next = spliceStrand(st, 2, 4);
    expect(next.seam.filter(Boolean).length).toBe(1); // only the new join
    expect(next.seam[2]).toBe(true);
  });
});

describe('spanning a seam', () => {
  const withSeamAt = (letters: string, at: number): GameState => {
    const g = board(letters);
    g.strands[0].seam[at] = true;
    return g;
  };

  it('counts a seam strictly inside the word', () => {
    const g = withSeamAt('PLANTER', 3);
    expect(spansSeam(g.strands[0], 1, 4)).toBe(true);
  });

  it('does NOT count a seam at the word\'s left edge', () => {
    // You have to bridge the join, not butt against it.
    const g = withSeamAt('PLANTER', 2);
    expect(spansSeam(g.strands[0], 2, 4)).toBe(false);
  });

  it('does NOT count a seam just past the word\'s right edge', () => {
    const g = withSeamAt('PLANTER', 5);
    expect(spansSeam(g.strands[0], 1, 4)).toBe(false);
  });
});

describe('scoring', () => {
  it('is length squared', () => {
    expect(scoreOf(3, false)).toBe(9);
    expect(scoreOf(5, false)).toBe(25);
  });

  it('multiplies a bridge by the seam multiplier', () => {
    expect(scoreOf(3, true)).toBe(9 * SEAM_MULT);
    expect(scoreOf(5, true)).toBe(25 * SEAM_MULT);
  });

  it('pays out through applyCut', () => {
    const g = board('PLANTERMS');
    const { state, played } = applyCut(g, { s: 0, i: 0, len: 5 });
    expect(played.word).toBe('PLANT');
    expect(played.value).toBe(25);
    expect(state.scores[0]).toBe(25);
  });

  it('refuses to apply an illegal cut rather than scoring nonsense', () => {
    const g = board('PLANTER');
    expect(() => applyCut(g, { s: 0, i: 0, len: 2 })).toThrow();
  });
});

describe('the spool', () => {
  it('splices a whole word of the cut length into the gap', () => {
    const g = createGame({
      strands: ['PLANTERMS'],
      turnsEach: 9,
      minLen: 3,
      maxLen: 6,
      players: 1,
      refillSeed: 42,
    });
    const before = g.strands[0].letters.length;
    const { state } = applyCut(g, { s: 0, i: 2, len: 4 });
    // Same length in, same length out: the board never changes size.
    expect(state.strands[0].letters.length).toBe(before);
    // Both boundaries between old and new thread are seams.
    expect(state.strands[0].seam[2]).toBe(true);
    expect(state.strands[0].seam[6]).toBe(true);
    // ...and there is no seam INSIDE the fresh thread, which is what keeps the
    // free move worth base value.
    expect(state.strands[0].seam.slice(3, 6).some(Boolean)).toBe(false);
  });

  it('keeps the strand exactly the same length, cut after cut', () => {
    // Structural. If the board can shrink, "a fixed number of cuts each" stops
    // being a fair round and the phone layout stops being predictable. Run with
    // NO spool at all, which is the case that first broke it.
    let g = createGame({
      strands: ['PLANTERMSHAPEDGEARLYWORKS'],
      turnsEach: 30,
      minLen: 3,
      maxLen: 6,
      players: 1,
      refillSeed: 3,
    });
    const size = g.strands[0].letters.length;
    for (let k = 0; k < 30 && !g.over; k++) {
      g = applyCut(g, legalCuts(g)[legalCuts(g).length - 1]).state;
      expect(g.strands[0].letters.length, `after cut ${k + 1}`).toBe(size);
      expect(g.strands[0].seam.length).toBe(size);
    }
  });

  it('always leaves at least one legal cut on the board', () => {
    let g = createGame({
      strands: ['PLANTERMSHAPEDGEARLYWORKS'],
      turnsEach: 40,
      minLen: 3,
      maxLen: 5,
      players: 1,
      refillSeed: 7,
    });
    for (let k = 0; k < 40 && !g.over; k++) {
      const cuts = legalCuts(g);
      expect(cuts.length, `dry after ${k} cuts: ${g.strands[0].letters.join('')}`).toBeGreaterThan(0);
      g = applyCut(g, cuts[cuts.length - 1]).state;
    }
  });

  it('picks the refill word purely from (seed, strand, draw, length)', () => {
    expect(refillWord(99, 0, 3, 4)).toBe(refillWord(99, 0, 3, 4));
    expect(refillWord(99, 0, 3, 4)).not.toBe(refillWord(100, 0, 3, 4));
    expect(refillWord(99, 0, 3, 4)).toHaveLength(4);
  });

  it('never returns a negative index (the signed-shift trap)', () => {
    // `h ^ (h >>> 13)` yields a SIGNED int; without the >>> 0 the pool index goes
    // negative and the refill is silently `undefined`, which reads downstream as
    // "the board dried out".
    for (let seed = 0; seed < 400; seed++) {
      for (let len = 3; len <= 6; len++) {
        expect(typeof refillWord(seed * 65_537, seed % 2, seed, len)).toBe('string');
        expect(refillWord(seed * 65_537, seed % 2, seed, len).length).toBe(len);
      }
    }
  });
});

describe('turns and endings', () => {
  it('cycles seats and never reverses them', () => {
    for (let p = 0; p < 12; p++) expect(seatAt('cycle', 3, p)).toBe(p % 3);
  });

  it('ends the round when everyone has spent their cuts', () => {
    let g = createGame({
      strands: ['PLANTERMSHAPEDGEARLY'],
      turnsEach: 2,
      minLen: 3,
      maxLen: 5,
      players: 2,
      refillSeed: 5,
    });
    for (let k = 0; k < 4; k++) {
      expect(g.over).toBe(false);
      g = applyCut(g, legalCuts(g)[0]).state;
    }
    expect(g.over).toBe(true);
    expect(g.ply).toBe(4);
    expect(cutsLeft(g, 0)).toBe(0);
    expect(cutsLeft(g, 1)).toBe(0);
  });

  it('gives both players exactly the same number of cuts', () => {
    let g = createGame({
      strands: ['PLANTERMSHAPEDGEARLY'],
      turnsEach: 5,
      minLen: 3,
      maxLen: 5,
      players: 2,
      refillSeed: 11,
    });
    while (!g.over) g = applyCut(g, legalCuts(g)[0]).state;
    const bySeat = [0, 1].map((i) => g.history.filter((h) => h.player === i).length);
    expect(bySeat[0]).toBe(bySeat[1]);
  });

  it('reports no legal cut on a board with nothing in it', () => {
    const g = board('XQZJV');
    expect(hasLegalCut(g)).toBe(false);
    expect(legalCuts(g)).toEqual([]);
  });

  it('counts the seams on the board', () => {
    const g = board('PLANTERMS');
    const { state } = applyCut(g, { s: 0, i: 2, len: 4 });
    expect(seamCount(state)).toBe(1);
  });
});
