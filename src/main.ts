// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * main.ts — bootstrap and the screen machine.
 *
 * Owns: which screen is up, the room's Net (created ONCE per session and never
 * left for a rematch), and the glue between `Session` and the DOM. All game rules
 * live in game.ts; all board input lives in render.ts.
 */

import './styles/main.css';

import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createSfx } from '@ben-gy/game-engine/sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { newSeed, hashSeed } from '@ben-gy/game-engine/rng';
import { createNet, roomAppId, setTurnConfig, type Net, type PeerId } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type Rounds, type RoundPlayer } from '@ben-gy/game-engine/rematch';
import {
  clearRoomInUrl,
  createLobby,
  createRoomEntry,
  inviteLink,
  normalizeRoomCode,
  setRoomInUrl,
} from '@ben-gy/game-engine/lobby';
import { resolveName } from '@ben-gy/game-engine/identity';

import { el } from './dom';
import { allModes, modeOf, turnsFor, type Mode } from './modes';
import { cutsLeft, createSession, type Session } from './session';
import { dailySeed, dealStrands } from './strand';
import { bestLine } from './solver';
import { createStrandView, selectionValue, selectionWord, burst, shake, toast, playerColour } from './render';
import type { Selection } from './render';
import { startCountdown, type Countdown } from './countdown';
import { renderMenu, helpModal, aboutModal, renderResults } from './ui';
import type { GameState, PlayedMove } from './game';
import type { Strength } from './bot';

const SLUG = 'unstrung';

// ── shell ─────────────────────────────────────────────────────────────────

const app = document.querySelector<HTMLElement>('#app')!;
const main = el('div', { class: 'main-content' });
const footer = el('footer', { class: 'site-footer' });
footer.innerHTML =
  'Built by <a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> · ' +
  '<a href="https://lab.benrichardson.dev" target="_blank" rel="noopener">more games, tools &amp; sites</a>';
app.replaceChildren(main, footer);

const store = createStore(SLUG);
const sfx = createSfx(store.get<boolean>('muted', false) ?? false);
hardenViewport();

let unlocked = false;
const unlock = (): void => {
  if (unlocked) return;
  unlocked = true;
  try {
    sfx.unlock();
  } catch {
    /* audio is a nicety; never let it break a tap */
  }
};
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

// ── app state ─────────────────────────────────────────────────────────────

type Screen = 'menu' | 'entry' | 'lobby' | 'game' | 'results';

let screen: Screen = 'menu';
let mode: Mode = modeOf(store.get<string>('mode', 'strand'));
let session: Session | null = null;
let countdown: Countdown | null = null;
let net: Net | null = null;
let rounds: Rounds | null = null;
let roomCode = '';
let lobbyView: { destroy: () => void } | null = null;
let entryView: { destroy: () => void } | null = null;
let roster: RoundPlayer[] = [];
let leftIds = new Set<PeerId>();
let matchTally: number[] = [];
let multiplayerUsed = false;
let modal: HTMLElement | null = null;
let dealSeed = 0;
/** True when the current round is the daily strand, so the result is recorded. */
let isDaily = false;

/**
 * A name for the lobby.
 *
 * The naive default — "You" — is fine on your own screen and useless in a room:
 * the first two-tab smoke test showed a roster reading "You / You HOST", because
 * every peer announces the same string. It reads as a sync bug when it is only a
 * naming one. So the fallback is a stable per-browser handle instead, seeded once
 * and reused, and a name carried from the hub on `?n=` wins on a first visit.
 */
const FALLBACK_NAMES = [
  'Weaver', 'Splicer', 'Bobbin', 'Selvedge', 'Warp', 'Weft', 'Skein', 'Reeler',
  'Carder', 'Spindle', 'Tacker', 'Lacer',
];

const playerName = resolveName(
  { get: (k, f) => store.get(k, f), set: (k, v) => store.set(k, v) },
  () => `${FALLBACK_NAMES[Math.floor(Math.random() * FALLBACK_NAMES.length)]} ${Math.floor(Math.random() * 90 + 10)}`,
);

const myName = (): string => playerName;

/**
 * `?room=` is honoured ONCE per page load. Leaving it in the URL means a reload —
 * or reopening from a home-screen icon — silently drags the player back into a
 * room they left, with no way to start a fresh one.
 */
