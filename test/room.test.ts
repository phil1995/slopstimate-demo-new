import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, assertPrivate } from './harness';
const h = new Harness();
beforeAll(() => h.start());
afterAll(() => h.stop());
describe('durable room lifecycle', () => {
  it('creates random permanent rooms and does not initialize unknown rooms', async () => {
    const a = await h.room();
    const b = await h.room();
    expect(a.roomId).toMatch(/^[a-f0-9]{32}$/);
    expect(a.adminToken).toMatch(/^[a-f0-9]{64}$/);
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.adminToken).not.toBe(b.adminToken);
    expect((await h.snapshot(a.path, a.adminToken)).round).toBe(1);
    const unknown = `/api/rooms/${'a'.repeat(32)}`;
    expect((await h.request(unknown)).status).toBe(404);
    expect(
      (await h.request(`${unknown}/join`, { name: 'Visitor' })).status,
    ).toBe(404);
    expect((await h.request(unknown)).status).toBe(404);
  });
  it('uses the team deck, requires names, allows duplicates, and preserves fractional and skipped choices', async () => {
    const { path, adminToken } = await h.room();
    expect((await h.snapshot(path, adminToken)).deck).toEqual([
      '0',
      '0.5',
      '1',
      '2',
      '3',
      '8',
      '13',
      '?',
    ]);
    for (const input of [{}, { name: '' }, { name: '   ' }]) {
      expect((await h.request(`${path}/join`, input)).status).toBe(400);
    }
    const first = await h.join(path, 'Alex');
    const second = await h.join(path, 'Alex');
    expect(first.memberId).not.toBe(second.memberId);
    expect(second.room.members.map((m) => m.name)).toEqual(['Alex', 'Alex']);
    for (const [member, vote] of [
      [first, '0.5'],
      [second, '?'],
    ] as const) {
      const response = await h.request(
        `${path}/vote`,
        { vote, round: 1 },
        member.memberToken,
      );
      expect(response.status).toBe(200);
      assertPrivate((await response.json()) as never);
    }
    await h.request(`${path}/reveal`, { round: 1 }, adminToken);
    expect(
      (await h.snapshot(path, first.memberToken!)).members.map((m) => m.vote),
    ).toEqual(['0.5', '?']);
    expect(await h.snapshot(path, second.memberToken!)).toEqual(
      await h.snapshot(path, adminToken),
    );
  });
  it('reuses membership and changes names without creating duplicates', async () => {
    const room = await h.room();
    const joined = await h.join(room.path, '  Alex  ');
    expect(joined.memberToken).toMatch(/^[a-f0-9]{64}$/);
    const resumed = await h.join(room.path, 'Alexander', joined.memberToken);
    expect(resumed.memberId).toBe(joined.memberId);
    expect(resumed.memberToken).toBeUndefined();
    expect(resumed.room.members).toHaveLength(1);
    expect(resumed.room.members[0].name).toBe('Alexander');
    assertPrivate(resumed.room);
  });
  it('replaces private votes, reveals, locks, resets idempotently and rejects old votes', async () => {
    const { path, adminToken } = await h.room();
    const { memberToken } = await h.join(path);
    for (const vote of ['3', '8']) {
      const response = await h.request(
        `${path}/vote`,
        { vote, round: 1 },
        memberToken,
      );
      expect(response.status).toBe(200);
      assertPrivate((await response.json()) as never);
    }
    expect((await h.snapshot(path, adminToken)).members[0].voted).toBe(true);
    const publicData = await (await h.request(path)).json();
    expect(publicData).not.toHaveProperty('members');
    expect(
      (await h.request(`${path}/reveal`, { round: 1 }, adminToken)).status,
    ).toBe(200);
    const revealed = await h.snapshot(path, adminToken);
    expect(revealed.members[0].vote).toBe('8');
    await h.request(`${path}/reveal`, { round: 1 }, adminToken);
    expect((await h.snapshot(path, adminToken)).version).toBe(revealed.version);
    expect(
      (await h.request(`${path}/vote`, { vote: '0.5', round: 1 }, memberToken))
        .status,
    ).toBe(409);
    await h.request(`${path}/admin/reset`, { round: 1 }, adminToken);
    const reset = await h.snapshot(path, adminToken);
    expect(reset.round).toBe(2);
    expect(reset.members[0].voted).toBe(false);
    assertPrivate(reset);
    await h.request(`${path}/admin/reset`, { round: 1 }, adminToken);
    expect((await h.snapshot(path, adminToken)).version).toBe(reset.version);
    expect(
      (await h.request(`${path}/vote`, { vote: '3', round: 1 }, memberToken))
        .status,
    ).toBe(409);
    expect(
      (await h.request(`${path}/reveal`, { round: 1 }, adminToken)).status,
    ).toBe(409);
    expect(
      (await h.request(`${path}/admin/reset`, { round: 99 }, adminToken))
        .status,
    ).toBe(409);
  });
  it('atomically resets on deck changes and keeps title-only changes in the current round', async () => {
    const { path, adminToken } = await h.room();
    const { memberToken } = await h.join(path);
    await h.request(`${path}/vote`, { vote: '3', round: 1 }, memberToken);
    const original = await h.snapshot(path, adminToken);
    await h.request(
      `${path}/admin/settings`,
      {
        title: 'Sprint <script>',
        deck: original.deck,
        version: original.version,
      },
      adminToken,
    );
    const renamed = await h.snapshot(path, adminToken);
    expect(renamed.round).toBe(1);
    expect(renamed.members[0].voted).toBe(true);
    await h.request(
      `${path}/admin/settings`,
      { title: 'T-shirts', deck: ['S', 'M', 'L'], version: renamed.version },
      adminToken,
    );
    const changed = await h.snapshot(path, adminToken);
    expect(changed.round).toBe(2);
    expect(changed.deck).toEqual(['S', 'M', 'L']);
    expect(changed.members[0].voted).toBe(false);
    expect(
      (
        await h.request(
          `${path}/admin/settings`,
          { title: 'Old', deck: ['1', '2'], version: original.version },
          adminToken,
        )
      ).status,
    ).toBe(409);
  });
  it('serializes concurrent voting and reset without restoring previous votes', async () => {
    const { path, adminToken } = await h.room();
    const { memberToken } = await h.join(path);
    await Promise.all([
      h.request(`${path}/vote`, { vote: '8', round: 1 }, memberToken),
      h.request(`${path}/admin/reset`, { round: 1 }, adminToken),
    ]);
    const state = await h.snapshot(path, adminToken);
    expect(state.round).toBe(2);
    expect(state.members[0].voted).toBe(false);
    assertPrivate(state);
  });
  it('restores settings, identities, private votes, reveal and deletion after full runtime restarts', async () => {
    const { path, adminToken, roomId } = await h.room();
    const member = await h.join(path);
    const initial = await h.snapshot(path, adminToken);
    await h.request(
      `${path}/admin/settings`,
      { title: 'Weekly', deck: initial.deck, version: initial.version },
      adminToken,
    );
    await h.request(
      `${path}/vote`,
      { vote: '13', round: 1 },
      member.memberToken,
    );
    await h.restart();
    const restored = await h.snapshot(path, adminToken);
    expect(restored.title).toBe('Weekly');
    expect(restored.members[0].id).toBe(member.memberId);
    expect(restored.members[0].voted).toBe(true);
    assertPrivate(restored);
    expect(
      (await h.join(path, 'Alex returns', member.memberToken)).memberId,
    ).toBe(member.memberId);
    await h.request(`${path}/reveal`, { round: 1 }, adminToken);
    await h.restart();
    expect((await h.snapshot(path, adminToken)).members[0].vote).toBe('13');
    await h.request(path, {}, adminToken, 'DELETE');
    await h.restart();
    expect((await h.request(path)).status).toBe(404);
    expect(
      (await h.request(`${path}/join`, { name: 'Resurrect' })).status,
    ).toBe(404);
    expect((await h.request(`/__test/create/${roomId}`)).status).toBe(409);
    expect((await h.request(path)).status).toBe(404);
  });
});
