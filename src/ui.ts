/**
 * ui.ts — the screens that are not the board: menu, help, about, results.
 */

import { el } from './dom';
import { allModes, type Mode } from './modes';
import { SEAM_MULT, type GameState, type PlayedMove } from './game';
import { playerColour } from './render';
import { openFeedback } from './feedback';

export interface MenuHandlers {
  mode: Mode;
  onMode: (m: Mode) => void;
  onSolo: () => void;
  onBots: () => void;
  onFriends: () => void;
  onDaily: () => void;
  onHelp: () => void;
  onAbout: () => void;
  onMute: () => void;
  muted: boolean;
  best: number | null;
  dailyDone: boolean;
}

export function renderMenu(root: HTMLElement, h: MenuHandlers): void {
  const modeBtns = allModes().map((m) => {
    const b = el('button', {
      class: 'btn mode-btn',
      type: 'button',
      'aria-pressed': m.id === h.mode.id ? 'true' : 'false',
    });
    b.append(el('span', { class: 'mode-name', text: m.name }));
    b.append(el('span', { class: 'mode-blurb', text: m.blurb }));
    b.addEventListener('click', () => h.onMode(m));
    return b;
  });

  const wordmark = el('h1', { class: 'wordmark' });
  wordmark.append('UN', el('span', { class: 'cut', text: 'STR' }), 'UNG');

  const play = el('button', { class: 'btn primary', type: 'button', text: 'Play solo' });
  play.addEventListener('click', h.onSolo);
  const bots = el('button', { class: 'btn', type: 'button', text: 'Play against the machine' });
  bots.addEventListener('click', h.onBots);
  const friends = el('button', { class: 'btn', type: 'button', text: 'Play with friends' });
  friends.addEventListener('click', h.onFriends);
  const daily = el('button', {
    class: 'btn',
    type: 'button',
    text: h.dailyDone ? "Today's strand ✓" : "Today's strand",
  });
  daily.addEventListener('click', h.onDaily);

  const help = el('button', { class: 'btn sm ghost', type: 'button', text: 'How to play' });
  help.addEventListener('click', h.onHelp);
  const about = el('button', { class: 'btn sm ghost', type: 'button', text: 'About' });
  about.addEventListener('click', h.onAbout);
  const mute = el('button', {
    class: 'btn sm ghost',
    type: 'button',
    text: h.muted ? 'Sound off' : 'Sound on',
    'aria-pressed': h.muted ? 'true' : 'false',
  });
  mute.addEventListener('click', h.onMute);

  root.replaceChildren(
    wordmark,
    el('p', {
      class: 'tagline',
      text: 'Cut words out of one long strand. Every cut splices in fresh thread — and a word that spans the seam scores triple.',
    }),
    el('div', { class: 'menu-modes' }, modeBtns),
    el('div', { class: 'stack' }, [play, bots, friends, daily]),
    h.best != null
      ? el('p', { class: 'best-line', text: `Your best on ${h.mode.name}: ${h.best}` })
      : el('p', { class: 'best-line', text: 'No score yet on this mode.' }),
    el('div', { class: 'menu-foot' }, [help, about, mute]),
  );
}

// ── modals ────────────────────────────────────────────────────────────────

function modal(title: string, body: Array<Node | string>, onClose: () => void): HTMLElement {
  const close = el('button', { class: 'btn primary', type: 'button', text: 'Got it' });
  const card = el('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    el('h2', { text: title }),
    ...body,
    el('div', { class: 'btn-row', style: 'margin-top:14px' }, [close]),
  ]);
  const wrap = el('div', { class: 'modal' }, [card]);
  close.addEventListener('click', onClose);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) onClose();
  });
  return wrap;
}

