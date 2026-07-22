/**
 * tests/helpers/sim.ts — headless AI-vs-AI matches, plus the event stream the
 * mechanism audit reads.
 *
 * Two jobs, kept apart on purpose:
 *
 *  - `playMatch` runs the REAL reducer from `src/game.ts`. Nothing about the
 *    rules is re-implemented here, so a balance number is a number about the
 *    shipped game.
 *  - the audit in `mechanism.test.ts` re-derives every invariant from its OWN
 *    constants and NEVER imports `scoreOf`/`spansSeam`. That is the whole point:
 *    an audit that checks the game's arithmetic against the game's arithmetic is
 *    a tautology that stays green when you mutate the formula.
 *
 * `Cfg` is deliberately a loose bag of numbers rather than a `Mode`, so a sweep
 * can move one knob at a time against configurations that are NOT shipped. Every
 * shipped mode converts to one via `cfgOf`.
 */

import { applyCut, createGame, type PlayedMove, type RefillMode, type TurnOrder } from '../../src/game';
import { dealStrands } from '../../src/strand';
import { chooseCut, type Strength } from '../../src/bot';
import { modeOf, type Mode } from '../../src/modes';
import { makeRng } from '@ben-gy/game-engine/rng';

export interface Cfg {
  letters: number[];
  minLen: number;
  maxLen: number;
  turnsEach: number;
  seamMult?: number;
  refill?: RefillMode;
  order?: TurnOrder;
}

export function cfgOf(modeId: string): Cfg {
  const m: Mode = modeOf(modeId);
  return { letters: m.letters, minLen: m.minLen, maxLen: m.maxLen, turnsEach: m.turnsEach };
}

export interface MatchSpec {
  cfg: Cfg;
  seed: number | string;
  /** One policy per seat. Seat count comes from this array's length. */
  policies: Strength[];
}

export interface MatchResult {
  scores: number[];
  /** Winning seat, or null on a tie. */
  winner: number | null;
  leaders: number[];
  plies: number;
  history: PlayedMove[];
  /** Score margin between first and second. */
  margin: number;
  /** Letters remaining when the round ended. */
  lettersLeft: number;
  /** True when the round ended early because the strand went dry. */
  dry: boolean;
  /** The dealt strands, so an audit can replay from the deal. */
  deal: string[];
  cfg: Cfg;
}

export function playMatch(spec: MatchSpec): MatchResult {
  const { cfg } = spec;
  const players = spec.policies.length;
  const woven = dealStrands({
    seed: spec.seed,
    letters: cfg.letters,
    minLen: cfg.minLen,
    maxLen: cfg.maxLen,
    turnsEach: cfg.turnsEach,
    players,
  });
  let g = createGame({
    strands: woven.strands,
    spools: woven.spools,
    turnsEach: cfg.turnsEach,
    minLen: cfg.minLen,
    maxLen: cfg.maxLen,
    seamMult: cfg.seamMult,
    refill: cfg.refill,
    order: cfg.order,
    refillSeed: typeof spec.seed === 'number' ? spec.seed : 1,
    players,
  });
  const rng = makeRng(`bot:${spec.seed}`);

  let guard = 0;
  while (!g.over && guard++ < 500) {
    const m = chooseCut(g, spec.policies[g.turn], rng);
    if (!m) break;
    g = applyCut(g, m).state;
  }

  const best = Math.max(...g.scores);
  const leaders = g.scores.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
  const sorted = [...g.scores].sort((a, b) => b - a);
  return {
    scores: g.scores,
    winner: leaders.length === 1 ? leaders[0] : null,
    leaders,
    plies: g.ply,
    history: g.history,
    margin: sorted[0] - (sorted[1] ?? 0),
    lettersLeft: g.strands.reduce((n, s) => n + s.letters.length, 0),
    dry: g.ply < cfg.turnsEach * players,
    deal: woven.strands,
    cfg,
  };
}

