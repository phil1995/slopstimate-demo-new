import { describe, expect, it } from 'vitest';
import { summarizeEstimates } from '../src/client/estimates';
import type { RoomSnapshot } from '../src/shared/protocol';

function snapshot(
  votes: (string | null | undefined)[],
  revealed = true,
): RoomSnapshot {
  return {
    id: 'room',
    title: 'Planning Poker',
    deck: ['0', '0.5', '1', '2', '3', '8', '13', '?'],
    round: 1,
    version: 1,
    revealed,
    members: votes.map((vote, index) => ({
      id: String(index),
      name: `Person ${index}`,
      connected: index % 2 === 0,
      voted: vote !== null && vote !== undefined,
      ...(vote !== undefined ? { vote } : {}),
    })),
  };
}

describe('revealed estimation summary', () => {
  it('does not expose an average before reveal or before loading', () => {
    expect(summarizeEstimates(null)).toBeNull();
    expect(summarizeEstimates(snapshot(['8', '13'], false))).toBeNull();
  });
  it('includes zero and fractional estimates, including saved members', () => {
    expect(summarizeEstimates(snapshot(['0', '0.5', '1', '3']))).toMatchObject({
      mean: 1.125,
      count: 4,
    });
    expect(summarizeEstimates(snapshot(['0']))).toMatchObject({
      mean: 0,
      count: 1,
    });
  });
  it('excludes skipped, missing, and nonnumeric choices', () => {
    expect(
      summarizeEstimates(
        snapshot([
          '?',
          'XS',
          null,
          undefined,
          '',
          '0x10',
          'Infinity',
          'NaN',
          '1e3',
          '8',
          '13',
        ]),
      ),
    ).toMatchObject({ mean: 10.5, count: 2 });
  });
  it('represents an empty or all-skipped estimation without a misleading zero', () => {
    expect(summarizeEstimates(snapshot([]))).toMatchObject({
      mean: null,
      count: 0,
    });
    expect(summarizeEstimates(snapshot(['?', null]))).toMatchObject({
      mean: null,
      count: 0,
    });
  });
  it('recomputes from current members and disappears on reset', () => {
    const room = snapshot(['1', '3']);
    expect(summarizeEstimates(room)).toMatchObject({ mean: 2, count: 2 });
    room.members.pop();
    expect(summarizeEstimates(room)).toMatchObject({ mean: 1, count: 1 });
    room.revealed = false;
    room.members[0].vote = undefined;
    expect(summarizeEstimates(room)).toBeNull();
  });
  it('rates identical and single numeric estimates as Low, including zero', () => {
    for (const votes of [['0'], ['0', '0'], ['3', '3'], ['13', '?']]) {
      expect(summarizeEstimates(snapshot(votes))?.disagreement).toBe('Low');
    }
  });
  it('uses relative population spread with inclusive 25% and 50% boundaries', () => {
    // [3, 5] has mean 4 and deviation 1; [1, 3] has mean 2 and deviation 1.
    expect(summarizeEstimates(snapshot(['3', '5']))?.disagreement).toBe('Low');
    expect(summarizeEstimates(snapshot(['2', '4']))?.disagreement).toBe(
      'Medium',
    );
    expect(summarizeEstimates(snapshot(['1', '3']))?.disagreement).toBe(
      'Medium',
    );
    expect(summarizeEstimates(snapshot(['0', '13']))?.disagreement).toBe(
      'High',
    );
    expect(summarizeEstimates(snapshot(['-3', '-5']))?.disagreement).toBe(
      'Low',
    );
    expect(summarizeEstimates(snapshot(['-1', '1']))?.disagreement).toBe(
      'High',
    );
  });
  it('does not assign a disagreement rating without numeric estimates', () => {
    expect(summarizeEstimates(snapshot([]))?.disagreement).toBeNull();
    expect(
      summarizeEstimates(snapshot(['?', 'M', null]))?.disagreement,
    ).toBeNull();
  });
  it('counts choices in deck order, including skips and saved members', () => {
    expect(
      summarizeEstimates(
        snapshot(['13', '?', '0.5', '13', '?', null, undefined]),
      )?.votes,
    ).toEqual([
      { vote: '0.5', count: 1, label: '1 vote for 0.5 points' },
      { vote: '13', count: 2, label: '2 votes for 13 points' },
      { vote: '?', count: 2, label: '2 skipped votes' },
    ]);
    const room = snapshot(['M', 'XS', 'M', '?']);
    room.deck = ['XS', 'S', 'M', 'L', '?'];
    expect(summarizeEstimates(room)?.votes).toEqual([
      { vote: 'XS', count: 1, label: '1 vote for XS' },
      { vote: 'M', count: 2, label: '2 votes for M' },
      { vote: '?', count: 1, label: '1 skipped vote' },
    ]);
  });
  it('updates counts when members are removed and keeps unvoted members out', () => {
    const room = snapshot(['3', '3', null]);
    room.members.pop();
    room.members.pop();
    expect(summarizeEstimates(room)?.votes).toEqual([
      { vote: '3', count: 1, label: '1 vote for 3 points' },
    ]);
    expect(summarizeEstimates(snapshot([null, undefined]))?.votes).toEqual([]);
  });
});