let deepLinkRoom: string | null = (() => {
  const raw = new URLSearchParams(location.search).get('room');
  return raw ? normalizeRoomCode(raw) : null;
})();

// ── turn config, once, before ANY mesh ────────────────────────────────────
let turnReady: Promise<void> | null = null;
function ensureTurn(): Promise<void> {
  if (!turnReady) {
    turnReady = (async () => {
      try {
        setTurnConfig(await getTurnConfig());
      } catch {
        /* fail open: STUN-only is the old behaviour, never a blocked join */
      }
    })();
  }
  return turnReady;
}

// ── modals ────────────────────────────────────────────────────────────────

function closeModal(): void {
  modal?.remove();
  modal = null;
}

function showModal(node: HTMLElement): void {
  closeModal();
  modal = node;
  document.body.appendChild(node);
}

// ── menu ──────────────────────────────────────────────────────────────────

function bestKey(m: Mode): string {
  return `best:${m.id}`;
}

function showMenu(): void {
  teardownRound();
  leaveRoom();
  screen = 'menu';
  document.body.classList.remove('playing');
  clearRoomInUrl();
  renderMenu(main, {
    mode,
    onMode(m) {
      mode = m;
      store.set('mode', m.id);
      sfx.play('blip');
      showMenu();
    },
    onSolo: () => startSolo([]),
    onBots: () => startSolo(['fair']),
    onFriends: () => openRoomEntry(),
    onDaily: () => startDaily(),
    onHelp: () => showModal(helpModal(closeModal)),
    onAbout: () => showModal(aboutModal(multiplayerUsed, closeModal)),
    onMute() {
      sfx.setMuted(!sfx.muted());
      store.set('muted', sfx.muted());
      showMenu();
    },
    muted: sfx.muted(),
    best: store.get<number>(bestKey(mode), null as unknown as number) ?? null,
    dailyDone: store.get<string>('daily:done', '') === dailySeed(),
  });

  if (!store.get<boolean>('seenHelp', false)) {
    store.set('seenHelp', true);
    showModal(helpModal(closeModal));
  }

  // A deep-linked invite is consumed exactly once, on the load that carried it.
  if (deepLinkRoom) {
    const code = deepLinkRoom;
    deepLinkRoom = null;
    void enterRoom(code, false);
  }
}

// ── solo ──────────────────────────────────────────────────────────────────

function startSolo(bots: Strength[], seed = newSeed(), daily = false): void {
  isDaily = daily;
  // `sessionSeats` is what the HUD and the results table read from. Setting it
  // ONLY on the multiplayer path left solo with an empty scoreboard — the player
  // could not see their own score, which no test could see either because jsdom
  // renders the same empty HUD without complaint.
  sessionSeats = [
    // Solo says "You" — the persistent handle is for rooms, where it has to tell
    // two people apart.
    { id: 'me', name: 'You' },
    ...bots.map((b, i) => ({ id: `bot${i}`, name: `Machine ${i + 1}`, bot: b })),
  ];
  beginRound({ seed, seats: sessionSeats, seatIndex: 0, round: 1, isHost: true });
}

function startDaily(): void {
  startSolo([], hashSeed(dailySeed()), true);
}

// ── the round ─────────────────────────────────────────────────────────────

interface BeginSpec {
  seed: number;
  seats: Array<{ id: string; name: string; bot?: Strength }>;
  seatIndex: number;
  round: number;
  isHost: boolean;
}

let boardEls: {
  hud: HTMLElement;
  turnbar: HTMLElement;
  chip: HTMLElement;
  strands: HTMLElement;
  view: ReturnType<typeof createStrandView>;
} | null = null;

function teardownRound(): void {
  countdown?.cancel();
  countdown = null;
  session?.destroy();
  session = null;
  boardEls?.view.destroy();
  boardEls = null;
  document.removeEventListener('keydown', onKey);
}

