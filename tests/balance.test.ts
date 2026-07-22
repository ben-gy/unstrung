/**
 * balance.test.ts — is it still a game on move four?
 *
 * Principle #18. Written BEFORE any tuning, and it overruled the design five
 * times. The log, because the numbers are the only reason to believe the rules:
 *
 *  1. THE FIRST BUILD WAS NOT A GAME. A strand you simply consume lasted 3.7
 *     cuts — a greedy player spends ~6 letters a bite, so 26 letters is three
 *     moves. Seat 0 won 90-95%, and the signature seam rule fired on 6-12% of
 *     cuts because the board never survived long enough to accumulate any joins.
 *     Every one of those is invisible to a unit test; the game "worked" fine.
 *
 *  2. THE OBVIOUS FIX WAS NOT ENOUGH. Capping the cut length (max 4, strand 44)
 *     took seat 0 from 90% to 64% of decided games and stopped there — because
 *     the real killer was never "moving first is nice", it was that the ply count
 *     is frequently ODD, so seat 0 literally takes one more cut than seat 1. That
 *     is a missing rule, not a bias to tune. Hence a fixed number of cuts EACH.
 *
 *  3. REFILLING FROM THE TAIL ROTTED THE BOARD. Making the strand a ribbon that
 *     refills fixed round length and parity, and then 21% of 2-player and up to
 *     100% of 4-player rounds ended DRY. Cuts happen where words are and words
 *     are where the fresh material is, so the head of the strand became a
 *     graveyard of stubs that no cut ever cleared. Splicing fresh thread in AT
 *     the cut instead took the seam share from 17% to 46% at a stroke.
 *
 *  4. THE FIX THAT MEASURED PERFECTLY WAS A DEAD GAME. Splicing back a word as
 *     long as the one cut scored 0% dry, 0% blowouts and seats of 38.0/39.5 —
 *     and 23% of rounds were DRAWS, rising to 100% at seamMult 1, because both
 *     players simply took a six-letter word every turn and were handed another.
 *     No outcome-safety metric could see it; the draw rate could. The refill is
 *     now a guaranteed SHORT word plus ribbon, so the free move is worth 9.
 *
 *  5. SNAKE DRAFT — the textbook fix for first-pick advantage — OVERSHOT. At four
 *     players it did not remove the bias, it moved it to the other end of the
 *     table and made it bigger (24/28/27/17 cycling vs 15/22/25/33 snaking),
 *     because the seam ramp is already doing that job. Plain cycling ships.
 *
 * What actually carries the balance is the seam multiplier, and that is a genuine
 * design result rather than a dial: a seam is something the PREVIOUS player made,
 * so paying double for bridging one is a transfer from whoever moved before you.
 * See the sweep pinned in `the seam multiplier is what makes it fair`.
 */

import { describe, expect, it } from 'vitest';
import { runSweep, summarise, type Cfg, type Curve } from './helpers/sim';
import { allModes, turnsFor, type Mode } from '../src/modes';
import { SEAM_MULT } from '../src/game';
import type { Strength } from '../src/bot';

const N = 250;
const MARKS = [2, 4, 8, 16];

function cfgFor(mode: Mode, seats: number): Cfg {
  return {
    letters: mode.letters,
    minLen: mode.minLen,
    maxLen: mode.maxLen,
    turnsEach: turnsFor(mode, seats),
  };
}

function measure(mode: Mode, seats: number, seedBase = 1, n = N): Curve {
  const rs = runSweep(cfgFor(mode, seats), new Array(seats).fill('fair') as Strength[], n, seedBase);
  return summarise(rs, MARKS);
}

