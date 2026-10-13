import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from './harness';
const h = new Harness();
beforeAll(() => h.start());
afterAll(() => h.stop());
describe('authorization and input defenses', () => {
  it('denies every admin action to members, strangers and malformed secrets', async () => {
    const { path, adminToken } = await h.room();
    const member = await h.join(path);
    for (const token of [
      undefined,
      'f'.repeat(64),
      member.memberToken,
      'short',
    ]) {
      for (const action of ['reset', 'settings', 'remove-member']) {
        const response = await h.request(
          `${path}/admin/${action}`,
          { round: 1 },
          token,
        );
        expect([401, 403]).toContain(response.status);
      }
      expect([401, 403]).toContain(
        (await h.request(path, {}, token, 'DELETE')).status,
      );
    }
    expect((await h.snapshot(path, adminToken)).round).toBe(1);
    expect((await h.snapshot(path, adminToken)).revealed).toBe(false);
  });
  it('allows every joined member to reveal through either route and denies strangers or revoked identities', async () => {
    const { path, adminToken } = await h.room();
    const member = await h.join(path, 'Participant');
    const removed = await h.join(path, 'Removed');
    await h.request(
      `${path}/admin/remove-member`,
      { memberId: removed.memberId },
      adminToken,
    );
    await h.request(
      `${path}/vote`,
      { vote: '0.5', round: 1 },
      member.memberToken,
    );
    for (const route of ['/reveal', '/admin/reveal']) {
      for (const token of [
        undefined,
        'f'.repeat(64),
        'invalid',
        removed.memberToken,
      ]) {
        expect(
          (await h.request(`${path}${route}`, { round: 1 }, token)).status,
        ).toBe(401);
      }
      expect((await h.snapshot(path, adminToken)).revealed).toBe(false);
    }
    expect(
      (await h.request(`${path}/reveal`, { round: 2 }, member.memberToken))
        .status,
    ).toBe(409);
    const revealed = await h.request(
      `${path}/reveal`,
      { round: 1 },
      member.memberToken,
    );
    expect(revealed.status).toBe(200);
    const snapshot = await h.snapshot(path, member.memberToken!);
    expect(snapshot.revealed).toBe(true);
    expect(snapshot.members[0].vote).toBe('0.5');
    await h.request(`${path}/admin/reveal`, { round: 1 }, member.memberToken);
    expect((await h.snapshot(path, adminToken)).version).toBe(snapshot.version);
    await h.request(`${path}/admin/reset`, { round: 1 }, adminToken);
    expect(
      (await h.request(`${path}/reveal`, { round: 1 }, member.memberToken))
        .status,
    ).toBe(409);
    // Joining suffices; voting is not a prerequisite for revealing.
    const nonVoter = await h.join(path, 'Non-voter');
    expect(
      (
        await h.request(
          `${path}/admin/reveal`,
          { round: 2 },
          nonVoter.memberToken,
        )
      ).status,
    ).toBe(200);
  });
  it('removes saved members durably, revokes their identity, and makes repeated removals safe', async () => {
    const { path, adminToken } = await h.room();
    const removed = await h.join(path, 'Stale joiner');
    const kept = await h.join(path, 'Current member');
    await h.request(
      `${path}/vote`,
      { vote: '0.5', round: 1 },
      removed.memberToken,
    );
    await h.request(`${path}/vote`, { vote: '8', round: 1 }, kept.memberToken);
    await h.request(`${path}/reveal`, { round: 1 }, adminToken);
    for (const memberId of [null, 'invalid', 123]) {
      expect(
        (
          await h.request(
            `${path}/admin/remove-member`,
            { memberId },
            adminToken,
          )
        ).status,
      ).toBe(400);
    }
    const response = await h.request(
      `${path}/admin/remove-member`,
      { memberId: removed.memberId },
      adminToken,
    );
    expect(response.status).toBe(200);
    const snapshot = await h.snapshot(path, adminToken);
    expect(snapshot.members.map((m) => m.id)).toEqual([kept.memberId]);
    expect(snapshot.members[0].vote).toBe('8');
    expect(snapshot.revealed).toBe(true);
    await h.request(
      `${path}/admin/remove-member`,
      { memberId: removed.memberId },
      adminToken,
    );
    expect((await h.snapshot(path, adminToken)).version).toBe(snapshot.version);
    await h.restart();
    expect(
      (await h.snapshot(path, adminToken)).members.map((m) => m.id),
    ).toEqual([kept.memberId]);
    expect(
      (await h.request(`${path}/join`, { name: 'Return' }, removed.memberToken))
        .status,
    ).toBe(401);
    expect(
      (
        await h.request(
          `${path}/vote`,
          { vote: '1', round: 1 },
          removed.memberToken,
        )
      ).status,
    ).toBe(401);
    expect((await h.join(path, 'Stale joiner')).memberId).not.toBe(
      removed.memberId,
    );
  });
  it('rejects impersonation and invalidates departed member secrets', async () => {
    const { path } = await h.room();
    const member = await h.join(path);
    expect(
      (
        await h.request(`${path}/vote`, {
          memberId: member.memberId,
          vote: '8',
          round: 1,
        })
      ).status,
    ).toBe(401);
    expect(
      (await h.request(`${path}/vote`, { vote: '8', round: 1 }, 'e'.repeat(64)))
        .status,
    ).toBe(401);
    expect(
      (await h.request(`${path}/leave`, {}, member.memberToken)).status,
    ).toBe(200);
    expect(
      (await h.request(`${path}/join`, { name: 'Again' }, member.memberToken))
        .status,
    ).toBe(401);
    expect(
      (
        await h.request(
          `${path}/vote`,
          { vote: '8', round: 1 },
          member.memberToken,
        )
      ).status,
    ).toBe(401);
  });
  it('validates names, deck options, choices, rounds and unexpected fields', async () => {
    const { path, adminToken } = await h.room();
    const member = await h.join(path);
    for (const name of ['', 'a'.repeat(41), '\u0000bad', 22])
      expect((await h.request(`${path}/join`, { name })).status).toBe(400);
    const state = await h.snapshot(path, adminToken);
    for (const deck of [
      [],
      ['1'],
      ['1', '1'],
      ['1', ' 1 '],
      ['1', ''],
      ['1', 'x'.repeat(17)],
      Array.from({ length: 21 }, (_, i) => String(i)),
      [1, 2],
    ]) {
      expect(
        (
          await h.request(
            `${path}/admin/settings`,
            { title: 'Room', deck, version: state.version },
            adminToken,
          )
        ).status,
      ).toBe(400);
    }
    for (const vote of ['100', '<img>', '', 3])
      expect(
        (
          await h.request(
            `${path}/vote`,
            { vote, round: 1 },
            member.memberToken,
          )
        ).status,
      ).toBe(400);
    for (const round of [0, -1, 1.2, '1'])
      expect(
        (
          await h.request(
            `${path}/vote`,
            { vote: '3', round },
            member.memberToken,
          )
        ).status,
      ).toBe(400);
    expect(
      (
        await h.request(
          `${path}/vote`,
          { vote: '3', round: 1, isAdmin: true },
          member.memberToken,
        )
      ).status,
    ).toBe(400);
  });
  it('rejects cross-origin and missing-origin mutations and WebSocket upgrades', async () => {
    const { path, adminToken } = await h.room();
    for (const origin of [
      undefined,
      'https://evil.test',
      'https://poker.test.evil.test',
    ]) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      };
      if (origin) headers.Origin = origin;
      const response = await h.mf.dispatchFetch(
        `https://poker.test${path}/reveal`,
        { method: 'POST', headers, body: '{"round":1}' },
      );
      expect(response.status).toBe(403);
      expect(
        (
          await h.mf.dispatchFetch(`https://poker.test${path}/ws`, {
            headers: { ...headers, Upgrade: 'websocket' },
          })
        ).status,
      ).toBe(403);
    }
    expect((await h.request(`${path}?adminToken=abc`)).status).toBe(400);
    const response = await h.request(path);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
  it('limits JSON bytes including chunked bodies and rejects invalid JSON or content types', async () => {
    const { path } = await h.room();
    expect(
      (await h.request(`${path}/join`, { name: 'x'.repeat(5000) })).status,
    ).toBe(413);
    const response = await h.mf.dispatchFetch(
      `https://poker.test${path}/join`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://poker.test',
          'Content-Type': 'application/json',
        },
        body: '{broken',
      },
    );
    expect(response.status).toBe(400);
    expect(
      (
        await h.mf.dispatchFetch(`https://poker.test${path}/join`, {
          method: 'POST',
          headers: { Origin: 'https://poker.test' },
          body: '{}',
        })
      ).status,
    ).toBe(415);
    expect((await h.request(`/api/rooms/${'x'.repeat(2200)}`)).status).toBe(
      414,
    );
  });
  it('enforces durable member mutation and join limits', async () => {
    const { path } = await h.room();
    const { memberToken } = await h.join(path);
    let response;
    for (let i = 0; i < 61; i++)
      response = await h.request(
        `${path}/vote`,
        { vote: i % 2 ? '3' : '0.5', round: 1 },
        memberToken,
      );
    expect(response!.status).toBe(429);
    await h.restart();
    expect(
      (await h.request(`${path}/vote`, { vote: '8', round: 1 }, memberToken))
        .status,
    ).toBe(429);
    const joinedRoom = await h.room();
    for (let i = 0; i < 31; i++)
      response = await h.request(
        `${joinedRoom.path}/join`,
        { name: `Member ${i}` },
        undefined,
        'POST',
        '198.51.100.2',
      );
    expect(response!.status).toBe(429);
  });
  it('caps saved members and rate limits room creation', async () => {
    const { path } = await h.room();
    for (let i = 0; i < 50; i++) {
      expect(
        (
          await h.request(
            `${path}/join`,
            { name: `Person ${i}` },
            undefined,
            'POST',
            `203.0.113.${i}`,
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await h.request(
          `${path}/join`,
          { name: 'Extra' },
          undefined,
          'POST',
          '203.0.113.100',
        )
      ).status,
    ).toBe(409);
    let response;
    for (let i = 0; i < 11; i++)
      response = await h.request(
        '/api/rooms',
        {},
        undefined,
        'POST',
        '198.51.100.90',
      );
    expect(response!.status).toBe(429);
  });
});
