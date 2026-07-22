// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * session.ts — one round, wherever it is being played.
 *
 * Solo, solo-vs-bots and live P2P all run through here, because they are the same
 * round: the difference is only who supplies the cuts.
 *
 * ── The netcode, and why it has almost no surface ───────────────────────────
 * LOCKSTEP, not a snapshot star. After the deal there is zero randomness and zero
 * hidden information — the strand, the spool and every refill word are pure
 * functions of (seed, mode, move list) — so every peer runs the identical reducer
 * over the identical moves and NO BOARD STATE EVER CROSSES THE WIRE. A cut is
 * `{round, ply, s, i, len}`, five small numbers.
 *
 * That collapses the usual desync surface to nothing, and it collapses host
 * transfer with it: the promoted peer already holds a byte-identical board,
 * because it derived it the same way everyone else did. The ONLY thing the host
 * actually owns is the turn CLOCK — and the auto-play it broadcasts when the
 * clock runs out — so `setHost(true)` is the whole takeover.
 *
 * The one thing lockstep must handle is a MISSED move, because a peer that drops
 * one is permanently one ply behind and will reject everything after it. Each cut
 * carries the ply it belongs to; a peer that sees a future ply asks for the whole
 * move list and replays it from the deal. Replaying from the deal rather than
 * patching forward means the recovery path and the normal path produce the same
 * bytes.
 */

import {
  applyCut,
  createGame,
  cutsLeft,
  isLegal,
  legalCuts,
  type GameState,
  type Move,
  type PlayedMove,
} from './game';
import { dealStrands } from './strand';
import { chooseCut, type Strength } from './bot';
import { turnsFor, type Mode } from './modes';
import { makeRng } from '@ben-gy/game-engine/rng';
import type { Net, PeerId } from '@ben-gy/game-engine/net';

export interface SeatSpec {
  id: string;
  name: string;
  /** Set for an AI seat. Bots are local-only; a P2P room seats humans. */
  bot?: Strength;
}

export interface SessionConfig {
  mode: Mode;
  seed: number;
  seats: SeatSpec[];
  /** Which seat the local player occupies, or -1 when spectating. */
  seatIndex: number;
  round: number;
  net?: Net | null;
  isHost: boolean;
  onChange: (g: GameState) => void;
  /** A cut landed. `local` is true when this peer made it. */
  onPlayed: (m: PlayedMove, local: boolean) => void;
  onOver: (g: GameState) => void;
}

/** How long a bot "thinks", so its move reads as a move and not a glitch. */
const BOT_THINK_MS = 850;

export interface Session {
  state(): GameState;
  /** Try a local cut. Returns false when it is illegal or not our turn. */
  play(m: Move): boolean;
  /** Seconds left on the current turn, or null when there is no clock. */
  clock(): number | null;
  myTurn(): boolean;
  seatOf(id: PeerId): number;
  /** Promotion: this peer now owns the turn clock. */
  setHost(isHost: boolean): void;
  destroy(): void;
}

interface CutMsg {
  round: number;
  ply: number;
  s: number;
  i: number;
  len: number;
}

interface HistMsg {
  round: number;
  moves: Move[];
}

