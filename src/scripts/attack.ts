import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DATA_AGENT_URL, NETWORK, agentKey, connection, loadKeypair, loadNetworkConfig } from '../config';
import { buildPaymentTransaction, memoInstruction, paymentHeader, paymentInstructions } from '../x402/client';
import { tokenBalance } from '../agents/common';
import { PAYMENT_HEADER, type PaymentRequiredResponse, type PaymentRequirements } from '../x402/types';

// Adversarial checks against a live data agent. Each attack gets a fresh, valid 402 quote, then tampers with the payment.
const cfg = loadNetworkConfig();
const conn = connection();
const attacker = loadKeypair('attacker');
const seller = agentKey(cfg, 'data');
const mint = new PublicKey(cfg.mint);
const target = (addr: string) => `${DATA_AGENT_URL}/account/${addr}`;
const URL_A = target(cfg.agents.treasury);
const URL_B = target(cfg.agents.orchestrator);

async function quote(url: string): Promise<PaymentRequirements> {
  const res = await fetch(url);
  if (res.status !== 402) throw new Error(`expected 402 from ${url}, got ${res.status}`);
  return ((await res.json()) as PaymentRequiredResponse).accepts[0];
}

const build = (req: PaymentRequirements, ixs: TransactionInstruction[], extraSigners: Keypair[] = []) =>
  buildPaymentTransaction(conn, attacker, new PublicKey(req.extra.feePayer), ixs, extraSigners);

/** Replace the TransferChecked in an honest payment with a tampered one. */
const withTransfer = (req: PaymentRequirements, t: Partial<{ source: PublicKey; mint: PublicKey; dest: PublicKey; owner: PublicKey; amount: bigint; decimals: number }>) => {
  const m = t.mint ?? mint;
  return paymentInstructions(attacker.publicKey, req).map((ix) =>
    ix.programId.equals(TOKEN_PROGRAM_ID)
      ? createTransferCheckedInstruction(
          t.source ?? getAssociatedTokenAddressSync(m, attacker.publicKey),
          m,
          t.dest ?? getAssociatedTokenAddressSync(m, seller),
          t.owner ?? attacker.publicKey,
          t.amount ?? BigInt(req.maxAmountRequired),
          t.decimals ?? req.extra.decimals,
        )
      : ix,
  );
};

interface Attack {
  name: string;
  defense: string;
  run: () => Promise<{ url: string; tx: VersionedTransaction } | { url: string; header: string }>;
}

let replayHeader = '';

