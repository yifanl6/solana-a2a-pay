import express from 'express';
import { formatEther, isAddress } from 'viem';
import { ANALYST_PORT, DATA_AGENT_URL, NETWORK, fmtUsd, loadAccount, loadDeployment, txUrl, usd } from './config';
import { X402Client } from './client';
import { createSeller, short, type SettledPayment } from './server';
import type { AccountSnapshot } from './data-agent';

// Seller AND buyer: earns $0.02 per risk report, spends $0.005 of it on the data agent within the same request.
const dep = loadDeployment();
const account = loadAccount('analyst');
const seller = createSeller({
  name: 'analyst-agent',
  account,
  token: dep.token,
  tokenName: dep.tokenName,
  tokenVersion: dep.tokenVersion,
  network: NETWORK,
});

const dataClient = new X402Client(account, {
  network: NETWORK,
  asset: dep.token,
  maxPerCall: usd(0.01),
  budget: usd(Number(process.env.ANALYST_UPSTREAM_BUDGET ?? 100)),
  allowedPayees: [dep.agents.data],
});

/** A deliberately transparent toy heuristic: every point in the score is traceable to a factor. */
export function scoreRisk(s: AccountSnapshot) {
  const factors: Array<{ factor: string; points: number; detail: string }> = [];
  const add = (factor: string, points: number, detail: string) => factors.push({ factor, points, detail });
  const balance = BigInt(s.balanceWei);

  if (!s.isContract && s.txCount === 0 && balance === 0n) {
    add('no-footprint', 50, 'no balance, no transactions, no code');
  } else if (s.isContract) {
    add('contract-account', -20, `contract with ${s.codeSize} bytes of code, not a user wallet`);
  } else {
    if (s.txCount === 0) add('never-transacted', 25, 'holds funds but has never sent a transaction');
    else if (s.txCount < 5) add('low-activity', 15, `${s.txCount} transactions sent`);
    if (balance < 10n ** 16n) add('low-balance', 10, `${formatEther(balance)} MON`);
  }

  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  return { score, level: score < 30 ? 'low' : score < 60 ? 'medium' : 'high', factors };
}

const app = express();
app.set('trust proxy', true);
app.get('/', seller.describe());
app.get(
  '/risk/:address',
  (req, res, next) => (isAddress(req.params.address) ? next() : res.status(400).json({ error: 'invalid EVM address' })),
  seller.paywall('/risk/:address', { price: usd(0.02), description: 'Risk report for a Monad address (toy heuristic)' }),
  async (req, res) => {
    const earned = res.locals.payment as SettledPayment;
    const address = req.params.address;
    const source = `${DATA_AGENT_URL}/account/${address}`;

    let upstream;
    try {
      upstream = await dataClient.get<AccountSnapshot>(source);
      if (upstream.status !== 200 || !upstream.payment) throw new Error(`data agent returned ${upstream.status}`);
    } catch (e) {
      // Pay-then-fail: the customer has paid and we can't deliver. No automated refund yet.
      console.error(`[analyst-agent] refund owed: ${fmtUsd(BigInt(earned.amount))} to ${earned.payer} (tx ${earned.transaction}): ${(e as Error).message}`);
      return res.status(502).json({ error: 'upstream data agent unavailable', refundOwed: earned });
    }

    const margin = BigInt(earned.amount) - upstream.payment.amount;
    console.log(`[analyst-agent] bought data for ${short(address)}  tx ${short(upstream.payment.transaction)}  margin ${fmtUsd(margin)} before gas`);

    res.json({
      address,
      ...scoreRisk(upstream.body),
      snapshot: upstream.body,
      // Provenance: the buyer can check on-chain that the inputs to this report were really paid for.
      provenance: {
        source,
        dataAgent: dep.agents.data,
        upstreamPaymentTx: upstream.payment.transaction,
        upstreamAmount: upstream.payment.amount.toString(),
        explorer: txUrl(upstream.payment.transaction),
        snapshotBlock: upstream.body.block,
      },
      payment: earned,
    });
  },
);

app.listen(ANALYST_PORT, () => {
  console.log(`[analyst-agent] ${NETWORK} listening on :${ANALYST_PORT}  payTo ${account.address}  price $0.02/call, buys from ${DATA_AGENT_URL}`);
});