export function helpModal(onClose: () => void): HTMLElement {
  const list = el('ul', { class: 'hint-list' });
  list.append(
    el('li', {
      html: 'Drag across a run of <strong>touching letters</strong> that spells a word — or tap the first letter, then the last.',
    }),
    el('li', {
      html: 'The word is cut out and <strong>fresh thread is spliced in</strong>. Those two joins are <strong>seams</strong>, and they stay.',
    }),
    el('li', {
      html: `A word that <strong>spans a seam</strong> scores <strong>&times;${SEAM_MULT}</strong>. Everything else scores its length, squared.`,
    }),
    el('li', { html: 'You get a set number of cuts. Highest total wins.' }),
  );
  return modal(
    'How to play',
    [
      list,
      el('p', {
        class: 'muted',
        text:
          'The free move is always there — the fresh thread is a short word — but it is the cheap one. ' +
          'The points are in the bridges you build.',
      }),
      el('p', {
        class: 'muted',
        text:
          'Unstrung uses a curated list of everyday words rather than a full tournament dictionary, so ' +
          'obscure three-letter words do not count and the game rewards words you actually know. A few ' +
          'rare words may not be accepted.',
      }),
    ],
    onClose,
  );
}

export function aboutModal(multiplayerUsed: boolean, onClose: () => void): HTMLElement {
  const body: Array<Node | string> = [
    el('p', {
      text:
        'Unstrung is a word game about manufacturing rather than harvesting: every cut you make ' +
        'changes what the strand can spell next.',
    }),
    el('p', {
      class: 'muted',
      text:
        'No cookies, no fingerprinting, no third-party fonts, no accounts. The only analytics are ' +
        'anonymous, cookie-less page-view counts via Cloudflare Web Analytics.',
    }),
  ];
  if (multiplayerUsed) {
    body.push(
      el('p', {
        class: 'muted',
        text:
          'Playing with friends is peer-to-peer over WebRTC — there is no game server and no game ' +
          'state is stored anywhere. A public signalling relay is used only to introduce the two ' +
          'browsers to each other, and connecting exchanges IP addresses with the people in your room.',
      }),
    );
  }
  body.push(
    el('p', {
      class: 'muted',
      html:
        'Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> · ' +
        '<a href="https://lab.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>',
    }),
  );
  return modal('About Unstrung', body, onClose);
}

// ── results ───────────────────────────────────────────────────────────────

export interface ResultsHandlers {
  g: GameState;
  seats: Array<{ name: string; you: boolean; left?: boolean }>;
  /** Running match tally across rounds in this room, if any. */
  tally?: number[];
  best: number | null;
  /** The strongest line the solver found on this exact deal. */
  par: { score: number; moves: PlayedMove[] } | null;
  parPending: boolean;
  onAgain: () => void;
  againLabel: string;
  onMenu: () => void;
  onShare: () => void;
  /** Present only in a live room. */
  onLobby?: () => void;
  waitingNote?: string;
}

function wordList(moves: PlayedMove[]): HTMLElement {
  const holder = el('span', { class: 'wordlist' });
  if (!moves.length) {
    holder.append(el('span', { text: '—' }));
    return holder;
  }
  moves.forEach((m, i) => {
    if (i) holder.append(' · ');
    holder.append(
      el('span', { class: m.spannedSeam ? 'x2m' : '', text: `${m.word} ${m.value}${m.spannedSeam ? '✦' : ''}` }),
    );
  });
  return holder;
}

