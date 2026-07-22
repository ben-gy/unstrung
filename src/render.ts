// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * render.ts — the strand, and the selection gesture over it.
 *
 * DOM, not canvas. This is a tile game made of letters: DOM gives crisp type at
 * any DPR, real 44px hit targets, free reflow when the strand wraps to a new
 * line, and it is accessible without reimplementing a focus ring.
 *
 * Two things here are load-bearing rather than decorative:
 *
 *  - **Input is Pointer Events only**, with `setPointerCapture`, per-pointerId
 *    state, and `pointercancel` treated as an abort. Position comes from
 *    `document.elementFromPoint(clientX, clientY)` — never `offsetX/offsetY`,
 *    which scales strangely under DPR and zoom.
 *  - **Nothing about hit-testing depends on a rendered frame.** Tiles are real
 *    elements, so a tap works before the first paint and in a throttled tab.
 *    (A sibling game computed its cell geometry inside the rAF draw and silently
 *    dropped every tap taken before a frame had run.)
 *
 * Both gestures reach the same place: DRAG across letters, or TAP the first
 * letter then TAP the last. A drag that lands on a real word cuts on release; a
 * tap-tap cuts on the second tap. Anything that is not a word stays selected with
 * an honest chip, so you can adjust rather than start again.
 */

import { PALETTE, PLAYER_COLOURS } from './palette';
import { scoreOf, spansSeam, wordAt, type GameState } from './game';
import { isWord } from './dict';

export interface Selection {
  s: number;
  /** Inclusive, and always `a <= b`. */
  a: number;
  b: number;
}

export interface StrandViewConfig {
  container: HTMLElement;
  /** Fires when a selection is committed. Return true if it was accepted. */
  onCut: (sel: Selection) => boolean;
  /** Fires whenever the live selection changes, for the word chip. */
  onSelect: (sel: Selection | null) => void;
  /** The view is inert when this returns false (not your turn, round over). */
  canPlay: () => boolean;
}

export interface StrandView {
  render(g: GameState, freshKeys?: Set<string>): void;
  selection(): Selection | null;
  clearSelection(): void;
  /** Keyboard: move the cursor, optionally extending the selection. */
  moveCursor(delta: number, extend: boolean): void;
  commit(): void;
  destroy(): void;
}

const span = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);

export function selectionWord(g: GameState, sel: Selection | null): string {
  if (!sel) return '';
  return wordAt(g.strands[sel.s], sel.a, sel.b - sel.a + 1);
}

export function selectionValue(g: GameState, sel: Selection | null): { ok: boolean; value: number; doubled: boolean } {
  const w = selectionWord(g, sel);
  const len = w.length;
  if (!sel || len < g.minLen || len > g.maxLen || !isWord(w)) return { ok: false, value: 0, doubled: false };
  const doubled = spansSeam(g.strands[sel.s], sel.a, len);
  return { ok: true, value: scoreOf(len, doubled, g.seamMult), doubled };
}

