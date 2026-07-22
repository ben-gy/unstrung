/**
 * input.test.ts — the selection gesture, and the one thing it must never depend
 * on.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * The first build hit-tested `pointerdown` with `document.elementFromPoint`. In
 * a two-tab smoke test the guest's taps were silently dropped: the board was
 * visible, the HUD said "Your turn", the chip said "Drag across letters", the
 * console was clean — and `elementFromPoint` was returning **null**, because the
 * tab was not the foregrounded one. No unit test could see it, no screenshot
 * could see it, and the symptom is indistinguishable from "the game is frozen".
 *
 * It is the same shape as a sibling game's input bug (cell geometry computed
 * inside the rAF draw, so every tap before the first frame was dropped): input
 * must not depend on anything about how or whether the page is being painted.
 *
 * The fix is that `pointerdown` reads `event.target`, which IS the tile the
 * finger landed on. jsdom has no layout engine and its `elementFromPoint` always
 * returns null — so this file reproduces the broken environment exactly, and a
 * revert to hit-testing turns it red.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createStrandView, selectionValue, selectionWord, type Selection } from '../src/render';
import { applyCut, createGame, type GameState, type Move } from '../src/game';

function board(letters = 'PLANTERMSHAPEDGEARLY'): GameState {
  return createGame({
    strands: [letters],
    turnsEach: 20,
    minLen: 3,
    maxLen: 5,
    players: 1,
    refillSeed: 8,
  });
}

/** jsdom does not always ship PointerEvent; MouseEvent + pointerId is enough. */
function pointer(type: string, target: Element | Window, pointerId = 1): Event {
  const Ctor = (globalThis as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  const e = new Ctor(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  if (target instanceof Element) target.dispatchEvent(e);
  else window.dispatchEvent(e);
  return e;
}

let container: HTMLElement;
let g: GameState;
let cuts: Selection[];
let view: ReturnType<typeof createStrandView>;
let selections: Array<Selection | null>;

function mount(state = board(), canPlay = true): void {
  g = state;
  cuts = [];
  selections = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  view = createStrandView({
    container,
    canPlay: () => canPlay,
    onSelect: (s) => selections.push(s),
    onCut: (s) => {
      const m: Move = { s: s.s, i: s.a, len: s.b - s.a + 1 };
      if (!selectionValue(g, s).ok) return false;
      cuts.push(s);
      g = applyCut(g, m).state;
      view.render(g);
      return true;
    },
  });
  view.render(g);
}

const tiles = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('.tile')];

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the strand renders as real elements', () => {
  it('gives every letter its own tile, tagged with its position', () => {
    mount();
    const t = tiles();
    expect(t).toHaveLength(g.strands[0].letters.length);
    expect(t.map((x) => x.textContent).join('')).toBe(g.strands[0].letters.join(''));
    t.forEach((x, i) => {
      expect(x.dataset.s).toBe('0');
      expect(x.dataset.i).toBe(String(i));
    });
  });

  it('marks a seam on the tile that follows it', () => {
    mount();
    const after = applyCut(g, { s: 0, i: 2, len: 4 }).state;
    view.render(after);
    const seamed = tiles().filter((t) => t.classList.contains('seamed'));
    expect(seamed.length).toBeGreaterThan(0);
    for (const t of seamed) expect(after.strands[0].seam[Number(t.dataset.i)]).toBe(true);
  });
});

describe('pointerdown does not depend on hit-testing', () => {
  /**
   * THE regression test. `document.elementFromPoint` returns null throughout this
   * file — jsdom has no layout — which is precisely the condition that broke the
   * real game in a background tab.
   */
  it('confirms elementFromPoint is useless here, as it was in the field', () => {
    // jsdom omits it outright; a background tab returns null from it. Either way
    // a `pointerdown` handler built on it has nothing to work with — which is the
    // environment every test below runs in.
    const fn = document.elementFromPoint as unknown;
    const usable = typeof fn === 'function' && document.elementFromPoint(10, 10) !== null;
    expect(usable).toBe(false);
  });

  it('selects the tile that was pressed', () => {
    mount();
    pointer('pointerdown', tiles()[3]);
    expect(tiles()[3].classList.contains('sel')).toBe(true);
    expect(view.selection()).toEqual({ s: 0, a: 3, b: 3 });
  });

  it('completes a tap-then-tap selection and cuts it', () => {
    mount();
    // PLANT: tiles 0..4
    pointer('pointerdown', tiles()[0]);
    pointer('pointerup', window);
    pointer('pointerdown', tiles()[4]);
    pointer('pointerup', window);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toEqual({ s: 0, a: 0, b: 4 });
  });

  it('cancels when the same single tile is tapped twice', () => {
    mount();
    pointer('pointerdown', tiles()[2]);
    pointer('pointerup', window);
    pointer('pointerdown', tiles()[2]);
    expect(view.selection()).toBeNull();
    expect(cuts).toHaveLength(0);
  });

  it('is completely inert when it is not your turn', () => {
    mount(board(), false);
    pointer('pointerdown', tiles()[0]);
    pointer('pointerup', window);
    pointer('pointerdown', tiles()[4]);
    pointer('pointerup', window);
    expect(view.selection()).toBeNull();
    expect(cuts).toHaveLength(0);
  });

  it('treats pointercancel as an abort, not as a cut', () => {
    mount();
    pointer('pointerdown', tiles()[0]);
    pointer('pointercancel', window);
    pointer('pointerup', window);
    expect(view.selection()).toBeNull();
    expect(cuts).toHaveLength(0);
  });

  it('keeps a selection that is not a word, so a near miss is one tap to fix', () => {
    mount(board('XQZJVPLANT'));
    pointer('pointerdown', tiles()[0]);
    pointer('pointerup', window);
    pointer('pointerdown', tiles()[2]); // XQZ
    pointer('pointerup', window);
    expect(cuts).toHaveLength(0);
    // The selection SURVIVES the rejection.
    expect(view.selection()).toEqual({ s: 0, a: 0, b: 2 });
    expect(selectionWord(g, view.selection())).toBe('XQZ');
    expect(selectionValue(g, view.selection()).ok).toBe(false);
  });
});

describe('the keyboard path', () => {
  it('moves a cursor and extends a selection with it', () => {
    mount();
    view.moveCursor(0, false); // place the cursor at 0
    for (let i = 0; i < 4; i++) view.moveCursor(1, true);
    expect(view.selection()).toEqual({ s: 0, a: 0, b: 4 });
    view.commit();
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toEqual({ s: 0, a: 0, b: 4 });
  });

  it('cannot walk the cursor off the end of the strand', () => {
    mount();
    for (let i = 0; i < 200; i++) view.moveCursor(1, false);
    expect(view.selection()!.a).toBe(g.strands[0].letters.length - 1);
    for (let i = 0; i < 200; i++) view.moveCursor(-1, false);
    expect(view.selection()!.a).toBe(0);
  });
});

describe('re-rendering', () => {
  it('drops a selection that the new board can no longer contain', () => {
    mount();
    pointer('pointerdown', tiles()[tiles().length - 1]);
    expect(view.selection()).not.toBeNull();
    // A shorter strand arrives (a peer's replay, a new round).
    view.render(
      createGame({ strands: ['PLANT'], turnsEach: 5, minLen: 3, maxLen: 5, players: 1, refillSeed: 1 }),
    );
    expect(view.selection()).toBeNull();
  });

  it('detaches every listener on destroy', () => {
    mount();
    view.destroy();
    pointer('pointerdown', tiles()[0]);
    expect(cuts).toHaveLength(0);
  });
});
