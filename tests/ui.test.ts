/**
 * ui.test.ts — the invariants that a screenshot would not catch, and that jsdom
 * CAN.
 *
 * jsdom has no layout engine, so nothing here is about geometry — phone layout is
 * checked in a real browser at 375px, once per mode (principle #20). What jsdom
 * IS good for is structure: does every player mark carry its numeral, does an
 * overlay that is `hidden` actually get `display:none`, does the footer link out.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderResults, renderMenu, helpModal, aboutModal } from '../src/ui';
import { applyCut, createGame, legalCuts, type GameState } from '../src/game';
import { modeOf } from '../src/modes';
import { PLAYER_COLOURS } from '../src/palette';

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'src', 'styles', 'main.css'), 'utf8');

function finishedGame(players = 2): GameState {
  let g = createGame({
    strands: ['PLANTERMSHAPEDGEARLYWORKS'],
    turnsEach: 2,
    minLen: 3,
    maxLen: 5,
    players,
    refillSeed: 21,
  });
  while (!g.over) g = applyCut(g, legalCuts(g)[0]).state;
  return g;
}

let root: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

describe('the [hidden] guard', () => {
  /**
   * The rule that has to be in the stylesheet, because Safari/iOS's UA `[hidden]`
   * rule is not `!important`. Any overlay toggled by the attribute that also gets
   * a `display` from a class stays VISIBLE there — a transparent blur layer on
   * top of the board that eats every tap. Chromium hides this from you, which is
   * exactly why it needs a source-level assertion rather than a screenshot.
   */
  it('is present in the stylesheet', () => {
    expect(CSS).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('is the FIRST rule, so nothing can be authored above it', () => {
    const hiddenAt = CSS.indexOf('[hidden]');
    const rootAt = CSS.indexOf(':root');
    expect(hiddenAt).toBeGreaterThan(-1);
    expect(hiddenAt).toBeLessThan(rootAt);
  });
});

describe('the footer backlink', () => {
  it('points at the catalogue, not at a repo', () => {
    // How players find the rest of the catalogue. Also: no GitHub link in the UI.
    const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    expect(main).toContain('https://benrichardson.dev/');
    expect(main).toContain('https://lab.benrichardson.dev');
    expect(main).not.toContain('github.com');
  });

  it('is hidden while a round is live', () => {
    // `body.playing .site-footer` comes from the engine's mobile.css; the game
    // only has to add and remove the class. Assert it does both.
    const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    expect(main).toContain("classList.add('playing')");
    expect(main).toContain("classList.remove('playing')");
  });
});

