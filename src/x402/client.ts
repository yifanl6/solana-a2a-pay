import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  MEMO_PROGRAM_ID,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  type PaymentPayload,
  type PaymentRequiredResponse,
  type PaymentRequirements,
  type SettlementResponse,
} from './types';

export interface SpendPolicy {
  network: string;
  mint: PublicKey;
  maxPerCall: bigint;
  budget: bigint;
  allowedPayees: PublicKey[];
}

export class PolicyError extends Error {}

export interface PaymentRecord {
  resource: string;
  payTo: string;
  amount: bigint;
  signature: string;
}

export interface PaidResponse<T = any> {
  status: number;
  body: T;
  payment?: PaymentRecord;
}

/** The instructions of an x402 "exact" SPL payment. Exported so the attack harness can tamper with them. */
export function paymentInstructions(owner: PublicKey, req: PaymentRequirements): TransactionInstruction[] {
  const mint = new PublicKey(req.asset);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(mint, owner),
      mint,
      getAssociatedTokenAddressSync(mint, new PublicKey(req.payTo)),
      owner,
      BigInt(req.maxAmountRequired),
      req.extra.decimals,
    ),
    memoInstruction(req.extra.nonce),
  ];
}

export const memoInstruction = (text: string): TransactionInstruction =>
  new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, 'utf8') });

/** Builds a v0 transaction with the seller as fee payer, signed only by the token owner. */
export async function buildPaymentTransaction(
  connection: Connection,
  owner: Keypair,
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = [],
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([owner, ...extraSigners]);
  return tx;
}

export const paymentHeader = (network: string, tx: VersionedTransaction): string =>
  encodeHeader({
    x402Version: X402_VERSION,
    scheme: 'exact',
    network,
    payload: { transaction: Buffer.from(tx.serialize()).toString('base64') },
  } satisfies PaymentPayload);

/**
 * An HTTP client that pays x402 402 challenges from its wallet, within a hard spend policy.
 * The policy is checked before anything is signed, so a malicious seller can't talk it into overpaying.
 */
export class X402Client {
  spent = 0n;
  private reserved = 0n;
  readonly payments: PaymentRecord[] = [];

  constructor(
    private wallet: Keypair,
    private connection: Connection,
    readonly policy: SpendPolicy,
  ) {}

  get remaining(): bigint {
    return this.policy.budget - this.spent - this.reserved;
  }

  async get<T = any>(url: string): Promise<PaidResponse<T>> {
    const first = await fetch(url);
    if (first.status !== 402) return { status: first.status, body: await readBody(first) };

    const challenge = (await first.json()) as PaymentRequiredResponse;
    const req = this.choose(challenge.accepts ?? []);
    const amount = BigInt(req.maxAmountRequired);

    // Reserve before signing so concurrent calls can't jointly exceed the budget.
    this.reserved += amount;
    try {
      const tx = await buildPaymentTransaction(
        this.connection,
        this.wallet,
        new PublicKey(req.extra.feePayer),
        paymentInstructions(this.wallet.publicKey, req),
      );
      const paid = await fetch(url, { headers: { [PAYMENT_HEADER]: paymentHeader(req.network, tx) } });
      const body = await readBody(paid);
      const receiptHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
      if (!receiptHeader) {
        throw new Error(`payment not accepted (${paid.status}): ${body?.error ?? JSON.stringify(body)}`);
      }
      // A receipt means the money moved, even if the handler then failed (e.g. a 502).
      const receipt = decodeHeader<SettlementResponse>(receiptHeader);
      const payment: PaymentRecord = { resource: req.resource, payTo: req.payTo, amount, signature: receipt.transaction };
      this.spent += amount;
      this.payments.push(payment);
      return { status: paid.status, body, payment };
    } finally {
      this.reserved -= amount;
    }
  }

  private choose(accepts: PaymentRequirements[]): PaymentRequirements {
    const p = this.policy;
    const candidates = accepts.filter(
      (a) => a.scheme === 'exact' && a.network === p.network && a.asset === p.mint.toBase58(),
    );
    if (candidates.length === 0) throw new PolicyError(`no offer in an accepted token on ${p.network}`);
    const req = candidates.reduce((a, b) => (BigInt(a.maxAmountRequired) <= BigInt(b.maxAmountRequired) ? a : b));
    const amount = BigInt(req.maxAmountRequired);

    if (!p.allowedPayees.some((k) => k.toBase58() === req.payTo)) throw new PolicyError(`payee ${req.payTo} is not on the allow-list`);
    if (req.extra.feePayer !== req.payTo) throw new PolicyError('fee payer must be the payee');
    if (amount > p.maxPerCall) throw new PolicyError(`price ${amount} exceeds per-call cap ${p.maxPerCall}`);
    if (amount > this.remaining) {
      throw new PolicyError(`price ${amount} exceeds remaining budget ${this.remaining} (spent ${this.spent} of ${p.budget})`);
    }
    return req;
  }
}

async function readBody(res: globalThis.Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
