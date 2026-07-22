#!/usr/bin/env node
/**
 * gen-dictionary.mjs — build the curated word list Unstrung plays with.
 *
 * NOT a raw Scrabble/SCOWL dump. A tournament list accepts thousands of entries
 * no real player knows (`nom`, `gos`, `kis`, `qat`, `moa`), and in a game whose
 * whole verb is "find a readable run of letters" that turns skill into smashing
 * consonants around a vowel until something lands. That is the single fastest way
 * a word game feels fake.
 *
 * So leniency scales with LENGTH, because the junk problem is almost entirely a
 * SHORT-word phenomenon — there are few 3-letter combinations and most of them
 * happen to be some obscure valid word, so you hit one without knowing it. A long
 * word cannot be smashed: if someone finds `AMPHORA` in a strand, they knew it,
 * and rejecting it just punishes vocabulary.
 *
 *   length 3  -> SCOWL band <= 35   (strict — kills the smash-fest)
 *   length 4  -> band <= 50
 *   length 5+ -> band <= 60         (generous; stops before band 70's flood)
 *
 * Also emits a smaller SOURCE list (band <= 35, length 4..8) used by strand.ts to
 * weave a strand out of words people actually recognise.
 *
 * Run: npm run gen:dict
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PKG = join(ROOT, 'node_modules', 'wordlist-english');

/** SCOWL frequency bands, most common first. */
const BANDS = [10, 20, 35, 40, 50, 55, 60];

/** Max band allowed at each word length. Everything else is rejected. */
const MAX_BAND_FOR_LENGTH = (len) => (len <= 3 ? 35 : len === 4 ? 50 : 60);

/**
 * Capped at 10 because a contiguous 11-letter run inside a 26–32 letter strand is
 * vanishingly rare, and those two length buckets alone are ~11,700 words — a sixth
 * of the payload every player downloads, for words nobody will ever cut.
 */
const MIN_LEN = 3;
const MAX_LEN = 10;

/** Bands used to weave strands — only words a player will recognise instantly. */
const SOURCE_MAX_BAND = 20;
const SOURCE_MIN_LEN = 3;
const SOURCE_MAX_LEN = 7;

function loadBand(band) {
  const out = new Set();
  // "english" is the union of the regional lists; both spellings are accepted,
  // which is the right call for a game played on both sides of the Atlantic.
  for (const dialect of ['english', 'american', 'british']) {
    const file = join(PKG, `${dialect}-words-${band}.json`);
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const w of JSON.parse(raw)) out.add(w);
  }
  return out;
}

const play = new Set();
const source = new Set();

for (const band of BANDS) {
  const words = loadBand(band);
  for (const raw of words) {
    const w = raw.toUpperCase();
    // Letters only: no apostrophes (`don't`), no proper nouns, no hyphens.
    if (!/^[A-Z]+$/.test(w)) continue;
    if (raw !== raw.toLowerCase()) continue; // drops proper nouns
    const len = w.length;
    if (len < MIN_LEN || len > MAX_LEN) continue;
    if (band <= MAX_BAND_FOR_LENGTH(len)) play.add(w);
    if (band <= SOURCE_MAX_BAND && len >= SOURCE_MIN_LEN && len <= SOURCE_MAX_LEN) source.add(w);
  }
}

/**
 * A handful of extremely common short words that SCOWL's small-band lists split
 * across dialects inconsistently. Adding them is safe (they are unambiguously
 * everyday English) and their absence reads as a bug to a player.
 */
for (const w of ['THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HER', 'WAS', 'ONE', 'OUR', 'OUT', 'DAY', 'GET', 'HAS', 'HIM', 'HIS', 'HOW', 'ITS', 'NEW', 'NOW', 'OLD', 'SEE', 'TWO', 'WAY', 'WHO', 'BOY', 'DID', 'MAN', 'MEN', 'PUT', 'SAY', 'SHE', 'TOO', 'USE']) {
  play.add(w);
}

const sortWords = (s) => [...s].sort();

mkdirSync(join(ROOT, 'src', 'data'), { recursive: true });
writeFileSync(join(ROOT, 'src', 'data', 'words.txt'), sortWords(play).join('\n') + '\n');
writeFileSync(join(ROOT, 'src', 'data', 'source-words.txt'), sortWords(source).join('\n') + '\n');

const byLen = {};
for (const w of play) byLen[w.length] = (byLen[w.length] ?? 0) + 1;
process.stdout.write(
  `play list:   ${play.size} words  ${JSON.stringify(byLen)}\n` +
    `source list: ${source.size} words (band <= ${SOURCE_MAX_BAND}, len ${SOURCE_MIN_LEN}-${SOURCE_MAX_LEN})\n`,
);
