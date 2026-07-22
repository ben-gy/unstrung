/**
 * takeover.test.ts — the host can leave and the round still reaches a result.
 * Live-P2P contract gate #2, and the automated half of the smoke test.
 *
 * Unstrung is lockstep, so a promoted peer inherits nothing it did not already
 * have: it derived the board from the same seed and the same move list as
 * everyone else. The ONE thing the host actually owns is the turn CLOCK and the
 * auto-play it broadcasts when the clock expires — so if `onHostChange` is not
 * wired, the failure is not a frozen board, it is subtler and worse: a player who
 * walks away, and a room that waits for them forever with no way out.
 *
 * That is exactly the shape of the rhythm-relay bug (`createNet` with no
 * handlers), and it is the reason this gate is proven twice — here without a
 * network, and again in a real two-tab smoke test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, type Session } from '../src/session';
import { modeOf } from '../src/modes';
import { legalCuts, type GameState, type PlayedMove } from '../src/game';
import type { Net, PeerId } from '@ben-gy/game-engine/net';

/**
 * A two-peer bus. Deliberately NOT a Trystero stub: this file is about the round
 * protocol above the transport, and the transport's own trap is pinned in
 * net-lifecycle.test.ts and trystero-rejoin.test.ts where it belongs.
 */
interface Bus {
  net(self: PeerId): Net;
  flush(): void;
  drop(id: PeerId): void;
  restore(id: PeerId): void;
}

function makeBus(): Bus {
  type H = { peer: PeerId; name: string; fn: (d: unknown, from: PeerId) => void };
  const handlers: H[] = [];
  const queue: Array<() => void> = [];
  const gone = new Set<PeerId>();

  return {
    net(self: PeerId): Net {
      const net = {
        selfId: self,
        peers: () => ['a', 'b'].filter((p) => !gone.has(p)),
        host: () => (gone.has('a') ? 'b' : 'a'),
        isHost: () => (gone.has('a') ? self === 'b' : self === 'a'),
        hostSettled: () => true,
        hostEpoch: () => 1,
        count: () => 2 - gone.size,
        onPeersChange: () => () => {},
        channel<T>(name: string, onReceive: (d: T, from: PeerId) => void) {
          const entry: H = { peer: self, name, fn: onReceive as H['fn'] };
          handlers.push(entry);
          const send = (data: T, to?: PeerId | PeerId[]): void => {
            const targets = to == null ? null : Array.isArray(to) ? to : [to];
            queue.push(() => {
              for (const h of handlers) {
                if (h.name !== name || h.peer === self || gone.has(h.peer)) continue;
                if (targets && !targets.includes(h.peer)) continue;
                h.fn(data, self);
              }
            });
          };
          send.off = (): void => {
            const i = handlers.indexOf(entry);
            if (i >= 0) handlers.splice(i, 1);
          };
          return send as ReturnType<Net['channel']>;
        },
        ping: async () => 0,
        takeover: () => {},
        netDiag: () => ({
          selfId: self,
          host: 'a',
          epoch: 1,
          settled: true,
          peers: ['a', 'b'],
          relaySockets: {},
          turn: false,
        }),
        leave: async () => {},
      };
      return net as unknown as Net;
    },
    flush() {
      for (let i = 0; i < 60 && queue.length; i++) {
        const batch = queue.splice(0, queue.length);
        for (const f of batch) f();
      }
    },
    drop(id: PeerId) {
      gone.add(id);
    },
    restore(id: PeerId) {
      gone.delete(id);
    },
  };
}

const MODE = modeOf('strand');
const SEED = 20_260_722;
const SEATS = [
  { id: 'a', name: 'Ann' },
  { id: 'b', name: 'Bo' },
];

interface Peer {
  session: Session;
  state: () => GameState;
  played: PlayedMove[];
  over: boolean;
}

function spawn(bus: Bus, self: PeerId, isHost: boolean): Peer {
  const played: PlayedMove[] = [];
  const peer: Peer = {
    session: null as unknown as Session,
    state: () => peer.session.state(),
    played,
    over: false,
  };
  peer.session = createSession({
    mode: MODE,
    seed: SEED,
    seats: SEATS,
    seatIndex: self === 'a' ? 0 : 1,
    round: 1,
    net: bus.net(self),
    isHost,
    onChange: () => {},
    onPlayed: (m) => played.push(m),
    onOver: () => {
      peer.over = true;
    },
  });
  return peer;
}

/** Make the seat whose turn it is play its first legal cut, locally. */
function playOne(p: Peer): boolean {
  const g = p.state();
  const cuts = legalCuts(g);
  if (!cuts.length) return false;
  return p.session.play(cuts[0]);
}

