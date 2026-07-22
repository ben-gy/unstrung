/**
 * dict.ts — the curated word list, inlined at build time so the game is offline.
 *
 * See `scripts/gen-dictionary.mjs` for the curation policy and why a raw
 * Scrabble/SCOWL dump is not used. Short version: leniency scales with LENGTH —
 * strict at 3 letters (where smashing consonants around a vowel lands on some
 * obscure valid word by accident), generous at 5+ (where a rare word means the
 * player genuinely knew it).
 *
 * The rejection message is "Not in word list", never "Not a word". The list
 * deliberately excludes real English words, and telling a player that `qat` is
 * not a word when it is would be a lie about our own rules.
 */

import wordsRaw from './data/words.txt?raw';
import sourceRaw from './data/source-words.txt?raw';

/** Longest word the list contains — bounds every substring scan in game.ts. */
export const MAX_WORD_LEN = 10;
export const MIN_WORD_LEN = 3;

function parse(raw: string): string[] {
  return raw
    .split('\n')
    .map((w) => w.trim().toUpperCase())
    .filter((w) => w.length >= MIN_WORD_LEN && w.length <= MAX_WORD_LEN && /^[A-Z]+$/.test(w));
}

export const WORDS: ReadonlySet<string> = new Set(parse(wordsRaw));

/**
 * The smaller, much more common list a strand is WOVEN from (see strand.ts).
 * Deliberately not the play list: a strand built from band-60 vocabulary would
 * be a wall of letters nobody can read into, whereas one built from band-20 words
 * has an obvious way in and gets strange only once the seams start landing.
 */
export const SOURCE_WORDS: readonly string[] = parse(sourceRaw);

export function isWord(w: string): boolean {
  return WORDS.has(w);
}