/** Who is ahead after `n` plies, or null if tied (or the game was shorter). */
export function leaderAfter(r: MatchResult, n: number): number | null {
  if (r.plies < n) return null;
  const tally: number[] = new Array(r.scores.length).fill(0);
  for (let i = 0; i < n; i++) tally[r.history[i].player] += r.history[i].value;
  const best = Math.max(...tally);
  const tied = tally.map((v, i) => (v === best ? i : -1)).filter((i) => i >= 0);
  return tied.length === 1 ? tied[0] : null;
}

export interface Curve {
  /** P(the seat leading after N plies eventually wins), N -> probability. */
  leaderWins: Record<number, number>;
  /** How many games each ply-mark could be measured on. NaN guards a lie. */
  leaderN: Record<number, number>;
  /** Per-seat win rate, as a percentage. Ties count as a win for nobody. */
  seatWinPct: number[];
  /** Fraction of DECIDED games whose margin exceeded `blowoutAt` x the top score. */
  blowoutRate: number;
  drawRate: number;
  avgPlies: number;
  avgTotal: number;
  /** Fraction of all cuts that scored double. The signature mechanic's pulse. */
  seamShare: number;
  /** Average cut length — how fast the strand is being spent. */
  avgCutLen: number;
  /** Fraction of rounds that ended early because the strand went dry. */
  dryRate: number;
  n: number;
}

export function summarise(results: MatchResult[], plyMarks: number[], blowoutAt = 0.5): Curve {
  const n = results.length;
  const seats = results[0].scores.length;
  const seatWins: number[] = new Array(seats).fill(0);
  let draws = 0;
  let blowouts = 0;
  let decided = 0;
  let plies = 0;
  let total = 0;
  let cuts = 0;
  let seamCuts = 0;
  let cutLetters = 0;
  let dry = 0;

  for (const r of results) {
    if (r.dry) dry++;
    if (r.winner == null) draws++;
    else {
      seatWins[r.winner]++;
      decided++;
      const top = Math.max(...r.scores);
      if (r.margin > blowoutAt * top) blowouts++;
    }
    plies += r.plies;
    total += r.scores.reduce((a, b) => a + b, 0);
    for (const h of r.history) {
      cuts++;
      cutLetters += h.len;
      if (h.spannedSeam) seamCuts++;
    }
  }

  const leaderWins: Record<number, number> = {};
  const leaderN: Record<number, number> = {};
  for (const mark of plyMarks) {
    let hits = 0;
    let seen = 0;
    for (const r of results) {
      const lead = leaderAfter(r, mark);
      if (lead == null) continue;
      seen++;
      if (r.winner === lead) hits++;
    }
    leaderN[mark] = seen;
    leaderWins[mark] = seen ? hits / seen : NaN;
  }

  return {
    leaderWins,
    leaderN,
    seatWinPct: seatWins.map((w) => (100 * w) / n),
    blowoutRate: decided ? blowouts / decided : 0,
    drawRate: draws / n,
    avgPlies: plies / n,
    avgTotal: total / n,
    seamShare: cuts ? seamCuts / cuts : 0,
    avgCutLen: cuts ? cutLetters / cuts : 0,
    dryRate: dry / n,
    n,
  };
}

export function runSweep(cfg: Cfg, policies: Strength[], n: number, seedBase = 1): MatchResult[] {
  const out: MatchResult[] = [];
  for (let i = 0; i < n; i++) out.push(playMatch({ cfg, seed: seedBase + i * 7919, policies }));
  return out;
}

export function fmt(c: Curve): string {
  const lw = Object.entries(c.leaderWins)
    .map(([k, v]) => `m${k}=${Number.isNaN(v) ? '--' : (100 * v).toFixed(0)}(${c.leaderN[Number(k)]})`)
    .join(' ');
  return (
    `seats=[${c.seatWinPct.map((v) => v.toFixed(1)).join(',')}] draw=${(100 * c.drawRate).toFixed(0)}% ` +
    `${lw} blow=${(100 * c.blowoutRate).toFixed(0)}% plies=${c.avgPlies.toFixed(1)} ` +
    `cutLen=${c.avgCutLen.toFixed(1)} seam=${(100 * c.seamShare).toFixed(0)}% dry=${(100 * c.dryRate).toFixed(0)}% n=${c.n}`
  );
}