function beginRound(spec: BeginSpec): void {
  teardownRound();
  closeModal();
  screen = 'game';
  dealSeed = spec.seed;
  document.body.classList.add('playing');

  const hud = el('div', { class: 'hud' });
  const turnbar = el('div', { class: 'turnbar' });
  const chip = el('div', { class: 'chip', role: 'status', 'aria-live': 'polite' });
  const strands = el('div', { class: 'strands' });
  const quit = el('button', { class: 'btn sm ghost', type: 'button', text: 'Leave' });
  quit.addEventListener('click', () => showMenu());

  const board = el('div', { class: 'board' }, [
    hud,
    turnbar,
    el('div', { class: 'play-area' }, [strands, chip]),
    el('div', { class: 'btn-row', style: 'justify-content:center' }, [quit]),
  ]);
  main.replaceChildren(board);

  const view = createStrandView({
    container: strands,
    canPlay: () => !!session && session.myTurn() && !countdown,
    onSelect: (sel) => paintChip(sel),
    onCut: (sel) => tryCut(sel),
  });
  boardEls = { hud, turnbar, chip, strands, view };
  document.addEventListener('keydown', onKey);

  session = createSession({
    mode,
    seed: spec.seed,
    seats: spec.seats,
    seatIndex: spec.seatIndex,
    round: spec.round,
    net,
    isHost: spec.isHost,
    onChange: (g) => paintBoard(g),
    onPlayed: (m) => onPlayed(m),
    onOver: (g) => finishRound(g),
  });

  // Count everyone in. Solo needs no ceremony; a shared round does, or whoever
  // happened to be looking at their screen gets a free head start.
  if (net && spec.seats.length > 1) {
    countdown = startCountdown({
      container: document.body,
      sfx,
      onDone() {
        countdown = null;
        paintBoard(session!.state());
      },
    });
  }
  paintBoard(session.state());
  startTicker();
}

/** Keys previously on the board, so only genuinely NEW tiles animate in. */
let prevLetterKeys = new Set<string>();

function paintBoard(g: GameState): void {
  if (!boardEls || screen !== 'game') return;
  const seats = currentSeats();

  // HUD
  const players = el('div', { class: 'hud-players' });
  seats.forEach((s, i) => {
    const chipEl = el('div', { class: `pscore${g.turn === i && !g.over ? ' is-turn' : ''}` });
    chipEl.style.color = playerColour(i);
    const badge = el('span', { class: 'pbadge', text: String(i + 1) });
    badge.style.background = playerColour(i);
    chipEl.append(
      badge,
      el('span', { class: 'pname', text: s.name }),
      el('span', { class: 'pval', text: String(g.scores[i]) }),
    );
    players.append(chipEl);
  });
  boardEls.hud.replaceChildren(players);

  // Turn bar
  const mine = session?.myTurn() ?? false;
  const left = cutsLeft(g, Math.max(0, g.turn));
  const who = mine ? 'Your turn' : `${seats[g.turn]?.name ?? 'Player'}'s turn`;
  const clock = session?.clock();
  boardEls.turnbar.replaceChildren(
    el('span', {}, [el('strong', { text: who }), ` · ${left} cut${left === 1 ? '' : 's'} left`]),
    clock != null
      ? el('span', { class: `clock${clock <= 10 ? ' low' : ''}`, text: `${clock}s` })
      : el('span', { class: 'clock', text: `${g.strands.reduce((n, s) => n + s.seam.filter(Boolean).length, 0)} seams` }),
  );

  const keys = new Set<string>();
  g.strands.forEach((st, s) => st.letters.forEach((_, i) => keys.add(`${s}:${i}:${st.letters[i]}`)));
  const fresh = new Set<string>();
  g.strands.forEach((st, s) =>
    st.letters.forEach((ch, i) => {
      if (!prevLetterKeys.has(`${s}:${i}:${ch}`) && prevLetterKeys.size) fresh.add(`${s}:${i}`);
    }),
  );
  prevLetterKeys = keys;
  boardEls.view.render(g, fresh);
  paintChip(boardEls.view.selection());
}

function paintChip(sel: Selection | null): void {
  if (!boardEls || !session) return;
  const g = session.state();
  const chip = boardEls.chip;
  chip.className = 'chip';
  if (!sel) {
    chip.textContent = session.myTurn()
      ? countdown
        ? 'Get ready…'
        : 'Drag across letters, or tap the first and last.'
      : 'Waiting for the other player…';
    return;
  }
  const w = selectionWord(g, sel);
  const v = selectionValue(g, sel);
  chip.replaceChildren();
  chip.append(el('span', { class: 'word', text: w }));
  if (v.ok) {
    chip.classList.add('good');
    chip.append(el('span', { class: 'pts', text: `+${v.value}` }));
    if (v.doubled) chip.append(el('span', { class: 'x2', text: `seam ×3` }));
  } else {
    chip.classList.add('bad');
    chip.append(
      el('span', {
        text:
          w.length < g.minLen
            ? `${g.minLen} letters minimum`
            : w.length > g.maxLen
              ? `${g.maxLen} letters maximum`
              : 'Not in word list',
      }),
    );
  }
}