export function createStrandView(cfg: StrandViewConfig): StrandView {
  const { container } = cfg;
  let game: GameState | null = null;
  let sel: Selection | null = null;
  /** Set after a single tap, so the NEXT tap closes the span. */
  let armed = false;
  let dragPointer: number | null = null;
  let dragStrand = -1;
  let dragAnchor = -1;
  let moved = false;
  /** Keyboard cursor. Kept in range on every render. */
  let cursor: Selection = { s: 0, a: 0, b: 0 };

  function readTile(node: EventTarget | Element | null): { s: number; i: number } | null {
    const tile = node instanceof Element ? node.closest<HTMLElement>('.tile') : null;
    if (!tile || !container.contains(tile)) return null;
    const s = Number(tile.dataset.s);
    const i = Number(tile.dataset.i);
    return Number.isFinite(s) && Number.isFinite(i) ? { s, i } : null;
  }

  /**
   * Which tile is under a moving pointer.
   *
   * `elementFromPoint` is the only way to answer this DURING a drag, because
   * `setPointerCapture` pins `event.target` to the tile the gesture started on.
   * But it is NOT reliable in every context — it returns null outright in a
   * backgrounded tab, which is how the first version silently dropped taps in a
   * two-tab test with the board plainly visible and the HUD saying "Your turn".
   * So it is used only where it has to be, and `onDown` reads the event target
   * instead, which is exactly the tile the finger landed on.
   */
  function tileAt(x: number, y: number): { s: number; i: number } | null {
    // Guarded because it is not universally present (jsdom omits it entirely) and
    // returns null in contexts that are otherwise perfectly live.
    if (typeof document.elementFromPoint !== 'function') return null;
    return readTile(document.elementFromPoint(x, y));
  }

  function setSel(next: Selection | null): void {
    sel = next;
    paintSelection();
    cfg.onSelect(sel);
  }

  function paintSelection(): void {
    for (const t of container.querySelectorAll<HTMLElement>('.tile')) {
      const s = Number(t.dataset.s);
      const i = Number(t.dataset.i);
      const on = !!sel && sel.s === s && i >= sel.a && i <= sel.b;
      t.classList.toggle('sel', on);
      t.setAttribute('aria-pressed', on ? 'true' : 'false');
      t.classList.toggle('cursor', cursor.s === s && cursor.a === i && !on);
    }
  }

  function commit(): void {
    if (!sel || !game) return;
    const accepted = cfg.onCut(sel);
    if (accepted) {
      sel = null;
      armed = false;
      cfg.onSelect(null);
    }
  }

  function onDown(e: PointerEvent): void {
    if (!cfg.canPlay() || dragPointer !== null) return;
    // The event target IS the tile — no hit-testing needed, and no dependency on
    // a rendered frame or a foregrounded tab.
    const hit = readTile(e.target) ?? tileAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    try {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // Throws NotFoundError if the pointer is not active — which is the case for
      // any synthetic event, and can also happen for a real one that was already
      // released. Capture is an optimisation (it keeps a drag alive off-element);
      // move/up are on `window` anyway, so losing it costs nothing and letting it
      // throw would abort the gesture before the selection ever starts.
    }
    dragPointer = e.pointerId;
    moved = false;

    // Second tap of a tap-tap selection: close the span and cut.
    if (armed && sel && sel.s === hit.s) {
      if (sel.a === hit.i && sel.b === hit.i) {
        // Tapping the same single tile again cancels, rather than trapping the
        // player in a selection they cannot see how to clear.
        armed = false;
        setSel(null);
        return;
      }
      const [a, b] = span(sel.a, hit.i);
      dragStrand = hit.s;
      dragAnchor = sel.a;
      setSel({ s: hit.s, a, b });
      return;
    }

    armed = false;
    dragStrand = hit.s;
    dragAnchor = hit.i;
    setSel({ s: hit.s, a: hit.i, b: hit.i });
  }

  function onMove(e: PointerEvent): void {
    if (dragPointer !== e.pointerId || !cfg.canPlay()) return;
    // During a drag the target is pinned by pointer capture, so the position is
    // the only source of truth here.
    const hit = tileAt(e.clientX, e.clientY);
    // Ignore a drag that strays onto the OTHER strand — a cut is contiguous
    // within one strand by definition, and snapping across would be a lie.
    if (!hit || hit.s !== dragStrand) return;
    if (hit.i !== dragAnchor) moved = true;
    const [a, b] = span(dragAnchor, hit.i);
    if (sel && sel.a === a && sel.b === b) return;
    setSel({ s: dragStrand, a, b });
  }

  function onUp(e: PointerEvent): void {
    if (dragPointer !== e.pointerId) return;
    dragPointer = null;
    if (!cfg.canPlay() || !sel) return;
    if (moved || sel.b > sel.a) {
      // A real drag, or the closing tap of a tap-tap: try to cut. If it is not a
      // word the selection SURVIVES, with the chip explaining why, so a near miss
      // is one tile's adjustment rather than a restart.
      cursor = { s: sel.s, a: sel.b, b: sel.b };
      commit();
      if (sel) armed = true;
    } else {
      // A single tap: arm it and wait for the closing tap.
      armed = true;
      cursor = { s: sel.s, a: sel.a, b: sel.a };
    }
    paintSelection();
  }

  function onCancel(e: PointerEvent): void {
    if (dragPointer !== e.pointerId) return;
    dragPointer = null;
    armed = false;
    setSel(null);
  }

  container.addEventListener('pointerdown', onDown);
  // move/up/cancel go on WINDOW so a drag that leaves the strand still resolves.
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);

  function render(g: GameState, freshKeys?: Set<string>): void {
    game = g;
    const frag = document.createDocumentFragment();

    g.strands.forEach((st, s) => {
      const wrap = document.createElement('div');
      wrap.className = 'strand-wrap';
      if (g.strands.length > 1) {
        const label = document.createElement('div');
        label.className = 'strand-label';
        label.textContent = `Strand ${s + 1}`;
        wrap.appendChild(label);
      }
      const row = document.createElement('div');
      row.className = 'strand';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', `Strand ${s + 1}: ${st.letters.join('')}`);
      st.letters.forEach((ch, i) => {
        const t = document.createElement('button');
        t.type = 'button';
        t.className = 'tile';
        if (st.seam[i]) t.classList.add('seamed');
        if (freshKeys?.has(`${s}:${i}`)) t.classList.add('fresh');
        t.dataset.s = String(s);
        t.dataset.i = String(i);
        t.textContent = ch;
        t.tabIndex = -1;
        t.setAttribute(
          'aria-label',
          `${ch}${st.seam[i] ? ', seam before this letter' : ''}, position ${i + 1}`,
        );
        row.appendChild(t);
      });
      wrap.appendChild(row);
      frag.appendChild(wrap);
    });

    container.replaceChildren(frag);

    // Keep the selection and the keyboard cursor inside the (possibly resized)
    // strand rather than letting a stale index address a letter that is gone.
    const clampTo = (s: number, i: number): number =>
      Math.max(0, Math.min(i, (g.strands[s]?.letters.length ?? 1) - 1));
    cursor = { s: Math.min(cursor.s, g.strands.length - 1), a: 0, b: 0 };
    cursor.a = cursor.b = clampTo(cursor.s, cursor.a);
    if (sel) {
      const max = g.strands[sel.s]?.letters.length ?? 0;
      if (sel.b >= max) setSel(null);
    }
    paintSelection();
  }

  function moveCursor(delta: number, extend: boolean): void {
    if (!game || !cfg.canPlay()) return;
    const st = game.strands[cursor.s];
    if (!st) return;
    const next = Math.max(0, Math.min(st.letters.length - 1, cursor.a + delta));
    cursor = { s: cursor.s, a: next, b: next };
    if (extend && sel && sel.s === cursor.s) {
      const anchor = armed || sel.a === sel.b ? sel.a : sel.a;
      const [a, b] = span(anchor, next);
      setSel({ s: cursor.s, a, b });
      armed = true;
    } else {
      armed = true;
      setSel({ s: cursor.s, a: next, b: next });
    }
  }

  return {
    render,
    selection: () => sel,
    clearSelection() {
      armed = false;
      setSel(null);
    },
    moveCursor,
    commit,
    destroy() {
      container.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    },
  };
}

