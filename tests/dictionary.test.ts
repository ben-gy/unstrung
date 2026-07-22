/**
 * dictionary.test.ts — the curation, pinned in BOTH directions.
 *
 * A word game lives or dies on its word list, and it can fail two opposite ways:
 *
 *  - Too permissive: a raw Scrabble/SCOWL dump accepts thousands of entries no
 *    player knows (`nom`, `gos`, `kis`, `qat`, `moa`). In Unstrung, whose whole
 *    verb is "find a readable run of letters", that turns skill into smashing
 *    consonants around a vowel until something lands — the fastest way a word
 *    game feels fake, and explicit playtest feedback on a sibling game.
 *  - Too strict: the raw system dictionary omits plurals and inflections, so
 *    `cats` and `figs` get rejected and the game reads as broken.
 *
 * Both directions are asserted here, because a regeneration could silently move
 * either way.
 */

import { describe, expect, it } from 'vitest';
import { WORDS, SOURCE_WORDS, isWord, MAX_WORD_LEN, MIN_WORD_LEN } from '../src/dict';
import { MODES } from '../src/modes';

describe('the play list rejects short junk', () => {
  // Every one of these is a real entry in a tournament word list.
  const junk = ['NOM', 'GOS', 'KIS', 'TIS', 'QAT', 'MOA', 'ZAX', 'JEU', 'OBE', 'VAU'];
  for (const w of junk) {
    it(`rejects ${w}`, () => {
      expect(isWord(w)).toBe(false);
    });
  }
});

describe('the play list keeps everyday English', () => {
  const keep = [
    'THE', 'AND', 'CAT', 'RUN', 'SEA',
    'CATS', 'FIGS', 'PLAYED', 'RUNNING', 'HOUSES',
    'PLANT', 'ANTE', 'SEAM', 'STRAND', 'THREAD',
  ];
  for (const w of keep) {
    it(`accepts ${w}`, () => {
      expect(isWord(w)).toBe(true);
    });
  }
});

describe('the play list is generous with real long words', () => {
  // The curation is length-scaled: a rare SHORT word is almost certainly a smash,
  // a rare LONG word is almost certainly knowledge. Rejecting these would punish
  // exactly the players the game is for.
  const sophisticated = ['TROVE', 'ABSEIL', 'AMPHORA', 'QUIXOTIC', 'LATTICE', 'CADENCE'];
  for (const w of sophisticated) {
    it(`accepts ${w}`, () => {
      expect(isWord(w)).toBe(true);
    });
  }
});

describe('the list is shaped the way the game needs', () => {
  it('has a usable size', () => {
    expect(WORDS.size).toBeGreaterThan(40_000);
    expect(WORDS.size).toBeLessThan(90_000);
  });

  it('holds nothing outside the length window', () => {
    for (const w of WORDS) {
      expect(w.length).toBeGreaterThanOrEqual(MIN_WORD_LEN);
      expect(w.length).toBeLessThanOrEqual(MAX_WORD_LEN);
    }
  });

  it('is upper-case letters only — no apostrophes, no proper nouns', () => {
    for (const w of WORDS) expect(/^[A-Z]+$/.test(w)).toBe(true);
  });
});

describe('the source list can weave and refill every mode', () => {
  /**
   * The assertion that would have caught a two-hour bug on this build: the source
   * list started at FOUR letters, so `refillWord(..., 3)` returned an empty
   * string, no fresh thread was spliced in, and the board dried out. Every outcome
   * metric merely reported "short rounds", which is indistinguishable from a hard
   * game.
   */
  const lengths = new Set<number>();
  for (const m of Object.values(MODES)) {
    lengths.add(m.minLen);
    for (let len = m.minLen; len <= m.maxLen; len++) lengths.add(len);
  }

  for (const len of [...lengths].sort((a, b) => a - b)) {
    it(`has words of length ${len} to splice in`, () => {
      const pool = SOURCE_WORDS.filter((w) => w.length === len);
      expect(pool.length, `no ${len}-letter source words`).toBeGreaterThan(50);
    });
  }

  it('only contains words the play list also accepts', () => {
    // A strand woven from a word the player cannot then cut would be a lie about
    // what is on the board.
    for (const w of SOURCE_WORDS) expect(isWord(w)).toBe(true);
  });
});
