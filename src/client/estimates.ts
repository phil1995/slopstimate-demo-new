import type { RoomSnapshot } from '../shared/protocol';

interface EstimationSummary {
  mean: number | null;
  count: number;
  disagreement: 'Low' | 'Medium' | 'High' | null;
  votes: { vote: string; count: number; label: string }[];
}

function numericEstimate(vote: string): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(vote)) return null;
  const value = Number(vote);
  return Number.isFinite(value) ? value : null;
}

export function summarizeEstimates(
  room: RoomSnapshot | null,
): EstimationSummary | null {
  if (!room?.revealed) return null;
  const counts = new Map<string, number>();
  const estimates = room.members.flatMap((member) => {
    if (typeof member.vote !== 'string') return [];
    counts.set(member.vote, (counts.get(member.vote) ?? 0) + 1);
    const value = numericEstimate(member.vote);
    return value === null ? [] : [value];
  });
  const mean = estimates.length
    ? estimates.reduce((sum, value) => sum + value, 0) / estimates.length
    : null;
  let disagreement: EstimationSummary['disagreement'] = null;
  if (mean !== null) {
    const deviation = Math.sqrt(
      estimates.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        estimates.length,
    );
    // Relative spread: identical values (including all zero) have no disagreement.
    const spread = deviation === 0 ? 0 : deviation / Math.abs(mean);
    disagreement = spread <= 0.25 ? 'Low' : spread <= 0.5 ? 'Medium' : 'High';
  }
  const choices = [...new Set([...room.deck, ...counts.keys()])];
  return {
    mean,
    count: estimates.length,
    disagreement,
    votes: choices.flatMap((vote) => {
      const count = counts.get(vote);
      if (!count) return [];
      const label =
        vote === '?'
          ? `${count} skipped ${count === 1 ? 'vote' : 'votes'}`
          : `${count} ${count === 1 ? 'vote' : 'votes'} for ${vote}${numericEstimate(vote) === null ? '' : ' points'}`;
      return [{ vote, count, label }];
    }),
  };
}
