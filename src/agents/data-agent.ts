import express from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { DATA_AGENT_PORT, NETWORK, connection, loadKeypair, loadNetworkConfig, usd } from '../config';
import { createSeller } from '../x402/server';
import { requireAddress } from './common';

// Seller only: sells raw on-chain account data at $0.005 per call.
const cfg = loadNetworkConfig();
const conn = connection();
const seller = createSeller({
  name: 'data-agent',
  connection: conn,
  keypair: loadKeypair('data'),
  mint: new PublicKey(cfg.mint),
  decimals: cfg.decimals,
  network: NETWORK,
});

const app = express();
app.get('/', seller.describe());
app.get(
  '/account/:address',
  requireAddress,
  seller.paywall('/account/:address', { price: usd(0.005), description: 'On-chain activity snapshot for a Solana address' }),
  async (req, res) => {
    try {
      res.json({ ...(await accountSnapshot(conn, new PublicKey(req.params.address))), payment: res.locals.payment });
    } catch (e) {
      // Paid but couldn't deliver: same refund problem as the analyst's upstream failure.
      console.error(`[data-agent] refund owed to ${res.locals.payment.payer} (tx ${res.locals.payment.signature}): ${e}`);
      res.status(502).json({ error: 'RPC unavailable', refundOwed: res.locals.payment });
    }
  },
);

export async function accountSnapshot(conn: Connection, address: PublicKey) {
  const SAMPLE = 100;
  const [info, sigs, tokens, slot] = await Promise.all([
    conn.getAccountInfo(address),
    conn.getSignaturesForAddress(address, { limit: SAMPLE }),
    conn.getTokenAccountsByOwner(address, { programId: TOKEN_PROGRAM_ID }),
    conn.getSlot(),
  ]);
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => t != null);
  return {
    address: address.toBase58(),
    slot,
    exists: info !== null,
    lamports: info?.lamports ?? 0,
    executable: info?.executable ?? false,
    ownerProgram: info?.owner.toBase58() ?? null,
    tokenAccounts: tokens.value.length,
    txSample: {
      count: sigs.length,
      truncated: sigs.length === SAMPLE, // more history exists than we sampled
      failed: sigs.filter((s) => s.err !== null).length,
      firstSeen: times.length ? Math.min(...times) : null,
      lastSeen: times.length ? Math.max(...times) : null,
    },
  };
}

export type AccountSnapshot = Awaited<ReturnType<typeof accountSnapshot>>;

app.listen(DATA_AGENT_PORT, () => {
  console.log(`[data-agent] listening on :${DATA_AGENT_PORT}  payTo ${cfg.agents.data}  price $0.005/call`);
});