// ── juice ─────────────────────────────────────────────────────────────────

let fxLayer: HTMLElement | null = null;

function layer(): HTMLElement {
  if (!fxLayer || !fxLayer.isConnected) {
    fxLayer = document.createElement('div');
    fxLayer.className = 'fx-layer';
    fxLayer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(fxLayer);
  }
  return fxLayer;
}

const reduced = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Score pop + sparks at a screen point.
 *
 * Every element here is removed by `setTimeout`, never by an animation or
 * transition callback: a backgrounded tab fires neither, and a leaked
 * fixed-position layer over the board is how a game becomes untappable.
 */
export function burst(x: number, y: number, text: string, doubled: boolean): void {
  const l = layer();
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.textContent = text;
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
  if (!doubled) pop.style.color = PALETTE.tile;
  l.appendChild(pop);
  setTimeout(() => pop.remove(), 1100);

  if (reduced()) return;
  const n = doubled ? 16 : 9;
  for (let k = 0; k < n; k++) {
    const s = document.createElement('div');
    s.className = 'spark';
    const ang = (Math.PI * 2 * k) / n + (doubled ? 0.2 : 0);
    const dist = 34 + (k % 4) * 13;
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.background = doubled ? PALETTE.seam : PALETTE.tile;
    s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
    s.style.setProperty('--dy', `${Math.sin(ang) * dist - 12}px`);
    l.appendChild(s);
    setTimeout(() => s.remove(), 700);
  }
}

/** A short shake on the given element. Self-clearing via setTimeout. */
export function shake(el: HTMLElement, cls: 'shake' | 'nudge' = 'shake'): void {
  if (reduced()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 400);
}

export function playerColour(i: number): string {
  return PLAYER_COLOURS[i % PLAYER_COLOURS.length];
}

export function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