function tryCut(sel: Selection): boolean {
  if (!session) return false;
  const g = session.state();
  const v = selectionValue(g, sel);
  if (!v.ok) {
    sfx.play('hit');
    if (boardEls) shake(boardEls.chip, 'nudge');
    return false;
  }
  const anchor = boardEls?.strands.querySelector<HTMLElement>(`.tile[data-s="${sel.s}"][data-i="${sel.a}"]`);
  const rect = anchor?.getBoundingClientRect();
  const ok = session.play({ s: sel.s, i: sel.a, len: sel.b - sel.a + 1 });
  if (ok && rect) burst(rect.left + rect.width / 2, rect.top, `+${v.value}${v.doubled ? ' ✦' : ''}`, v.doubled);
  return ok;
}

function onPlayed(m: PlayedMove): void {
  sfx.play(m.spannedSeam ? 'powerup' : 'coin');
  if (m.value >= 40 && boardEls) shake(document.body);
}

function onKey(e: KeyboardEvent): void {
  if (screen !== 'game' || !boardEls || modal) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    boardEls.view.moveCursor(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    boardEls.view.commit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    boardEls.view.clearSelection();
  }
}

/**
 * Repaints the turn bar so the clock actually counts down.
 *
 * setInterval, not rAF — a hidden tab freezes rAF and the clock would appear
 * frozen to anyone who tabbed away and came back.
 */
let ticker: ReturnType<typeof setInterval> | undefined;
function startTicker(): void {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    if (screen !== 'game' || !session || !boardEls) return;
    const clock = session.clock();
    if (clock == null) return;
    const node = boardEls.turnbar.querySelector<HTMLElement>('.clock');
    if (node) {
      node.textContent = `${clock}s`;
      node.classList.toggle('low', clock <= 10);
    }
  }, 500);
}

// ── results ───────────────────────────────────────────────────────────────

let sessionSeats: Array<{ id: string; name: string; bot?: Strength }> = [];

function currentSeats(): Array<{ id: string; name: string; bot?: Strength }> {
  if (rounds && roster.length) {
    return roster.map((p) => ({ id: p.id, name: p.name }));
  }
  if (sessionSeats.length) return sessionSeats;
  // Structural backstop rather than a test: an empty seat list renders an empty
  // scoreboard, and a player who cannot see their own score has no game. Derive
  // placeholders from the state rather than ever painting nothing.
  const n = session?.state().players ?? 1;
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: i === 0 ? 'You' : `Player ${i + 1}` }));
}

let par: { score: number; moves: PlayedMove[] } | null = null;
let parPending = false;

function finishRound(g: GameState): void {
  screen = 'results';
  document.body.classList.remove('playing');
  countdown?.cancel();
  countdown = null;
  sfx.play(g.players === 1 || g.scores[localSeat()] === Math.max(...g.scores) ? 'win' : 'lose');

  if (g.players === 1) {
    const prev = store.get<number>(bestKey(mode), 0) ?? 0;
    if (g.scores[0] > prev) store.set(bestKey(mode), g.scores[0]);
    if (isDaily) store.set('daily:done', dailySeed());
  } else {
    if (matchTally.length !== g.players) matchTally = new Array(g.players).fill(0);
    const top = Math.max(...g.scores);
    g.scores.forEach((v, i) => {
      if (v === top) matchTally[i] += 1;
    });
  }
  rounds?.finish();

  // The solver runs AFTER the round paints, so a slow strand can never delay the
  // results screen appearing. It re-derives the OPENING deal from the seed —
  // searching from whatever is left of the board would answer a question nobody
  // asked.
  par = null;
  parPending = true;
  paintResults();
  setTimeout(() => {
    par = solveDeal(g);
    parPending = false;
    if (screen === 'results') paintResults();
  }, 30);
}

