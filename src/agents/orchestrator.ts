import { PublicKey } from '@solana/web3.js';
import { ANALYST_URL, NETWORK, agentKey, connection, fmtUsd, loadKeypair, loadNetworkConfig, usd } from '../config';
import { PolicyError, X402Client } from '../x402/client';
import { receivedInTx, tokenBalance } from './common';

// Buyer only, with a hard budget: $0.05 total at $0.02 per call means the third call must be refused.
const cfg = loadNetworkConfig();
const conn = connection();
const wallet = loadKeypair('orchestrator');
const mint = new PublicKey(cfg.mint);
const dataAgent = agentKey(cfg, 'data');

const client = new X402Client(wallet, conn, {
  network: NETWORK,
  mint,
  maxPerCall: usd(0.02),
  budget: usd(0.05),
  allowedPayees: [agentKey(cfg, 'analyst')],
});

// Default targets have history on any fresh validator: the agents' own wallets.
const targets = process.argv.length > 2 ? process.argv.slice(2) : [cfg.agents.data, cfg.agents.analyst, cfg.agents.treasury];

async function main() {
  console.log(`orchestrator ${wallet.publicKey.toBase58()}`);
  console.log(`policy: budget ${fmtUsd(client.policy.budget)}, max ${fmtUsd(client.policy.maxPerCall)}/call, payees [analyst]\n`);
  const before = await tokenBalance(conn, mint, wallet.publicKey);

  for (const address of targets) {
    console.log(`▶ risk report for ${address}`);
    const started = Date.now();
    try {
      const res = await client.get(`${ANALYST_URL}/risk/${address}`);
      if (res.status !== 200) {
        console.log(`  ✗ ${res.status} ${res.body?.error ?? ''}${res.payment ? ` (paid ${fmtUsd(res.payment.amount)}, refund owed)` : ''}\n`);
        continue;
      }
      const r = res.body;
      console.log(`  paid ${fmtUsd(res.payment!.amount)}  tx ${res.payment!.signature}  (${Date.now() - started} ms)`);
      console.log(`  score ${r.score}/100 (${r.level})`);
      for (const f of r.factors) console.log(`    ${f.points >= 0 ? '+' : ''}${f.points}  ${f.factor}: ${f.detail}`);

      // Verify provenance on-chain: did the analyst really pay the data agent for these inputs?
      const p = r.provenance;
      const received = await receivedInTx(conn, p.upstreamPaymentSignature, mint, dataAgent);
      const ok = received === BigInt(p.upstreamAmount) && p.dataAgent === dataAgent.toBase58();
      console.log(`  provenance: data agent received ${received === null ? '?' : fmtUsd(received)} in ${p.upstreamPaymentSignature.slice(0, 16)}… ${ok ? '✓ verified on-chain' : '✗ NOT VERIFIED'}`);
      console.log(`  budget left ${fmtUsd(client.remaining)}\n`);
    } catch (e) {
      if (e instanceof PolicyError) console.log(`  ⛔ refused by spend policy: ${e.message}\n`);
      else console.log(`  ✗ ${(e as Error).message}\n`);
    }
  }

  const after = await tokenBalance(conn, mint, wallet.publicKey);
  const delta = before - after;
  console.log(`tracked spend ${fmtUsd(client.spent)} across ${client.payments.length} payments`);
  console.log(`on-chain balance change ${fmtUsd(delta)} ${delta === client.spent ? '✓ matches' : '✗ MISMATCH'}`);
  if (delta !== client.spent) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