export function renderResults(root: HTMLElement, h: ResultsHandlers): void {
  const { g } = h;
  const top = Math.max(...g.scores);
  const winners = g.scores.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0);
  const solo = g.players === 1;

  const head = el('div', { class: 'res-head' });
  if (solo) {
    head.append(
      el('h2', { text: 'Strand spent' }),
      el('div', { class: 'big', text: String(g.scores[0]) }),
      el('p', {
        class: 'muted',
        text: h.best != null && g.scores[0] >= h.best ? 'A new best on this mode.' : `Your best: ${h.best ?? '—'}`,
      }),
    );
  } else {
    const youWon = winners.includes(h.seats.findIndex((s) => s.you));
    head.append(
      el('h2', {
        text:
          winners.length > 1
            ? 'Dead heat'
            : youWon
              ? 'You win'
              : `${h.seats[winners[0]]?.name ?? 'Player'} wins`,
      }),
      el('div', { class: 'big', text: g.scores.map((v) => String(v)).join(' · ') }),
    );
  }

  // Principle #9: EVERY player's breakdown, not just yours — and not just a name
  // and a number, but the words each of them actually cut.
  const table = el('table', { class: 'results-table' });
  const thead = el('tr');
  thead.append(
    el('th', { text: 'Player' }),
    el('th', { text: 'Score' }),
    h.tally ? el('th', { text: 'Match' }) : el('th', { text: 'Cuts' }),
  );
  table.append(el('thead', {}, [thead]));
  const tbody = el('tbody');
  h.seats.forEach((s, i) => {
    const cuts = g.history.filter((m) => m.player === i);
    const row = el('tr');
    const nameCell = el('td');
    const dot = el('span', { class: 'pbadge', text: String(i + 1) });
    dot.style.background = playerColour(i);
    const who = el('span', { class: 'pwho' });
    // "You (you)" is what the naive version printed in solo. Only mark the local
    // player when the name does not already say so.
    who.append(dot, `${s.name}${s.you && s.name !== 'You' ? ' (you)' : ''}${s.left ? ' — left' : ''}`);
    if (winners.includes(i) && !solo) who.append(el('span', { class: 'trophy', text: ' ★' }));
    nameCell.append(who);
    row.append(
      nameCell,
      el('td', { class: 'num', text: String(g.scores[i]) }),
      el('td', { class: 'num', text: h.tally ? String(h.tally[i] ?? 0) : String(cuts.length) }),
    );
    const detail = el('tr');
    const cell = el('td', { colspan: '3' });
    cell.append(wordList(cuts));
    detail.append(cell);
    tbody.append(row, detail);
  });
  table.append(tbody);

  // What everyone missed. The strand has a knowable best answer, so showing it is
  // the difference between a score and a lesson.
  const par = el('div', { class: 'par' });
  par.append(el('h3', { text: 'The best line we could find' }));
  if (h.parPending) {
    par.append(
      el('p', { class: 'muted' }, [el('span', { class: 'spinner sm' }), ' Searching this strand…']),
    );
  } else if (h.par) {
    par.append(
      el('p', { class: 'muted', text: `${h.par.score} points in ${h.par.moves.length} cuts` }),
      wordList(h.par.moves),
    );
  } else {
    par.append(el('p', { class: 'muted', text: 'Not available for this strand.' }));
  }

  const again = el('button', { class: 'btn primary', type: 'button', text: h.againLabel });
  again.addEventListener('click', h.onAgain);
  const share = el('button', { class: 'btn', type: 'button', text: 'Share this strand' });
  share.addEventListener('click', h.onShare);
  const menu = el('button', { class: 'btn ghost', type: 'button', text: 'Back to menu' });
  menu.addEventListener('click', h.onMenu);
  const actions: HTMLElement[] = [again];
  if (h.onLobby) {
    const lobby = el('button', { class: 'btn', type: 'button', text: 'Back to lobby' });
    lobby.addEventListener('click', h.onLobby);
    actions.push(lobby);
  }
  actions.push(share, menu);

  // Feedback has to be reachable from HERE as well as the footer: `body.playing`
  // hides the footer for the whole round, which is exactly when a player hits the
  // thing they want to report.
  const fb = el('button', { class: 'btn sm ghost results-feedback', type: 'button', text: 'Send feedback' });
  fb.addEventListener('click', (e) => openFeedback({ returnFocusTo: e.currentTarget as HTMLElement }));

  const children: Array<Node | string> = [head, table, par];
  if (h.waitingNote) children.push(el('p', { class: 'muted', text: h.waitingNote }));
  children.push(el('div', { class: 'stack', style: 'margin-top:14px' }, actions));
  children.push(el('div', { class: 'btn-row', style: 'margin-top:10px;justify-content:center' }, [fb]));

  root.replaceChildren(el('div', { class: 'panel' }, children));
}