function solveDeal(g: GameState): { score: number; moves: PlayedMove[] } | null {
  try {
    const woven = dealStrands({
      seed: dealSeed,
      letters: mode.letters,
      minLen: mode.minLen,
      maxLen: mode.maxLen,
      turnsEach: turnsFor(mode, g.players),
      players: g.players,
    });
    const line = bestLine({
      strands: woven.strands,
      spools: woven.spools,
      refillSeed: dealSeed,
      // The benchmark is what ONE player could have taken with the whole round's
      // worth of cuts, which is the number a solo player is measuring against and
      // the ceiling a table was competing for.
      turnsEach: g.turnsEach * g.players,
      minLen: g.minLen,
      maxLen: g.maxLen,
      players: 1,
    });
    return { score: line.score, moves: line.moves };
  } catch {
    return null;
  }
}

function localSeat(): number {
  if (!rounds || !net) return 0;
  const i = roster.findIndex((p) => p.id === net!.selfId);
  return i < 0 ? 0 : i;
}

function paintResults(): void {
  const g = session?.state();
  if (!g) return;
  const seats = currentSeats();
  const inRoom = !!rounds && !!net;
  renderResults(main, {
    g,
    seats: seats.map((s, i) => ({
      name: s.name.replace(' (you)', ''),
      you: inRoom ? i === localSeat() : i === 0 && !s.bot,
      left: inRoom ? leftIds.has(s.id) : false,
    })),
    tally: inRoom ? matchTally : undefined,
    best: store.get<number>(bestKey(mode), null as unknown as number) ?? null,
    par,
    parPending,
    againLabel: inRoom ? 'Play again' : 'New strand',
    waitingNote: inRoom ? waitingNote() : undefined,
    onAgain() {
      unlock();
      if (inRoom) {
        rounds!.vote();
        paintResults();
      } else {
        startSolo(seats.filter((s) => s.bot).map((s) => s.bot!) as Strength[]);
      }
    },
    onLobby: inRoom ? () => showLobby() : undefined,
    onMenu: () => showMenu(),
    onShare: () => shareStrand(g),
  });
}

function waitingNote(): string | undefined {
  const s = rounds?.state();
  if (!s) return undefined;
  if (!s.voted) return undefined;
  const ms = s.startsInMs;
  if (ms != null) return `Starting in ${Math.ceil(ms / 1000)}s — ${s.votes.length} of ${s.present.length} ready.`;
  return `Waiting for the others — ${s.votes.length} of ${s.present.length} ready.`;
}

