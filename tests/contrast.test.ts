/**
 * contrast.test.ts — every mark that means something, measured (principle #22).
 *
 * "Screenshot it and look" cannot see an invisible game piece. A sibling game
 * rendered its walls at 1.14:1 against the board — drawn, in the right cells, at
 * the right size, and completely invisible — and every existing gate passed,
 * because they are all GEOMETRY checks (overflow, overlap, hit size, clipping)
 * and a shape that is on-screen, correctly sized and the same colour as its
 * background satisfies all of them. On a deliberately moody dark palette, an
 * invisible piece reads as atmosphere and the screenshot looks great.
 *
 * So: every colour that carries meaning is held to >= 3:1 against every surface it
 * is actually drawn on — WCAG 2.1 SS1.4.11, the floor for a non-text graphic.
 *
 * This test also caught a real one here. The obvious selection colour (a bright
 * teal, #3fc4b0) sits at 1.69:1 against a bone tile: a selected tile would have
 * read as "slightly minty", which is not a selection. The shipped #0f8577 clears
 * both the tile it replaces and the board behind it.
 */

import { describe, expect, it } from 'vitest';
import { PALETTE, PLAYER_COLOURS, contrast, luminance } from '../src/palette';

const MIN = 3;

/** Surfaces a mark can be painted on. */
const SURFACES = { board: PALETTE.bg, panel: PALETTE.panel } as const;

describe('contrast: the play surface', () => {
  const cases: Array<[string, string, string, number]> = [
    // A letter tile is the piece. It sits on the board.
    ['letter tile', PALETTE.tile, SURFACES.board, MIN],
    ['letter tile', PALETTE.tile, SURFACES.panel, MIN],
    // Its glyph is text ON the tile — 4.5:1, the text floor, not the graphic one.
    ['tile glyph', PALETTE.tileInk, PALETTE.tile, 4.5],
    // A SELECTED tile has to differ from an unselected one AND still read as a
    // tile against the board. Both, or the selection is invisible in one context.
    ['selected tile vs unselected', PALETTE.sel, PALETTE.tile, MIN],
    ['selected tile vs board', PALETTE.sel, SURFACES.board, MIN],
    ['selected glyph', PALETTE.selInk, PALETTE.sel, MIN],
    // The seam bar is painted in the GAP between tiles, i.e. on the board. It is
    // deliberately never painted on a tile: amber on bone is 1.57:1, which is the
    // exact failure this file exists to catch.
    ['seam bar', PALETTE.seam, SURFACES.board, MIN],
    ['seam bar', PALETTE.seam, SURFACES.panel, MIN],
    ['body text', PALETTE.text, SURFACES.board, 4.5],
    ['body text', PALETTE.text, SURFACES.panel, 4.5],
    ['muted text', PALETTE.muted, SURFACES.board, 4.5],
    ['muted text', PALETTE.muted, SURFACES.panel, 4.5],
    // The primary button and the seam chip print dark ink on amber.
    ['ink on amber', PALETTE.tileInk, PALETTE.seam, 4.5],
  ];

  for (const [what, fg, bg, min] of cases) {
    it(`${what} clears ${min}:1 on ${bg}`, () => {
      const r = contrast(fg, bg);
      expect(r, `${what}: ${fg} on ${bg} measured ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
    });
  }
});

describe('contrast: player marks', () => {
  for (const [i, colour] of PLAYER_COLOURS.entries()) {
    it(`player ${i + 1} is visible on both surfaces`, () => {
      for (const [name, surface] of Object.entries(SURFACES)) {
        const r = contrast(colour, surface);
        expect(r, `p${i + 1} ${colour} on ${name}: ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN);
      }
    });

    it(`player ${i + 1}'s numeral is readable on its own badge`, () => {
      // The badge is a filled disc with the seat NUMBER on it. That numeral is
      // what actually identifies the player; the colour is a shortcut.
      const r = contrast(PALETTE.tileInk, colour);
      expect(r, `numeral on p${i + 1}: ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });
  }

  /**
   * Deliberately NOT asserted: that the four player colours are distinguishable
   * from one another by luminance. They are not — p1 (amber) and p4 (rose) sit at
   * 1.06:1 apart, differing almost entirely in hue.
   *
   * That is a conscious choice rather than an oversight, and it is only safe
   * because colour is never the message: every player mark carries its seat
   * NUMERAL, asserted in ui.test.ts. Two sibling games shipped a palette whose
   * own colour-blind-safety claim was false precisely because the two sides were
   * the same shade of grey — the difference here is that removing all four
   * colours would lose nothing but decoration.
   */
  it('records that player colours are hue-separated, not luminance-separated', () => {
    const ls = PLAYER_COLOURS.map(luminance);
    const spread = Math.max(...ls) - Math.min(...ls);
    expect(spread).toBeLessThan(0.2);
  });
});
