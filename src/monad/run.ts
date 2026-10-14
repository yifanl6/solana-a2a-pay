import { getAddress, parseEventLogs, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { ANALYST_URL, NETWORK, publicClient, txUrl, usd, type Deployment } from './config';
import { PolicyError, X402Client } from './client';
import { tokenAbi } from './token';

export interface ReportResult {
  address: string;
  outcome: 'paid' | 'refused' | 'failed';
  ms: number;
  reason?: string;
  paid?: { amount: string; transaction: Hex; explorer: string };
  report?: { score: number; level: string; factors: Array<{ factor: string; points: number; detail: string }> };
  provenance?: { upstreamPaymentTx: Hex; explorer: string; dataAgentReceived: string | null; verified: boolean };
  budgetLeft: string;
}

export interface RunResult {
  orchestrator: Address;
  policy: { budget: string; maxPerCall: string; payees: Address[] };
  results: ReportResult[];
  trackedSpend: string;
  onChainDelta: string;
  matches: boolean;
}

export const balanceOf = (dep: Deployment, address: Address) =>
  publicClient.readContract({ address: dep.token, abi: tokenAbi, functionName: 'balanceOf', args: [address] });

/** Token amount `to` received from transaction `hash`, read from the chain's own Transfer logs. */
export async function receivedInTx(dep: Deployment, hash: Hex, to: Address): Promise<bigint | null> {
  const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt || receipt.status !== 'success') return null;
  return parseEventLogs({ abi: tokenAbi, logs: receipt.logs, eventName: 'Transfer' })
    .filter((l) => getAddress(l.address) === getAddress(dep.token) && getAddress(l.args.to) === getAddress(to))
    .reduce((sum, l) => sum + l.args.value, 0n);
}

/**
 * The orchestrator's job: buy one risk report per address from the analyst, under a hard budget,
 * verifying each report's provenance on-chain. $0.05 budget at $0.02/call means the third call is refused.
 */
export async function runOrchestration(
  dep: Deployment,
  account: PrivateKeyAccount,
  addresses: string[],
  onResult: (r: ReportResult) => void = () => {},
): Promise<RunResult> {
  const client = new X402Client(account, {
    network: NETWORK,
    asset: dep.token,
    maxPerCall: usd(0.02),
    budget: usd(0.05),
    allowedPayees: [dep.agents.analyst],
  });
  const before = await balanceOf(dep, account.address);
  const results: ReportResult[] = [];

  for (const address of addresses) {
    const started = Date.now();
    const base = { address, budgetLeft: '' };
    let result: ReportResult;
    try {
      const res = await client.get(`${ANALYST_URL}/risk/${address}`);
      const paid = res.payment && { amount: res.payment.amount.toString(), transaction: res.payment.transaction, explorer: txUrl(res.payment.transaction) };
      if (res.status !== 200) {
        result = { ...base, outcome: 'failed', ms: Date.now() - started, paid, reason: `${res.status} ${res.body?.error ?? ''}${paid ? ' (paid, refund owed)' : ''}` };
      } else {
        const p = res.body.provenance;
        const received = await receivedInTx(dep, p.upstreamPaymentTx, dep.agents.data);
        result = {
          ...base,
          outcome: 'paid',
          ms: Date.now() - started,
          paid,
          report: { score: res.body.score, level: res.body.level, factors: res.body.factors },
          provenance: {
            upstreamPaymentTx: p.upstreamPaymentTx,
            explorer: txUrl(p.upstreamPaymentTx),
            dataAgentReceived: received?.toString() ?? null,
            verified: received === BigInt(p.upstreamAmount) && getAddress(p.dataAgent) === getAddress(dep.agents.data),
          },
        };
      }
    } catch (e) {
      result = { ...base, outcome: e instanceof PolicyError ? 'refused' : 'failed', ms: Date.now() - started, reason: (e as Error).message };
    }
    result.budgetLeft = client.remaining.toString();
    results.push(result);
    onResult(result);
  }

  const after = await balanceOf(dep, account.address);
  return {
    orchestrator: account.address,
    policy: { budget: client.policy.budget.toString(), maxPerCall: client.policy.maxPerCall.toString(), payees: client.policy.allowedPayees },
    results,
    trackedSpend: client.spent.toString(),
    onChainDelta: (before - after).toString(),
    matches: before - after === client.spent,
  };
}