const attacks: Attack[] = [
  {
    name: 'drain fee payer: SOL transfer out of the facilitator',
    defense: 'facilitator only as fee payer',
    run: async () => {
      const req = await quote(URL_A);
      const drain = SystemProgram.transfer({ fromPubkey: seller, toPubkey: attacker.publicKey, lamports: 500_000_000 });
      return { url: URL_A, tx: await build(req, [...paymentInstructions(attacker.publicKey, req), drain]) };
    },
  },
  {
    name: "drain seller tokens: transfer from the seller's own token account",
    defense: 'facilitator only as fee payer',
    run: async () => {
      const req = await quote(URL_A);
      // An honest payment, plus a second transfer moving the seller's own tokens to the attacker.
      const drain = createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(mint, seller),
        mint,
        getAssociatedTokenAddressSync(mint, attacker.publicKey),
        seller,
        100_000n,
        req.extra.decimals,
      );
      const ixs = [...paymentInstructions(attacker.publicKey, req), drain];
      return { url: URL_A, tx: await build(req, ixs) };
    },
  },
  {
    name: 'priority-fee griefing: 10M micro-lamports/CU',
    defense: 'compute price cap',
    run: async () => {
      const req = await quote(URL_A);
      const ixs = paymentInstructions(attacker.publicKey, req).map((ix) =>
        ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3
          ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 })
          : ix,
      );
      return { url: URL_A, tx: await build(req, ixs) };
    },
  },
  {
    name: 'compute-limit griefing: 1.4M CU',
    defense: 'compute limit cap',
    run: async () => {
      const req = await quote(URL_A);
      const ixs = paymentInstructions(attacker.publicKey, req).map((ix) =>
        ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2
          ? ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
          : ix,
      );
      return { url: URL_A, tx: await build(req, ixs) };
    },
  },
  {
    name: 'underpay by one unit',
    defense: 'exact amount',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, tx: await build(req, withTransfer(req, { amount: BigInt(req.maxAmountRequired) - 1n })) };
    },
  },
  {
    name: 'pay in a worthless token',
    defense: 'mint check',
    run: async () => {
      const req = await quote(URL_A);
      const fake = Keypair.generate().publicKey;
      return { url: URL_A, tx: await build(req, withTransfer(req, { mint: fake })) };
    },
  },
  {
    name: 'wrong decimals',
    defense: 'decimals check',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, tx: await build(req, withTransfer(req, { decimals: 9 })) };
    },
  },
  {
    name: 'pay yourself (wrong recipient)',
    defense: 'recipient ATA check',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, tx: await build(req, withTransfer(req, { dest: getAssociatedTokenAddressSync(mint, attacker.publicKey) })) };
    },
  },
  {
    name: 'smuggled instruction: extra System transfer',
    defense: 'program allow-list',
    run: async () => {
      const req = await quote(URL_A);
      const extra = SystemProgram.transfer({ fromPubkey: attacker.publicKey, toPubkey: attacker.publicKey, lamports: 1 });
      return { url: URL_A, tx: await build(req, [...paymentInstructions(attacker.publicKey, req), extra]) };
    },
  },
  {
    name: 'smuggled instruction: second token transfer',
    defense: 'exactly one transfer',
    run: async () => {
      const req = await quote(URL_A);
      const ixs = paymentInstructions(attacker.publicKey, req);
      return { url: URL_A, tx: await build(req, [...ixs, ixs[2]]) };
    },
  },
  {
    name: 'extra signer to inflate the fee',
    defense: 'exactly two signers',
    run: async () => {
      const req = await quote(URL_A);
      const extra = Keypair.generate();
      const memo = new TransactionInstruction({ programId: memoInstruction('').programId, keys: [{ pubkey: extra.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(req.extra.nonce) });
      const ixs = paymentInstructions(attacker.publicKey, req).map((ix) => (ix.programId.equals(memo.programId) ? memo : ix));
      return { url: URL_A, tx: await build(req, ixs, [extra]) };
    },
  },
  {
    name: 'forged nonce',
    defense: 'single-use nonce',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, tx: await build(req, paymentInstructions(attacker.publicKey, { ...req, extra: { ...req.extra, nonce: 'deadbeef'.repeat(4) } })) };
    },
  },
  {
    name: 'nonce from a different resource',
    defense: 'nonce bound to resource',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_B, tx: await build(req, paymentInstructions(attacker.publicKey, req)) };
    },
  },
  {
    name: 'missing owner signature',
    defense: 'signature check',
    run: async () => {
      const req = await quote(URL_A);
      const tx = await build(req, paymentInstructions(attacker.publicKey, req));
      tx.signatures[1] = new Uint8Array(64);
      return { url: URL_A, tx };
    },
  },
  {
    name: 'replay a payment that already settled',
    defense: 'nonce burned before submission',
    run: async () => ({ url: URL_A, header: replayHeader }),
  },
];

async function send(url: string, header: string) {
  const res = await fetch(url, { headers: { [PAYMENT_HEADER]: header } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: body.error ?? '' };
}

async function main() {
  console.log(`attacking data agent at ${DATA_AGENT_URL} (seller ${seller.toBase58()})\n`);
  const solBefore = await conn.getBalance(seller, 'confirmed');
  const tokensBefore = await tokenBalance(conn, mint, seller);

  // One honest payment first, so there is something to replay.
  const req = await quote(URL_A);
  const honest = paymentHeader(NETWORK, await build(req, paymentInstructions(attacker.publicKey, req)));
  const first = await send(URL_A, honest);
  if (first.status !== 200) throw new Error(`honest payment failed (${first.status}): ${first.error}`);
  replayHeader = honest;
  console.log(`  ✓ control: honest $0.005 payment accepted (200)\n`);

  let blocked = 0;
  for (const a of attacks) {
    const r = await a.run();
    const header = 'header' in r ? r.header : paymentHeader(NETWORK, r.tx);
    const { status, error } = await send(r.url, header);
    const ok = status === 402;
    if (ok) blocked++;
    console.log(`  ${ok ? '✓ blocked' : '✗ ACCEPTED'}  ${a.name}`);
    console.log(`             ${a.defense} → ${status} "${error}"`);
  }

  const solAfter = await conn.getBalance(seller, 'confirmed');
  const tokensAfter = await tokenBalance(conn, mint, seller);
  console.log(`\n${blocked}/${attacks.length} attacks blocked`);
  console.log(`seller SOL change ${solAfter - solBefore} lamports (expected -10001: one honest settlement fee)`);
  console.log(`seller token change +${tokensAfter - tokensBefore} units (expected +5000: the honest payment)`);
  if (blocked !== attacks.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
