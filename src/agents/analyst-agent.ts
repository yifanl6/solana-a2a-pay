import express from 'express';
import { PublicKey } from '@solana/web3.js';
import { ANALYST_PORT, DATA_AGENT_URL, NETWORK, agentKey, connection, fmtUsd, loadKeypair, loadNetworkConfig, usd } from '../config';
import { X402Client } from '../x402/client';
import { createSeller, short, type SettledPayment } from '../x402/server';
import { requireAddress } from './common';
import { scoreRisk } from './risk';
import type { AccountSnapshot } from './data-agent';

// Seller AND buyer: earns $0.02 per risk report, spends $0.005 of it on the data agent within the same request.
const cfg = loadNetworkConfig();
const conn = connection();
const wallet = loadKeypair('analyst');
const mint = new PublicKey(cfg.mint);
const dataAgent = agentKey(cfg, 'data');

const seller = createSeller({ name: 'analyst-agent', connection: conn, keypair: wallet, mint, decimals: cfg.decimals, network: NETWORK });

const dataClient = new X402Client(wallet, conn, {
  network: NETWORK,
  mint,
  maxPerCall: usd(0.01),
  budget: usd(1.0),
  allowedPayees: [dataAgent],
});

const app = express();
app.get('/', seller.describe());
app.get(
  '/risk/:address',
  requireAddress,
  seller.paywall('/risk/:address', { price: usd(0.02), description: 'Risk report for a Solana address (toy heuristic)' }),
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
      console.error(`[analyst-agent] refund owed: ${fmtUsd(BigInt(earned.amount))} to ${earned.payer} (tx ${earned.signature}): ${(e as Error).message}`);
      return res.status(502).json({ error: 'upstream data agent unavailable', refundOwed: earned });
    }

    const margin = BigInt(earned.amount) - upstream.payment.amount;
    console.log(`[analyst-agent] bought data for ${short(address)}  tx ${short(upstream.payment.signature)}  margin ${fmtUsd(margin)} before fees  (upstream budget left ${fmtUsd(dataClient.remaining)})`);

    res.json({
      address,
      ...scoreRisk(upstream.body),
      snapshot: upstream.body,
      // Provenance: the buyer can check on-chain that the inputs to this report were really paid for.
      provenance: {
        source,
        dataAgent: dataAgent.toBase58(),
        upstreamPaymentSignature: upstream.payment.signature,
        upstreamAmount: upstream.payment.amount.toString(),
        snapshotSlot: upstream.body.slot,
      },
    });
  },
);

app.listen(ANALYST_PORT, () => {
  console.log(`[analyst-agent] listening on :${ANALYST_PORT}  payTo ${wallet.publicKey.toBase58()}  price $0.02/call, buys from ${DATA_AGENT_URL}`);
});