export function createSession(cfg: SessionConfig): Session {
  const players = cfg.seats.length;
  const turnsEach = turnsFor(cfg.mode, players);
  const woven = dealStrands({
    seed: cfg.seed,
    letters: cfg.mode.letters,
    minLen: cfg.mode.minLen,
    maxLen: cfg.mode.maxLen,
    turnsEach,
    players,
  });

  let g = createGame({
    strands: woven.strands,
    spools: woven.spools,
    refillSeed: cfg.seed,
    turnsEach,
    minLen: cfg.mode.minLen,
    maxLen: cfg.mode.maxLen,
    players,
  });

  /** Every move applied, so a peer that fell behind can be replayed from the deal. */
  const moves: Move[] = [];
  const botRng = makeRng(`bot:${cfg.seed}`);
  let isHost = cfg.isHost;
  let destroyed = false;
  let turnStartedAt = Date.now();
  let botTimer: ReturnType<typeof setTimeout> | undefined;
  /** The ply the bot timer was armed for, so a repaint cannot keep resetting it. */
  let botArmedFor = -1;
  let clockTimer: ReturnType<typeof setInterval> | undefined;

  const hasClock = (): boolean => !!cfg.net && players > 1;

  function seatOf(id: PeerId): number {
    return cfg.seats.findIndex((s) => s.id === id);
  }

  function myTurn(): boolean {
    return !g.over && cfg.seatIndex >= 0 && g.turn === cfg.seatIndex;
  }

  // ── the wire ────────────────────────────────────────────────────────────
  const sendCut = cfg.net?.channel<CutMsg>('cut', (msg, from) => {
    if (msg.round !== cfg.round || destroyed) return;
    if (msg.ply < g.ply) return; // already have it
    if (msg.ply > g.ply) {
      // We missed something. Ask for the whole list rather than guessing.
      sendReq?.(null, from);
      return;
    }
    // Only the seat whose turn it is may move — and only from the peer that owns
    // that seat, or from the host (which auto-plays a seat whose clock expired).
    const mover = seatOf(from);
    if (mover !== g.turn && from !== cfg.net?.host()) return;
    apply({ s: msg.s, i: msg.i, len: msg.len }, false);
  });

  const sendHist = cfg.net?.channel<HistMsg>('hist', (msg) => {
    if (msg.round !== cfg.round || destroyed) return;
    if (msg.moves.length <= moves.length) return;
    replay(msg.moves);
  });

  const sendReq = cfg.net?.channel<null>('req', (_d, from) => {
    sendHist?.({ round: cfg.round, moves }, from);
  });

  function replay(list: Move[]): void {
    let next = createGame({
      strands: woven.strands,
      spools: woven.spools,
      refillSeed: cfg.seed,
      turnsEach,
      minLen: cfg.mode.minLen,
      maxLen: cfg.mode.maxLen,
      players,
    });
    const accepted: Move[] = [];
    for (const m of list) {
      if (!isLegal(next, m)) break;
      next = applyCut(next, m).state;
      accepted.push(m);
    }
    g = next;
    moves.length = 0;
    moves.push(...accepted);
    turnStartedAt = Date.now();
    cfg.onChange(g);
    if (g.over) cfg.onOver(g);
    else armBot();
  }

  // ── applying a cut ──────────────────────────────────────────────────────
  function apply(m: Move, local: boolean): boolean {
    if (g.over || !isLegal(g, m)) return false;
    const res = applyCut(g, m);
    g = res.state;
    moves.push(m);
    turnStartedAt = Date.now();
    cfg.onPlayed(res.played, local);
    cfg.onChange(g);
    if (g.over) {
      stopClock();
      clearBot();
      cfg.onOver(g);
      return true;
    }
    armBot();
    return true;
  }

  function play(m: Move): boolean {
    if (!myTurn()) return false;
    const ply = g.ply;
    if (!apply(m, true)) return false;
    sendCut?.({ round: cfg.round, ply, s: m.s, i: m.i, len: m.len });
    return true;
  }

  // ── bots ────────────────────────────────────────────────────────────────
  function clearBot(): void {
    if (botTimer) clearTimeout(botTimer);
    botTimer = undefined;
    botArmedFor = -1;
  }

  /**
   * Arm the bot's think timer — ONCE per ply.
   *
   * The `botArmedFor` guard is not tidiness. Re-arming on every repaint means any
   * poll faster than the think delay cancels the timer moments before it fires,
   * and the game hangs on a board that looks completely normal with the HUD
   * cheerfully saying "thinking…". That exact bug shipped in a sibling game.
   */
  function armBot(): void {
    if (destroyed || g.over) return;
    const seat = cfg.seats[g.turn];
    if (!seat?.bot) return clearBot();
    if (botArmedFor === g.ply) return;
    clearBot();
    botArmedFor = g.ply;
    botTimer = setTimeout(() => {
      botTimer = undefined;
      if (destroyed || g.over || !cfg.seats[g.turn]?.bot) return;
      const m = chooseCut(g, cfg.seats[g.turn].bot!, botRng);
      if (m) apply(m, false);
    }, BOT_THINK_MS);
  }

  // ── the turn clock (host-only authority) ────────────────────────────────
  function stopClock(): void {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = undefined;
  }

  /**
   * setInterval, never rAF. A host that tabs away must keep adjudicating, or the
   * room silently stops the moment the host looks at something else.
   */
  function startClock(): void {
    stopClock();
    if (!hasClock()) return;
    clockTimer = setInterval(() => {
      if (destroyed || g.over || !isHost) return;
      if (Date.now() - turnStartedAt < cfg.mode.turnSeconds * 1000) return;
      // Time is up. Auto-play the FIRST legal cut — `legalCuts` order is stable,
      // so every peer would derive the same forced move from the same board, and
      // a slow player costs the room a weak move rather than a deadlock.
      const cuts = legalCuts(g);
      if (!cuts.length) return;
      const ply = g.ply;
      const m = cuts[0];
      if (apply(m, false)) sendCut?.({ round: cfg.round, ply, s: m.s, i: m.i, len: m.len });
    }, 500);
  }

  startClock();
  cfg.onChange(g);
  armBot();

  return {
    state: () => g,
    play,
    clock() {
      if (!hasClock() || g.over) return null;
      const left = cfg.mode.turnSeconds - (Date.now() - turnStartedAt) / 1000;
      return Math.max(0, Math.ceil(left));
    },
    myTurn,
    seatOf,
    setHost(next: boolean) {
      isHost = next;
      // A promoted host inherits the clock from now, not from whenever the
      // departed host last reset it — otherwise the survivor's first act is to
      // auto-play for whoever's turn it happens to be.
      turnStartedAt = Date.now();
      startClock();
    },
    destroy() {
      destroyed = true;
      stopClock();
      clearBot();
      (sendCut as unknown as { off?: () => void })?.off?.();
      (sendHist as unknown as { off?: () => void })?.off?.();
      (sendReq as unknown as { off?: () => void })?.off?.();
    },
  };
}

export { cutsLeft };