async function shareStrand(g: GameState): Promise<void> {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  url.searchParams.set('mode', mode.id);
  url.searchParams.set('seed', String(dealSeed));
  const text = `I scored ${g.scores[localSeat()] ?? g.scores[0]} on this Unstrung strand (${mode.name}).`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Unstrung', text, url: url.toString() });
      return;
    }
  } catch {
    /* cancelled — fall through to copy */
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url.toString()}`);
    toast('Link copied');
  } catch {
    toast(url.toString());
  }
}

// ── multiplayer ───────────────────────────────────────────────────────────

function openRoomEntry(): void {
  teardownRound();
  leaveRoom();
  screen = 'entry';
  document.body.classList.remove('playing');
  entryView?.destroy();
  entryView = createRoomEntry({
    container: main,
    onSubmit(code, created) {
      unlock();
      void enterRoom(code, created);
    },
    onCancel: () => showMenu(),
    subtitle: 'Start a new room, or enter a code to join a friend. Everyone plays the same strand.',
  });
}

async function enterRoom(code: string, created: boolean): Promise<void> {
  entryView?.destroy();
  entryView = null;
  multiplayerUsed = true;
  roomCode = normalizeRoomCode(code);
  setRoomInUrl(roomCode);
  main.replaceChildren(
    el('div', { class: 'lobby' }, [
      el('div', { class: 'lobby-searching' }, [el('span', { class: 'spinner' }), el('span', { text: 'Joining the room…' })]),
    ]),
  );

  await ensureTurn();
  if (net) return; // a second click while the first join was in flight

  net = createNet(
    { appId: roomAppId(SLUG), roomId: roomCode, claimHost: created },
    {
      onHostChange: (_id, isSelfHost) => {
        // Host transfer: the promoted peer already holds a byte-identical board
        // (lockstep), so the takeover is purely the turn clock.
        session?.setHost(isSelfHost);
      },
      onPeerLeave: (id) => {
        leftIds.add(id);
        if (screen === 'results') paintResults();
      },
    },
  );

  rounds = createRounds({
    net,
    playerName: myName(),
    minPlayers: 2,
    roundOpts: () => ({ mode: mode.id }),
    onRound: (info) => {
      const opts = info.opts as { mode?: string } | undefined;
      // The HOST's mode, frozen into the start. Rendering our own local pick and
      // calling it the host's is a confident lie, and it has shipped before.
      mode = modeOf(opts?.mode);
      if (!info.seated) {
        showLobby();
        return;
      }
      roster = info.players;
      leftIds = new Set();
      if (matchTally.length !== roster.length) matchTally = new Array(roster.length).fill(0);
      sessionSeats = roster.map((p) => ({ id: p.id, name: p.name }));
      beginRound({
        seed: info.seed,
        seats: sessionSeats,
        seatIndex: roster.findIndex((p) => p.id === net!.selfId),
        round: info.round,
        isHost: info.isHost,
      });
    },
    onChange: () => {
      // A repaint driven by a roster/vote change must NEVER navigate. It fires in
      // the lobby, during a round, and just after one ends; a `showMenu()` or a
      // blind board repaint here ejected both peers in a sibling game and painted
      // over the results screen in another.
      if (screen === 'results') paintResults();
    },
  });

  showLobby();
}

function showLobby(): void {
  if (!net || !rounds) return showMenu();
  teardownRound();
  screen = 'lobby';
  document.body.classList.remove('playing');
  main.replaceChildren();

  const modeRow = el('div', { class: 'panel', style: 'margin-bottom:12px' });
  const paintModeRow = (): void => {
    const s = rounds!.state();
    const hostOpts = s.hostOpts as { mode?: string } | undefined;
    const hostMode = modeOf(hostOpts?.mode);
    modeRow.replaceChildren(
      el('div', { class: 'strand-label', text: net!.isHost() ? 'Your pick (everyone plays it)' : "Host's pick" }),
    );
    if (net!.isHost()) {
      const row = el('div', { class: 'btn-row', style: 'margin-top:8px' });
      for (const m of allModes()) {
        const b = el('button', {
          class: 'btn sm',
          type: 'button',
          text: m.name,
          'aria-pressed': m.id === mode.id ? 'true' : 'false',
        });
        if (m.id === mode.id) b.style.borderColor = 'var(--seam)';
        b.addEventListener('click', () => {
          mode = m;
          store.set('mode', m.id);
          paintModeRow();
        });
        row.append(b);
      }
      modeRow.append(row);
    } else {
      modeRow.append(el('p', { style: 'margin:6px 0 0;font-weight:700', text: hostMode.name }));
      modeRow.append(el('p', { class: 'muted', style: 'margin:2px 0 0;font-size:13px', text: hostMode.blurb }));
    }
  };
  paintModeRow();
  const modePoll = setInterval(() => {
    if (screen === 'lobby') paintModeRow();
    else clearInterval(modePoll);
  }, 900);

  const holder = el('div');
  main.replaceChildren(modeRow, holder);

  lobbyView?.destroy();
  lobbyView = createLobby({
    container: holder,
    net,
    rounds,
    roomCode,
    minPlayers: 2,
    maxPlayers: 4,
    onCancel: () => showMenu(),
  });
}

function leaveRoom(): void {
  lobbyView?.destroy();
  lobbyView = null;
  entryView?.destroy();
  entryView = null;
  rounds?.destroy();
  rounds = null;
  roster = [];
  matchTally = [];
  leftIds = new Set();
  if (net) {
    void net.leave();
    net = null;
  }
}

window.addEventListener('beforeunload', () => {
  void net?.leave();
});

// ── go ────────────────────────────────────────────────────────────────────

(() => {
  const q = new URLSearchParams(location.search);
  const sharedSeed = q.get('seed');
  if (sharedSeed && !deepLinkRoom) {
    mode = modeOf(q.get('mode'));
    const seed = Number(sharedSeed);
    showMenu();
    if (Number.isFinite(seed)) startSolo([], seed >>> 0);
    return;
  }
  showMenu();
})();

export { inviteLink };
