/**
 * game.ts — the whole rule set, as a pure reducer.
 *
 * Nothing here touches the DOM, the clock, or the network. That is what lets the
 * multiplayer be LOCKSTEP: every peer runs this same function over the same move
 * list and no board state ever crosses the wire, so the classic desync surface
 * does not exist. It is also what lets the balance sim, the solver and the bot
 * all drive the real rules rather than a second copy of them.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A strand is one run of letters. Cut out a contiguous run that spells a word;
 * the letters on either side of the gap SPLICE together, and that join is a
 * permanent, visible SEAM.
 *
 *   A word that spans a seam scores double.
 *
 * That is the entire design. It makes a cut an act of manufacturing rather than
 * harvesting (you are choosing what the board becomes), and it makes the game get
 * bigger as it goes with ZERO new state — early cuts have no seams to span and
 * score base, late cuts sit in a strand riddled with them. Which is also, not
 * coincidentally, what has to cancel the first-mover edge in versus: principle
 * #18's "make the early game small and the late game big", expressed as a rule
 * rather than a handicap.
 */

import { isWord, MAX_WORD_LEN, SOURCE_WORDS } from './dict';

/**
 * Common words bucketed by length, for the refill. Built once, lazily — 5,760
 * source words is a fraction of a millisecond and it is never needed before the
 * first cut.
 */
let byLen: Map<number, string[]> | null = null;
function wordsOfLength(len: number): string[] {
  if (!byLen) {
    byLen = new Map();
    for (const w of SOURCE_WORDS) {
      const b = byLen.get(w.length);
      if (b) b.push(w);
      else byLen.set(w.length, [w]);
    }
  }
  return byLen.get(len) ?? [];
}

/**
 * Which word gets spliced in — a pure function of (deal seed, strand, draw
 * number, length), so it needs no rng state and replays byte-identically on
 * every peer from the move list alone.
 */
