/**
 * palette.ts — every colour that carries meaning, in one place.
 *
 * Principle #22: a colour literal inlined in a renderer cannot be pinned by a
 * test, and an invisible game piece looks exactly like atmosphere in a
 * screenshot. So every mark that means something lives here, and
 * `tests/contrast.test.ts` holds each one to >= 3:1 against every surface it is
 * actually drawn on (WCAG 2.1 SS1.4.11, the floor for a non-text graphic).
 *
 * Two rules the palette itself has to respect, beyond the ratios:
 *
 *  - **Nothing is carried by colour alone.** A seam is an amber bar AND a notch
 *    in the tile edge. A selected tile is a dark teal fill AND raised. A player
 *    is a colour AND a numeral badge. Validity is TEXT ("not in word list"), not
 *    a red/green swap — red-vs-green selection is the classic deuteranopia trap
 *    and would have been unreadable for the people it matters most to.
 *  - **Selection had to be DARK teal.** The obvious bright teal (#3fc4b0) sits at
 *    1.69:1 against a bone tile — it reads as "the tile went slightly minty",
 *    which is not a selection. #0f8577 clears both the tile it replaces (3.50:1)
 *    and the board behind it (3.88:1).
 */

export const PALETTE = {
  /** The board behind everything. */
  bg: '#151a21',
  /** Panels, HUD strips, modals — the second surface a mark can sit on. */
  panel: '#1e2530',

  /** A letter tile at rest. */
  tile: '#e8e2d4',
  /** The glyph printed on a resting tile. */
  tileInk: '#14181d',

  /** A tile inside the current selection. */
  sel: '#0f8577',
  /** The glyph printed on a selected tile. */
  selInk: '#e8e2d4',

  /** The seam: the permanent join left behind by an interior cut. */
  seam: '#f0a92e',

  /** Body text on bg/panel. */
  text: '#e8e2d4',
  /** Secondary text — also the "inert / not a word" chip. */
  muted: '#9aa4b2',

  /** Player marks, versus. Each also carries a numeral, so colour is a shortcut,
   *  never the message. Chosen for distinct hue AND distinct luminance. */
  p1: '#f0a92e',
  p2: '#4fd8c2',
  p3: '#b79bff',
  p4: '#ff8fa8',
} as const;

export type PaletteKey = keyof typeof PALETTE;

export const PLAYER_COLOURS = [PALETTE.p1, PALETTE.p2, PALETTE.p3, PALETTE.p4] as const;

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio between two #rrggbb colours. 1 = identical, 21 = max. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