describe('balance: the shape of a round', () => {
  for (const mode of allModes()) {
    for (const seats of [2, 3, 4]) {
      describe(`${mode.id}, ${seats} players`, () => {
        const c = measure(mode, seats);

        it('gives every seat close to its fair share', () => {
          const chance = 100 / seats;
          // The bound widens with the table, and that is a finding rather than a
          // convenience. Two and three players are genuinely even. FOUR is the
          // loosest configuration this game has: seat 3 lands around 18% against
          // a 25% share, and it REPLICATED across three independent seed families
          // at n=300-400, so it is signal, not noise.
          //
          // It is recorded rather than tuned away because both textbook fixes
          // were measured and both made it WORSE (see `TurnOrder`): snake draft
          // moved the bias to the far end of the table and enlarged it, and
          // rotating the start seat — which is fair by construction on pick order
          // — collapsed seat 0 to 13%. That result says the residue is not made
          // of pick order at all, so a pick-order fix cannot remove it, and
          // inventing a compensation nobody can justify would be worse than a
          // known, bounded, documented imperfection at the largest table size.
          //
          // At n=250 the 95% CI on one seat is already about +/-5.5 points, so a
          // much tighter bound would be testing the sampler rather than the game.
          const bound = seats === 2 ? 7 : seats === 3 ? 7 : 10;
          for (const [i, pct] of c.seatWinPct.entries()) {
            expect(
              Math.abs(pct - chance),
              `seat ${i} at ${pct.toFixed(1)}% vs ${chance.toFixed(1)}% (bound ${bound})`,
            ).toBeLessThan(bound);
          }
        });

        it('never leaves a seat below two-thirds of its fair share', () => {
          // The floor that the widened four-player bound must not be allowed to
          // erode into. Hexbloom shipped a three-player game whose third seat won
          // one game in ten; this is the assertion that would have caught it.
          const chance = 100 / seats;
          const worst = Math.min(...c.seatWinPct);
          expect(worst, `worst seat ${worst.toFixed(1)}% vs ${chance.toFixed(1)}%`).toBeGreaterThan(chance * 0.62);
        });

        it('is not decided by the opening', () => {
          // The leader after ONE cut each must be close to a coin flip. If this
          // reads 90 the game is a slot machine dressed as a word game — which is
          // exactly what the first build measured.
          expect(c.leaderWins[2]).toBeLessThan(0.72);
          // ...and the curve has to RISE, or there is no drama to arrive at.
          expect(c.leaderWins[16]).toBeGreaterThan(c.leaderWins[2]);
        });

        it('rarely turns into a rout', () => {
          expect(c.blowoutRate).toBeLessThan(0.15);
        });

        it('always runs the full round and never dries out', () => {
          // Both are structural, so zero tolerance. A dry board would hand one
          // seat an extra cut and quietly reopen the parity bug from failure #2.
          expect(c.dryRate).toBe(0);
          expect(c.avgPlies).toBe(turnsFor(mode, seats) * seats);
        });

        it('actually fires the signature mechanic', () => {
          // Principle #21's lesson in one assertion: an outcome metric cannot
          // tell a live mechanic from a dead one. If seam-spanning words stopped
          // happening, every number above would still look fine and the game
          // would be a plain word hunt.
          expect(c.seamShare).toBeGreaterThan(0.08);
        });
      });
    }
  }
});

describe('balance: the seam multiplier is what makes it fair', () => {
  /**
   * The load-bearing sweep. Two players, `strand`, everything else identical,
   * n=250 — only SEAM_MULT moves:
   *
   *    x1  seat 0 wins ~77%     (and the seam rule is decoration)
   *    x2  seat 0 wins ~63%
   *    x3  seat 0 wins ~52%     <- shipped
   *
   * This is the assertion that stops someone "simplifying" the rule back to
   * doubling because it reads better in the how-to-play.
   */
  it('is pinned at 3', () => {
    expect(SEAM_MULT).toBe(3);
  });

  it('measurably beats a smaller multiplier at cancelling first-mover advantage', () => {
    const mode = allModes()[0];
    const base = cfgFor(mode, 2);
    const at = (seamMult: number): number =>
      summarise(runSweep({ ...base, seamMult }, ['fair', 'fair'], N), MARKS).seatWinPct[0];
    const one = at(1);
    const three = at(3);
    expect(one, `x1 gave seat 0 ${one.toFixed(1)}%`).toBeGreaterThan(70);
    expect(three, `x3 gave seat 0 ${three.toFixed(1)}%`).toBeLessThan(58);
    expect(one - three).toBeGreaterThan(12);
  });
});

describe('balance: skill is worth more than luck', () => {
  /**
   * The check that says the game has content. `sharp` differs from `fair` in
   * exactly one way — it subtracts what the cut hands the next player — so if it
   * did not win, "what you leave behind" would be a story rather than a mechanic.
   */
  for (const mode of allModes()) {
    it(`${mode.id}: thinking about what you leave beats grabbing`, () => {
      const cfg = cfgFor(mode, 2);
      const first = summarise(runSweep(cfg, ['sharp', 'fair'], N), MARKS).seatWinPct[0];
      const second = summarise(runSweep(cfg, ['fair', 'sharp'], N), MARKS).seatWinPct[1];
      // Asserted from BOTH seats, so a seat effect can never be read as skill.
      expect(first, `sharp in seat 0 won ${first.toFixed(1)}%`).toBeGreaterThan(60);
      expect(second, `sharp in seat 1 won ${second.toFixed(1)}%`).toBeGreaterThan(60);
    });

    it(`${mode.id}: playing well beats playing at random`, () => {
      const cfg = cfgFor(mode, 2);
      const c = summarise(runSweep(cfg, ['fair', 'loose'], N), MARKS);
      expect(c.seatWinPct[0]).toBeGreaterThan(90);
    });
  }
});
