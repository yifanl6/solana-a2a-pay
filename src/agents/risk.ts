import type { AccountSnapshot } from './data-agent';

export interface RiskFactor {
  factor: string;
  points: number;
  detail: string;
}

/** A deliberately transparent toy heuristic: every point in the score is traceable to a factor. */
export function scoreRisk(s: AccountSnapshot, now = Date.now() / 1000) {
  const factors: RiskFactor[] = [];
  const add = (factor: string, points: number, detail: string) => factors.push({ factor, points, detail });
  const tx = s.txSample;

  if (!s.exists && tx.count === 0) {
    add('no-footprint', 50, 'account does not exist and has no transaction history');
  } else {
    if (tx.firstSeen !== null && !tx.truncated) {
      const ageDays = (now - tx.firstSeen) / 86_400;
      if (ageDays < 1) add('new-account', 25, `first activity ${ageDays < 0.04 ? 'under an hour' : ageDays.toFixed(1) + ' days'} ago`);
      else if (ageDays < 30) add('young-account', 10, `first activity ${ageDays.toFixed(0)} days ago`);
    }
    if (tx.count < 5) add('low-activity', 15, `${tx.count} transactions on record`);
    if (tx.count > 0 && tx.failed / tx.count > 0.2) {
      add('high-failure-rate', 20, `${tx.failed}/${tx.count} recent transactions failed`);
    }
    if (!s.executable && s.lamports < 10_000_000) add('low-balance', 10, `${(s.lamports / 1e9).toFixed(4)} SOL`);
    if (s.executable) add('program-account', -20, 'executable program, not a user wallet');
  }

  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  const level = score < 30 ? 'low' : score < 60 ? 'medium' : 'high';
  return { score, level, factors };
}