describe('results show everyone, not just you', () => {
  it('lists every player with their own words and score', () => {
    const g = finishedGame(3);
    renderResults(root, {
      g,
      seats: [
        { name: 'Ann', you: true },
        { name: 'Bo', you: false },
        { name: 'Cal', you: false, left: true },
      ],
      best: null,
      par: null,
      parPending: false,
      againLabel: 'Play again',
      onAgain: () => {},
      onMenu: () => {},
      onShare: () => {},
    });
    const text = root.textContent ?? '';
    for (const name of ['Ann', 'Bo', 'Cal']) expect(text).toContain(name);
    // Every player's actual cuts, not merely a name and a number.
    for (const seat of [0, 1, 2]) {
      const words = g.history.filter((h) => h.player === seat).map((h) => h.word);
      expect(words.length).toBeGreaterThan(0);
      for (const w of words) expect(text).toContain(w);
    }
    // A peer that walked out is shown as having left, not silently dropped.
    expect(text).toContain('left');
  });

  it('gives every player mark its seat NUMERAL, so colour is never the message', () => {
    /**
     * The assertion that lets contrast.test.ts accept four hue-separated player
     * colours whose luminances are only 1.06:1 apart. If the numeral ever goes
     * away, that becomes a colour-blind accessibility bug and this goes red.
     */
    const g = finishedGame(4);
    renderResults(root, {
      g,
      seats: ['Ann', 'Bo', 'Cal', 'Di'].map((name, i) => ({ name, you: i === 0 })),
      best: null,
      par: null,
      parPending: false,
      againLabel: 'Play again',
      onAgain: () => {},
      onMenu: () => {},
      onShare: () => {},
    });
    const badges = [...root.querySelectorAll<HTMLElement>('.pbadge')];
    expect(badges).toHaveLength(4);
    badges.forEach((b, i) => {
      expect(b.textContent?.trim()).toBe(String(i + 1));
      // The FILL is what carries the player colour; the glyph must not, or the
      // numeral is painted on itself and the badge is a blank disc.
      expect(b.style.background, `badge ${i + 1} has no fill`).toBeTruthy();
      expect(b.style.color, `badge ${i + 1} overrode its glyph colour`).toBeFalsy();
    });
    expect(PLAYER_COLOURS.length).toBeGreaterThanOrEqual(4);
  });

  it('shows the best line as a searching state before it resolves', () => {
    const g = finishedGame(1);
    renderResults(root, {
      g,
      seats: [{ name: 'You', you: true }],
      best: 10,
      par: null,
      parPending: true,
      againLabel: 'New strand',
      onAgain: () => {},
      onMenu: () => {},
      onShare: () => {},
    });
    expect(root.querySelector('.spinner')).toBeTruthy();
    expect(root.textContent).toContain('best line');
  });

  it('always offers a way onward, and a way to report a problem', () => {
    const g = finishedGame(2);
    let lobby = 0;
    renderResults(root, {
      g,
      seats: [
        { name: 'You', you: true },
        { name: 'Bo', you: false },
      ],
      best: null,
      par: { score: 99, moves: g.history },
      parPending: false,
      againLabel: 'Play again',
      onAgain: () => {},
      onMenu: () => {},
      onShare: () => {},
      onLobby: () => {
        lobby++;
      },
      waitingNote: 'Starting in 5s — 1 of 2 ready.',
    });
    const text = root.textContent ?? '';
    expect(text).toContain('Play again');
    expect(text).toContain('Back to lobby');
    expect(text).toContain('Back to menu');
    // A waiting state that says what it is waiting for AND when it ends.
    expect(text).toContain('Starting in 5s');
    // The results-screen feedback entry point (the footer is hidden mid-round).
    expect(root.querySelector('.results-feedback')).toBeTruthy();
    root.querySelector<HTMLElement>('.btn')!.click();
    expect(lobby).toBe(0);
  });
});

describe('the menu', () => {
  it('offers every mode, solo, bots and friends', () => {
    renderMenu(root, {
      mode: modeOf('strand'),
      onMode: () => {},
      onSolo: () => {},
      onBots: () => {},
      onFriends: () => {},
      onDaily: () => {},
      onHelp: () => {},
      onAbout: () => {},
      onMute: () => {},
      muted: false,
      best: null,
      dailyDone: false,
    });
    const text = root.textContent ?? '';
    for (const s of ['Strand', 'Deepcut', 'Twinfold', 'Play solo', 'Play with friends']) {
      expect(text).toContain(s);
    }
    // Exactly one mode is pressed at a time.
    const pressed = [...root.querySelectorAll('.mode-btn[aria-pressed="true"]')];
    expect(pressed).toHaveLength(1);
  });
});

describe('the disclosures', () => {
  it('explains the curated word list, so a rejection is not read as a bug', () => {
    const m = helpModal(() => {});
    expect(m.textContent).toContain('curated list');
  });

  it('discloses the P2P relay and the IP exposure only once multiplayer is used', () => {
    expect(aboutModal(false, () => {}).textContent).not.toContain('IP addresses');
    const withMp = aboutModal(true, () => {}).textContent ?? '';
    expect(withMp).toContain('peer-to-peer');
    expect(withMp).toContain('IP addresses');
    expect(withMp).toContain('no game server');
  });

  it('claims no cookies and no tracking, which the code must keep true', () => {
    const about = aboutModal(false, () => {}).textContent ?? '';
    expect(about).toContain('No cookies');
    const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
    expect(main).not.toMatch(/document\.cookie/);
  });
});