export function refillWord(refillSeed: number, strand: number, draw: number, len: number): string {
  const pool = wordsOfLength(len);
  if (!pool.length) return '';
  // xorshift-ish mix; only needs to decorrelate three small integers.
  let h = (refillSeed ^ (strand * 0x9e3779b1) ^ (draw * 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  // `^` yields a SIGNED 32-bit int, so this must be coerced back to unsigned or
  // the index goes negative and the refill silently becomes `undefined`.
  h = (h ^ (h >>> 13)) >>> 0;
  return pool[h % pool.length];
}

/**
 * What a seam-spanning word is multiplied by.
 *
 * LOAD-BEARING, and swept rather than chosen. It is the ONLY thing standing
 * between "whoever moves first banks the fat words" and a game — measured at
 * n=300, two players, otherwise identical config:
 *
 *   x1 (no seam bonus) -> seat 0 wins 77.0%   (and the mechanic is decoration)
 *   x2                 -> seat 0 wins 63.0%
 *   x3                 -> seat 0 wins 52.5%   <- shipped
 *
 * That is the sentence the whole design rests on: the seam rule is not flavour on
 * top of a fair game, it IS what makes the game fair, because a seam is something
 * the PREVIOUS player made and therefore pays the NEXT one. Pinned in
 * balance.test.ts so nobody can quietly "simplify" it back to doubling.
 */
export const SEAM_MULT = 3;

/**
 * How the turn passes.
 *
 * 'cycle' is shipped. The other two are kept only because the balance test needs
 * them to prove WHY, and the answer is not the one anybody would guess: BOTH
 * textbook fairness devices make it worse, because the seam ramp is already
 * over-compensating the later seats and they compensate it a second time.
 *
 *   four players, `strand`, n=300 x 3 seed families, seat win % vs 25% chance
 *     cycle    23 / 29 / 24 / 18      <- shipped
 *     snake    15 / 22 / 25 / 33      bias moved to the far end, and bigger
 *     rotate   13 / 33 / 27 / 22      seat 0 collapses to half its fair share
 *
 * 'snake' reverses the order each round; 'rotate' moves the starting seat along
 * each round so every player takes each pick-position equally often. The second
 * is fair BY CONSTRUCTION on pick order alone, which is exactly why measuring it
 * was worth the five minutes: pick order is not what the bias is made of.
 */
export type TurnOrder = 'cycle' | 'snake' | 'rotate';

/** Whose turn it is at ply `p`, for `players` seats. */
export function seatAt(order: TurnOrder, players: number, p: number): number {
  const k = p % players;
  if (order === 'cycle') return k;
  const round = Math.floor(p / players);
  if (order === 'rotate') return (round + k) % players;
  return round % 2 === 0 ? k : players - 1 - k;
}

/** Where — and what — fresh thread is added after a cut. */
export type RefillMode = 'mix' | 'word' | 'inline' | 'tail' | 'none';

export interface Strand {
  letters: string[];
  /**
   * `seam[i]` is true when there is a seam BETWEEN `letters[i-1]` and
   * `letters[i]`. `seam[0]` is therefore always false — there is no join before
   * the first letter — and `seam.length === letters.length`.
   */
  seam: boolean[];
}

/** A cut. `len === 0` is never legal; passes do not exist (see `isOver`). */
export interface Move {
  /** Which strand (0-based). */
  s: number;
  /** Index of the first letter cut. */
  i: number;
  /** How many letters. */
  len: number;
}

/** A move plus everything the UI, the results screen and the audit need. */
export interface PlayedMove extends Move {
  word: string;
  /** Whose cut it was. */
  player: number;
  /** True when the word covered at least one seam — i.e. it scored double. */
  spannedSeam: boolean;
  /** Points awarded. */
  value: number;
  /** 0-based move number across the whole round. */
  ply: number;
}

export interface GameState {
  strands: Strand[];
  /**
   * The unspooled ribbon each strand draws fresh letters from, and how far into
   * it we have drawn. See `REFILL` below.
   */
  spools: string[];
  spoolAt: number[];
  /** Where fresh thread goes. See `spliceIn` for why this is not 'tail'. */
  refill: RefillMode;
  order: TurnOrder;
  /** Seeds `refillWord`. Fixed at the deal, so the whole round is replayable. */
  refillSeed: number;
  /** Refills taken per strand — the `draw` index into `refillWord`. */
  draws: number[];
  /** Cuts each player gets. The round ends when everyone has taken this many. */
  turnsEach: number;
  minLen: number;
  /**
   * Longest cuttable word — the blade's reach.
   *
   * NOT cosmetic, and not originally in the design. The balance sim's first
   * baseline showed the whole game finishing in 3.7 cuts: with no cap, a strand
   * is a wasting asset spent at ~7 letters a bite, so 26 letters is three moves.
   * Seat 0 won 90-95%, and the seam rule — the entire point of the game — fired
   * on 6-12% of cuts because the board never survived long enough to accumulate
   * any joins. See balance.test.ts for the sweep that set this.
   */
  maxLen: number;
  players: number;
  /** How much a seam-spanning word is multiplied by. See `SEAM_MULT`. */
  seamMult: number;
  scores: number[];
  /** Whose turn it is. Always 0 in solo. */
  turn: number;
  ply: number;
  history: PlayedMove[];
  over: boolean;
}

export interface Deal {
  /** Raw letters per strand, as woven by strand.ts. */
  strands: string[];
  /** Fresh ribbon per strand, drawn on after every cut. Same length as `strands`. */
  spools?: string[];
  /** Defaults to 'word'. Overridable so the balance sweep can compare shapes. */
  refill?: RefillMode;
  refillSeed?: number;
  /** Defaults to 'cycle'. See `TurnOrder` for why not 'snake'. */
  order?: TurnOrder;
  turnsEach: number;
  minLen: number;
  maxLen: number;
  players: number;
  /** Defaults to `SEAM_MULT`. Overridable so the balance sweep can move it. */
  seamMult?: number;
}

export function createGame(deal: Deal): GameState {
  return {
    strands: deal.strands.map((s) => ({
      letters: [...s.toUpperCase()],
      seam: new Array(s.length).fill(false),
    })),
    spools: deal.spools ?? deal.strands.map(() => ''),
    spoolAt: deal.strands.map(() => 0),
    refill: deal.refill ?? 'mix',
    order: deal.order ?? 'cycle',
    refillSeed: (deal.refillSeed ?? 1) >>> 0,
    draws: deal.strands.map(() => 0),
    turnsEach: deal.turnsEach,
    minLen: deal.minLen,
    maxLen: Math.min(deal.maxLen, MAX_WORD_LEN),
    seamMult: deal.seamMult ?? SEAM_MULT,
    players: deal.players,
    scores: new Array(deal.players).fill(0),
    turn: seatAt(deal.order ?? 'cycle', deal.players, 0),
    ply: 0,
    history: [],
    over: false,
  };
}

/** Deep copy — the reducer is pure, so every caller gets its own state. */
export function cloneState(g: GameState): GameState {
  return {
    strands: g.strands.map((s) => ({ letters: [...s.letters], seam: [...s.seam] })),
    spools: g.spools,
    spoolAt: [...g.spoolAt],
    refill: g.refill,
    order: g.order,
    refillSeed: g.refillSeed,
    draws: [...g.draws],
    turnsEach: g.turnsEach,
    minLen: g.minLen,
    maxLen: g.maxLen,
    seamMult: g.seamMult,
    players: g.players,
    scores: [...g.scores],
    turn: g.turn,
    ply: g.ply,
    history: [...g.history],
    over: g.over,
  };
}

/** The word a move spells, or '' if the move is out of range. */
export function wordAt(st: Strand, i: number, len: number): string {
  if (i < 0 || len < 1 || i + len > st.letters.length) return '';
  let w = '';
  for (let k = 0; k < len; k++) w += st.letters[i + k];
  return w;
}

/**
 * Does a cut of `len` letters at `i` cover a seam?
 *
 * Only seams strictly INSIDE the word count — `seam[i]` is the join at the word's
 * left edge, which the word butts against rather than spans. Bridging is the
 * whole point: you have to *use* the join, not stand next to it.
 */
export function spansSeam(st: Strand, i: number, len: number): boolean {
  for (let k = i + 1; k < i + len; k++) if (st.seam[k]) return true;
  return false;
}

/** Points for a cut. Length squared, doubled if it bridges a seam. */
export function scoreOf(len: number, spanned: boolean, seamMult = SEAM_MULT): number {
  return len * len * (spanned ? seamMult : 1);
}

export function isLegal(g: GameState, m: Move): boolean {
  if (g.over) return false;
  const st = g.strands[m.s];
  if (!st) return false;
  if (m.len < g.minLen) return false;
  if (m.len > g.maxLen) return false;
  const w = wordAt(st, m.i, m.len);
  return w.length === m.len && isWord(w);
}

/**
 * Every legal cut, in a stable order (strand, then index, then length).
 *
 * Stable because it is also the tiebreak for the host's auto-play on a turn
 * timeout: every peer must derive the same forced move from the same board, or
 * a slow player desyncs the room.
 */
export function legalCuts(g: GameState): Move[] {
  const out: Move[] = [];
  if (g.over) return out;
  for (let s = 0; s < g.strands.length; s++) {
    const st = g.strands[s];
    const n = st.letters.length;
    for (let i = 0; i < n; i++) {
      let w = '';
      const max = Math.min(g.maxLen, n - i);
      for (let len = 1; len <= max; len++) {
        w += st.letters[i + len - 1];
        if (len >= g.minLen && isWord(w)) out.push({ s, i, len });
      }
    }
  }
  return out;
}

export function hasLegalCut(g: GameState): boolean {
  if (g.over) return false;
  for (let s = 0; s < g.strands.length; s++) {
    const st = g.strands[s];
    const n = st.letters.length;
    for (let i = 0; i < n; i++) {
      let w = '';
      const max = Math.min(g.maxLen, n - i);
      for (let len = 1; len <= max; len++) {
        w += st.letters[i + len - 1];
        if (len >= g.minLen && isWord(w)) return true;
      }
    }
  }
  return false;
}

/**
 * Cut `len` letters at `i` out of `st`, returning the spliced strand.
 *
 * The seam bookkeeping is the fiddly half of the game and is worth spelling out:
 *
 *  - Seams strictly inside the cut vanish with the letters that carried them.
 *  - A NEW seam appears at the junction, but ONLY when the cut was interior —
 *    letters remain on both sides. Cutting off an end just shortens the strand;
 *    there is no join, so there is nothing to bridge later.
 *  - `seam[0]` is forced false. When the cut starts at 0 the surviving array
 *    inherits `seam[len]`, a join whose left-hand letter was just removed.
 */
export function spliceStrand(st: Strand, i: number, len: number): Strand {
  const letters = [...st.letters.slice(0, i), ...st.letters.slice(i + len)];
  const seam = [...st.seam.slice(0, i), ...st.seam.slice(i + len)];
  // Interior  <=>  i > 0 (something on the left) && i < seam.length (something on the right).
  if (i > 0 && i < seam.length) seam[i] = true;
  if (seam.length) seam[0] = false;
  return { letters, seam };
}

export interface ApplyResult {
  state: GameState;
  played: PlayedMove;
}

/**
 * Draw `n` fresh letters onto the tail of a strand.
 *
 * ── THE SPOOL, and why the game has one ─────────────────────────────────────
 * The first design let the strand simply run out, and the balance sim killed it
 * in one run. Three failures, all the same failure:
 *
 *   1. A round lasted 3.7 cuts. A greedy player spends ~6 letters a bite, so a
 *      26-letter board is three moves — there was no game to have an opinion
 *      about.
 *   2. Seat 0 won 90-95%. The killer was not "moving first is nice": with so few
 *      cuts, the ply count is frequently ODD, so seat 0 literally takes one more
 *      cut than seat 1. That is not a bias to tune away, it is a missing rule.
 *   3. The signature mechanic fired on 6-12% of cuts. Seams need a board that
 *      survives long enough to accumulate them, and this one never did.
 *
 * Capping the cut length (the obvious fix) moved seat 0 to 64% of decided games
 * and no further, because the parity problem is untouched by it. Lengthening the
 * strand hits a hard wall too — the tiles have to fit a 375px phone.
 *
 * So the strand is a RIBBON, not a board: whatever you cut is replaced from the
 * spool at the tail. The board stays a constant, phone-sized ~26 tiles; the round
 * is a fixed number of cuts EACH, so the parity problem is gone by construction
 * rather than by compensation; and seams accumulate in the surviving middle while
 * fresh letters arrive at the end, which gives the strand a natural gradient —
 * the old end is seam-rich and valuable, the new end is cheap. It also makes the
 * game's name literal.
 */
function drawFrom(st: Strand, spool: string, at: number, n: number): { st: Strand; at: number } {
  const take = spool.slice(at, at + n);
  if (!take) return { st, at };
  return {
    st: {
      letters: [...st.letters, ...take],
      // The spool is one continuous ribbon, so arriving letters carry no seam —
      // a seam is something a PLAYER made, and that is what makes it worth double.
      seam: [...st.seam, ...new Array(take.length).fill(false)],
    },
    at: at + take.length,
  };
}

/**
 * Cut `len` letters at `i` and splice `len` fresh ones from the spool INTO the
 * gap, so the strand keeps its length and the join lands where the play is.
 *
 * ── WHY THE REFILL MOVED FROM THE TAIL TO THE CUT ───────────────────────────
 * Refilling at the tail fixed the round length and the seat parity, and then
 * failed for a reason the outcome metrics could only show as a symptom: 21% of
 * 2-player rounds and up to 100% of 4-player rounds ended DRY — the strand ran
 * out of findable words before anyone had used their cuts.
 *
 * The cause is that cuts happen where words are, and words are where the fresh
 * material is. So the head of the strand silently became a graveyard of
 * unreadable stubs that no cut would ever clear, and the board rotted from the
 * left while the game was played on the right. Seams accumulated in the dead zone
 * too, which is why the signature mechanic was only firing on ~17% of cuts.
 *
 * Splicing the new thread in AT the cut fixes all of it at once, and it is the
 * better story anyway: you cut a word out and fresh thread goes in, so the join
 * is something you MADE and it sits exactly where you were working. An interior
 * cut therefore leaves TWO joins — old-to-new on each side.
 */
function spliceIn(st: Strand, i: number, len: number, fresh: string): Strand {
  const take = [...fresh];
  const left = st.letters.slice(0, i);
  const right = st.letters.slice(i + len);
  const seamLeft = st.seam.slice(0, i);
  const seamRight = st.seam.slice(i + len);

  // Fresh thread carries no internal seam — it is one continuous run off the
  // spool. Its FIRST letter is a join, but only if there is old thread to its
  // left to be joined to.
  const seamFresh = take.map((_, k) => k === 0 && left.length > 0);
  // The old thread on the right is now joined to fresh thread: that is a seam,
  // whatever it was before. (`seamRight[0]` was the join before the cut word,
  // whose left-hand letter has just gone.)
  if (seamRight.length) seamRight[0] = take.length > 0 || left.length > 0;

  const seam = [...seamLeft, ...seamFresh, ...seamRight];
  if (seam.length) seam[0] = false;
  return { letters: [...left, ...take, ...right], seam };
}

/** Apply a legal cut. Throws on an illegal one — callers validate first. */
export function applyCut(g: GameState, m: Move, player = g.turn): ApplyResult {
  if (!isLegal(g, m)) throw new Error(`illegal cut ${JSON.stringify(m)}`);
  const st = g.strands[m.s];
  const word = wordAt(st, m.i, m.len);
  const spanned = spansSeam(st, m.i, m.len);
  const value = scoreOf(m.len, spanned, g.seamMult);

  const next = cloneState(g);
  const spool = g.spools[m.s] ?? '';
  if (g.refill === 'mix') {
    // The shipped refill. One guaranteed SHORT word (exactly `minLen`) so the
    // board can never dry out, plus ribbon off the spool to make the length back
    // up so the strand keeps its size.
    //
    // The guaranteed word is deliberately the SHORTEST legal one, and that is the
    // whole point of the design. `refill: 'word'` — splicing back a word as long
    // as the one you cut — measured beautifully on every safety metric (dry 0%,
    // seats 38.0/39.5, blowouts 0%) and was a dead game: 23% of rounds were
    // DRAWS, rising to 100% at seamMult 1, because a greedy player simply took a
    // six-letter word every single turn and was handed another one. Both players
    // scored an identical 36 a turn, 16 turns running. The seam rule fired on 15%
    // of cuts because nobody ever needed to look for a bridge.
    //
    // So the free move is worth 9 and everything above it has to be found.
    const head = refillWord(g.refillSeed, m.s, g.draws[m.s], g.minLen);
    const need = Math.max(0, m.len - head.length);
    let tail = spool.slice(g.spoolAt[m.s], g.spoolAt[m.s] + need);
    // The strand's LENGTH is an invariant — the board is the same size on the
    // last cut as on the first, which is what makes it fit a phone and what makes
    // "a fixed number of cuts each" a fair round rather than a shrinking one. So
    // a spool that has run short (or was never supplied, as in a unit test) is
    // topped up from the word pool rather than quietly returning a shorter strand.
    if (tail.length < need) {
      tail = (tail + refillWord(g.refillSeed, m.s, g.draws[m.s] + 0x5f5e1, g.minLen)).slice(0, need);
    }
    next.strands[m.s] = spliceIn(st, m.i, m.len, (head + tail).slice(0, m.len));
    next.draws[m.s] = g.draws[m.s] + 1;
    next.spoolAt[m.s] = g.spoolAt[m.s] + Math.min(need, Math.max(0, spool.length - g.spoolAt[m.s]));
  } else if (g.refill === 'word') {
    // A WHOLE common word goes in, exactly as long as the cut. See the note on
    // `spliceIn`: this is what guarantees the board can never dry out, and it
    // guarantees it cheaply — the fresh word carries no seam INSIDE it, so the
    // move it hands you is always the base-value one. Every doubled play still
    // has to be found by bridging.
    next.strands[m.s] = spliceIn(st, m.i, m.len, refillWord(g.refillSeed, m.s, g.draws[m.s], m.len));
    next.draws[m.s] = g.draws[m.s] + 1;
  } else if (g.refill === 'inline') {
    next.strands[m.s] = spliceIn(st, m.i, m.len, spool.slice(g.spoolAt[m.s], g.spoolAt[m.s] + m.len));
    next.spoolAt[m.s] = g.spoolAt[m.s] + m.len;
  } else if (g.refill === 'tail') {
    const drawn = drawFrom(spliceStrand(st, m.i, m.len), spool, g.spoolAt[m.s], m.len);
    next.strands[m.s] = drawn.st;
    next.spoolAt[m.s] = drawn.at;
  } else {
    next.strands[m.s] = spliceStrand(st, m.i, m.len);
  }
  next.scores[player] += value;
  const played: PlayedMove = { ...m, word, player, spannedSeam: spanned, value, ply: g.ply };
  next.history.push(played);
  next.ply = g.ply + 1;
  next.turn = seatAt(g.order, g.players, next.ply);
  // Two ways a round ends, and only one of them is normal:
  //  - everyone has taken their `turnsEach` cuts. This is the design.
  //  - the strand went dry. Rare (a refilled 26-letter strand almost always has
  //    a 3-letter word in it) but it MUST end the round rather than hang, and it
  //    is the one path that can hand one seat an extra cut — so the sim measures
  //    how often it happens rather than assuming it does not.
  next.over = next.ply >= g.turnsEach * g.players || !hasLegalCut(next);
  return { state: next, played };
}

/** Cuts this player has left. */
export function cutsLeft(g: GameState, player: number): number {
  const used = g.history.filter((h) => h.player === player).length;
  return Math.max(0, g.turnsEach - used);
}

/** True when the round ended early because nobody could cut. */
export function endedDry(g: GameState): boolean {
  return g.over && g.ply < g.turnsEach * g.players;
}

/** Total letters left across every strand. */
export function lettersLeft(g: GameState): number {
  return g.strands.reduce((n, s) => n + s.letters.length, 0);
}

/** Seams currently on the board. */
export function seamCount(g: GameState): number {
  return g.strands.reduce((n, s) => n + s.seam.filter(Boolean).length, 0);
}

/** Winning player indices (plural on a tie). Empty while the round runs. */
export function leaders(g: GameState): number[] {
  const best = Math.max(...g.scores);
  return g.scores.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
}
