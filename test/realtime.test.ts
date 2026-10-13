import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, assertPrivate, waitUntil } from './harness';
import type { RoomSnapshot } from '../src/shared/protocol';
const h = new Harness();
beforeAll(() => h.start());
afterAll(() => h.stop());
describe('authenticated realtime and presence', () => {
  it('counts duplicate tabs once, broadcasts committed redacted snapshots, reveals and resets everywhere', async () => {
    const { path, adminToken } = await h.room();
    const alex = await h.join(path, 'Alex');
    const jo = await h.join(path, 'Jo');
    const a = await h.socket(path, {
      memberToken: alex.memberToken,
      adminToken,
    });
    const duplicate = await h.socket(path, { memberToken: alex.memberToken });
    const b = await h.socket(path, { memberToken: jo.memberToken });
    let snapshot = await h.snapshot(path, adminToken);
    expect(snapshot.members).toHaveLength(2);
    expect(snapshot.members.filter((m) => m.connected)).toHaveLength(2);
    await h.request(`${path}/vote`, { vote: '13', round: 1 }, alex.memberToken);
    await waitUntil(() =>
      b.events.some(
        (e) =>
          e.type === 'snapshot' &&
          e.room.members.find((m) => m.id === alex.memberId)?.voted === true,
      ),
    );
    for (const client of [a, duplicate, b]) {
      for (const event of client.events)
        if (event.type === 'snapshot') assertPrivate(event.room);
      const versions = client.events
        .filter((e) => e.type === 'snapshot')
        .map((e) => e.version);
      expect(versions).toEqual([...versions].sort((x, y) => x - y));
    }
    await h.request(`${path}/reveal`, { round: 1 }, adminToken);
    await waitUntil(() =>
      [a, duplicate, b].every((client) =>
        client.events.some(
          (e) =>
            e.type === 'snapshot' &&
            e.room.revealed &&
            e.room.members[0].vote === '13',
        ),
      ),
    );
    const returning = await h.socket(path, { memberToken: jo.memberToken });
    expect(
      returning.events.some(
        (e) => e.type === 'snapshot' && e.room.members[0].vote === '13',
      ),
    ).toBe(true);
    await h.request(`${path}/admin/reset`, { round: 1 }, adminToken);
    await waitUntil(() =>
      [a, duplicate, b, returning].every((client) =>
        client.events.some(
          (e) =>
            e.type === 'snapshot' &&
            e.room.round === 2 &&
            !e.room.members[0].voted,
        ),
      ),
    );
    duplicate.ws.close();
    await waitUntil(() => duplicate.ws.readyState === 3);
    snapshot = await h.snapshot(path, adminToken);
    expect(snapshot.members[0].connected).toBe(true);
    a.ws.close();
    await waitUntil(() =>
      b.events.some(
        (e) => e.type === 'snapshot' && !e.room.members[0].connected,
      ),
    );
    b.ws.close();
    returning.ws.close();
  });
  it('broadcasts participant-triggered reveals to admins and other members and locks voting', async () => {
    const { path, adminToken } = await h.room();
    const first = await h.join(path, 'Alex');
    const second = await h.join(path, 'Sam');
    const admin = await h.socket(path, { adminToken });
    const participant = await h.socket(path, {
      memberToken: first.memberToken,
    });
    const other = await h.socket(path, { memberToken: second.memberToken });
    await h.request(
      `${path}/vote`,
      { vote: '0.5', round: 1 },
      first.memberToken,
    );
    await h.request(
      `${path}/vote`,
      { vote: '?', round: 1 },
      second.memberToken,
    );
    for (const client of [admin, participant, other]) {
      for (const event of client.events)
        if (event.type === 'snapshot') assertPrivate(event.room);
    }
    expect(
      (await h.request(`${path}/reveal`, { round: 1 }, first.memberToken))
        .status,
    ).toBe(200);
    await waitUntil(() =>
      [admin, participant, other].every((client) =>
        client.events.some(
          (event) =>
            event.type === 'snapshot' &&
            event.room.revealed &&
            event.room.members[0].vote === '0.5' &&
            event.room.members[1].vote === '?',
        ),
      ),
    );
    expect(
      (
        await h.request(
          `${path}/vote`,
          { vote: '3', round: 1 },
          second.memberToken,
        )
      ).status,
    ).toBe(409);
    admin.ws.close();
    participant.ws.close();
    other.ws.close();
  });
  it('sends no roster or voting data to unauthenticated sockets and rejects actions and oversized frames', async () => {
    const { path } = await h.room();
    const member = await h.join(path);
    const unauth = await h.socket(path);
    await h.request(
      `${path}/vote`,
      { vote: '8', round: 1 },
      member.memberToken,
    );
    expect(unauth.events).toHaveLength(0);
    unauth.ws.send(
      JSON.stringify({ type: 'vote', vote: '0.5', memberId: member.memberId }),
    );
    await waitUntil(() => unauth.ws.readyState === 3);
    expect(unauth.events.every((e) => e.type === 'error')).toBe(true);
    const oversized = await h.socket(path);
    oversized.ws.send('x'.repeat(1025));
    await waitUntil(() => oversized.ws.readyState === 3);
    expect(oversized.events).toHaveLength(0);
    const timeout = await h.socket(path);
    await waitUntilLong(() => timeout.ws.readyState === 3);
    expect(timeout.events).toHaveLength(0);
  }, 40_000);
  it('revokes all tabs on leave and notifies all connected members on deletion', async () => {
    const { path, adminToken } = await h.room();
    const member = await h.join(path);
    const first = await h.socket(path, { memberToken: member.memberToken });
    const second = await h.socket(path, { memberToken: member.memberToken });
    const admin = await h.socket(path, { adminToken });
    await h.request(`${path}/leave`, {}, member.memberToken);
    await waitUntil(() =>
      [first, second].every((client) =>
        client.events.some((e) => e.type === 'membership_removed'),
      ),
    );
    expect((await h.snapshot(path, adminToken)).members).toHaveLength(0);
    await h.request(path, {}, adminToken, 'DELETE');
    await waitUntil(() => admin.events.some((e) => e.type === 'room_deleted'));
  });
  it('admin removal revokes every target tab and updates all remaining participants', async () => {
    const { path, adminToken } = await h.room();
    const target = await h.join(path, 'Alex');
    const remaining = await h.join(path, 'Alex');
    const first = await h.socket(path, { memberToken: target.memberToken });
    const second = await h.socket(path, { memberToken: target.memberToken });
    const observer = await h.socket(path, {
      memberToken: remaining.memberToken,
    });
    const admin = await h.socket(path, { adminToken });
    await h.request(
      `${path}/vote`,
      { vote: '?', round: 1 },
      target.memberToken,
    );
    await h.request(
      `${path}/admin/remove-member`,
      { memberId: target.memberId },
      adminToken,
    );
    await waitUntil(() =>
      [first, second].every((client) =>
        client.events.some((event) => event.type === 'membership_removed'),
      ),
    );
    await waitUntil(() =>
      [observer, admin].every((client) =>
        client.events.some(
          (event) =>
            event.type === 'snapshot' &&
            event.room.members.length === 1 &&
            event.room.members[0].id === remaining.memberId,
        ),
      ),
    );
    assertPrivate(await h.snapshot(path, adminToken));
    expect(
      (await h.snapshot(path, remaining.memberToken!)).members[0].connected,
    ).toBe(true);
    observer.ws.close();
    admin.ws.close();
  });
  it('restores verified socket attachments and presence after hibernation', async () => {
    const { path, roomId, adminToken } = await h.room();
    const alex = await h.join(path, 'Alex');
    const jo = await h.join(path, 'Jo');
    const a = await h.socket(path, {
      memberToken: alex.memberToken,
      adminToken,
    });
    const b = await h.socket(path, { memberToken: jo.memberToken });
    await h.mf.unsafeEvictDurableObject('slopstimate-test', 'RoomObject', {
      name: roomId,
      webSockets: 'hibernate',
    });
    await h.request(
      `${path}/vote`,
      { vote: '0.5', round: 1 },
      alex.memberToken,
    );
    await waitUntil(() =>
      b.events.some((e) => e.type === 'snapshot' && e.room.members[0].voted),
    );
    const restored = await h.snapshot(path, adminToken);
    expect(restored.members.filter((m) => m.connected)).toHaveLength(2);
    assertPrivate(restored);
    await h.request(`${path}/reveal`, { round: 1 }, adminToken);
    await waitUntil(() =>
      a.events.some(
        (e) => e.type === 'snapshot' && e.room.members[0].vote === '0.5',
      ),
    );
    a.ws.close();
    b.ws.close();
  });
  it('verifies admin authority independently of a revoked membership', async () => {
    const { path, adminToken } = await h.room();
    const admin = await h.socket(path, {
      adminToken,
      memberToken: 'a'.repeat(64),
    });
    expect(admin.events).toContainEqual({
      type: 'authenticated',
      memberId: null,
      isAdmin: true,
    });
    admin.ws.close();
    const member = await h.join(path);
    const participant = await h.socket(path, {
      memberToken: member.memberToken,
      adminToken: 'b'.repeat(64),
    });
    expect(participant.events).toContainEqual({
      type: 'authenticated',
      memberId: member.memberId,
      isAdmin: false,
    });
    participant.ws.close();
  });
  it('supports ping without mutating state and reauthenticates from durable state after runtime replacement', async () => {
    const { path, adminToken } = await h.room();
    const member = await h.join(path);
    const a = await h.socket(path, {
      memberToken: member.memberToken,
      adminToken,
    });
    const before = await h.snapshot(path, adminToken);
    a.ws.send('ping');
    await waitUntil(() => a.messages.includes('pong'));
    expect((await h.snapshot(path, adminToken)).version).toBe(before.version);
    a.ws.close();
    await waitUntil(() => a.ws.readyState === 3);
    await h.restart();
    const recovered = await h.socket(path, {
      memberToken: member.memberToken,
      adminToken,
    });
    expect(recovered.events).toContainEqual({
      type: 'authenticated',
      memberId: member.memberId,
      isAdmin: true,
    });
    const state = recovered.events.find((e) => e.type === 'snapshot') as {
      room: RoomSnapshot;
    };
    expect(state.room.members).toHaveLength(1);
    expect(state.room.members[0].connected).toBe(true);
    recovered.ws.close();
  });
});
async function waitUntilLong(predicate: () => boolean) {
  await expect.poll(predicate, { timeout: 30_000, interval: 100 }).toBe(true);
}