describe('host transfer', () => {
  let bus: Bus;
  let a: Peer;
  let b: Peer;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = makeBus();
    a = spawn(bus, 'a', true);
    b = spawn(bus, 'b', false);
    bus.flush();
  });

  afterEach(() => {
    a.session.destroy();
    b.session.destroy();
    vi.useRealTimers();
  });

  it('deals both peers the same board without sending one', () => {
    expect(b.state().strands.map((s) => s.letters.join(''))).toEqual(
      a.state().strands.map((s) => s.letters.join('')),
    );
  });

  it('keeps both peers in step as cuts are exchanged', () => {
    expect(playOne(a)).toBe(true);
    bus.flush();
    expect(b.state().ply).toBe(1);
    expect(b.state().scores).toEqual(a.state().scores);

    expect(playOne(b)).toBe(true);
    bus.flush();
    expect(a.state().ply).toBe(2);
    expect(a.state().strands[0].letters.join('')).toBe(b.state().strands[0].letters.join(''));
  });

  it('refuses a cut from a peer whose turn it is not', () => {
    // It is A's turn; B trying to move must change nothing anywhere.
    expect(playOne(b)).toBe(false);
    bus.flush();
    expect(a.state().ply).toBe(0);
    expect(b.state().ply).toBe(0);
  });

  it('does not let a NON-host peer adjudicate the clock', () => {
    // Nobody moves for well past the turn limit. B is not the host, so B must not
    // auto-play — two peers both adjudicating would double-move the room.
    vi.advanceTimersByTime(MODE.turnSeconds * 1000 + 2000);
    bus.flush();
    // Only ONE auto-play happened (the host's), not two.
    expect(a.state().ply).toBe(1);
    expect(b.state().ply).toBe(1);
  });

  it('lets the host auto-play a seat that has run out of time', () => {
    vi.advanceTimersByTime(MODE.turnSeconds * 1000 + 600);
    bus.flush();
    expect(a.state().ply).toBe(1);
    expect(b.state().ply).toBe(1);
    expect(b.state().scores).toEqual(a.state().scores);
  });

  describe('when the host leaves mid-round', () => {
    beforeEach(() => {
      expect(playOne(a)).toBe(true);
      bus.flush();
      bus.drop('a');
      a.session.destroy();
      // What main.ts does from net's onHostChange.
      b.session.setHost(true);
    });

    it('promotes the survivor onto the clock', () => {
      const before = b.state().ply;
      vi.advanceTimersByTime(MODE.turnSeconds * 1000 + 600);
      expect(b.state().ply).toBeGreaterThan(before);
    });

    it('reaches game over rather than waiting forever', () => {
      // The departed host's seat is now driven entirely by the survivor's clock.
      for (let i = 0; i < MODE.turnsEach * 2 + 4 && !b.over; i++) {
        if (b.session.myTurn()) playOne(b);
        vi.advanceTimersByTime(MODE.turnSeconds * 1000 + 600);
      }
      expect(b.over).toBe(true);
      expect(b.state().over).toBe(true);
      expect(b.state().ply).toBe(MODE.turnsEach * 2);
    });

    it('still has a full result for BOTH players, not just the survivor', () => {
      for (let i = 0; i < MODE.turnsEach * 2 + 4 && !b.over; i++) {
        if (b.session.myTurn()) playOne(b);
        vi.advanceTimersByTime(MODE.turnSeconds * 1000 + 600);
      }
      const g = b.state();
      expect(g.scores).toHaveLength(2);
      expect(g.history.filter((h) => h.player === 0).length).toBe(MODE.turnsEach);
      expect(g.history.filter((h) => h.player === 1).length).toBe(MODE.turnsEach);
    });

    it('resets the clock on promotion instead of inheriting a stale one', () => {
      // If the promoted peer kept the departed host's `turnStartedAt`, its very
      // first act would be to auto-play for whoever's turn it happens to be.
      const before = b.state().ply;
      vi.advanceTimersByTime(1000);
      expect(b.state().ply).toBe(before);
    });
  });
});

describe('lockstep recovery', () => {
  /**
   * The one thing lockstep MUST handle: a peer that misses a single message is
   * permanently one ply behind and will reject everything that follows. Without
   * the replay path, the board would silently stop being the same board — no
   * error, no symptom, just two people playing different games in one room.
   */
  it('replays the whole move list for a peer that missed one', () => {
    vi.useFakeTimers();
    const bus = makeBus();
    const a = spawn(bus, 'a', true);
    const b = spawn(bus, 'b', false);
    bus.flush();

    // A plays while B cannot hear anything.
    bus.drop('b');
    expect(playOne(a)).toBe(true);
    bus.flush();
    expect(b.state().ply).toBe(0);
    expect(a.state().ply).toBe(1);

    // B is back, and it is B's turn — but B still thinks it is A's. B's next
    // inbound message carries a ply from the future, which triggers the replay.
    bus.restore('b');
    vi.advanceTimersByTime(MODE.turnSeconds * 1000 + 600); // A's clock auto-plays for B
    bus.flush();
    bus.flush();

    expect(b.state().ply).toBe(a.state().ply);
    expect(b.state().strands[0].letters.join('')).toBe(a.state().strands[0].letters.join(''));
    expect(b.state().strands[0].seam.join('')).toBe(a.state().strands[0].seam.join(''));
    expect(b.state().scores).toEqual(a.state().scores);

    a.session.destroy();
    b.session.destroy();
    vi.useRealTimers();
  });
});
