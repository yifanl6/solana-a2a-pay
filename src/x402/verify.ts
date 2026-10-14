import nacl from 'tweetnacl';
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TokenInstruction,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { MEMO_PROGRAM_ID, X402_VERSION, type PaymentPayload, type PaymentRequirements } from './types';

export const LAMPORTS_PER_SIGNATURE = 5_000;

export interface VerifyLimits {
  maxComputeUnitPrice: bigint; // micro-lamports per CU
  maxComputeUnitLimit: number;
}

// Worst case priority fee the seller can be charged: 5_000 * 100_000 / 1e6 = 500 lamports.
export const DEFAULT_LIMITS: VerifyLimits = { maxComputeUnitPrice: 5_000n, maxComputeUnitLimit: 100_000 };

export interface VerifiedPayment {
  tx: VersionedTransaction;
  payer: PublicKey;
  nonce: string;
  amount: bigint;
  feeLamports: number; // what the seller pays as fee payer if this lands
}

export class PaymentRejected extends Error {}

const fail = (reason: string): never => {
  throw new PaymentRejected(reason);
};

/**
 * Checks a buyer-signed payment transaction against the seller's own requirements before the seller
 * co-signs it as fee payer. Everything not explicitly allowed is rejected. The nonce is returned for
 * the caller to burn; this function is pure and never touches the network.
 */
export function verifyPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  limits: VerifyLimits = DEFAULT_LIMITS,
): VerifiedPayment {
  if (payload?.x402Version !== X402_VERSION) fail('unsupported x402Version');
  if (payload.scheme !== 'exact' || payload.network !== requirements.network) fail('scheme or network mismatch');
  if (typeof payload.payload?.transaction !== 'string') fail('missing transaction');

  let tx!: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction, 'base64'));
  } catch {
    fail('malformed transaction');
  }
  const message = tx.message;
  if (message.addressTableLookups.length > 0) fail('address lookup tables are not allowed');

  // 1. Fee payer: the facilitator key may appear only as fee payer (index 0), never inside an instruction.
  //    This blocks every "make the seller sign something" drain: SOL transfers, token transfers, closes.
  const keys = message.staticAccountKeys;
  const feePayer = new PublicKey(requirements.extra.feePayer);
  if (!keys[0]?.equals(feePayer)) fail('fee payer must be the facilitator');
  for (const ix of message.compiledInstructions) {
    if (ix.programIdIndex === 0 || ix.accountKeyIndexes.includes(0)) {
      fail('facilitator key may only appear as fee payer');
    }
  }

  // 2. Signers: exactly fee payer + token owner, so the seller's fee is fixed at two signatures.
  if (message.header.numRequiredSignatures !== 2) fail('expected exactly two signers (fee payer + token owner)');
  const messageBytes = message.serialize();
  const ownerSig = tx.signatures[1];
  if (!ownerSig || ownerSig.every((b) => b === 0)) fail('missing token owner signature');
  if (!nacl.sign.detached.verify(messageBytes, ownerSig, keys[1].toBytes())) fail('invalid token owner signature');

  // 3. Instructions: allow-list of programs, and of instruction types within them.
  const instructions = TransactionMessage.decompile(message).instructions;
  let cuLimit: number | undefined;
  let cuPrice: bigint | undefined;
  let transfer: ReturnType<typeof decodeTransferCheckedInstruction> | undefined;
  let nonce: string | undefined;

  for (const ix of instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      let type: string | undefined;
      try {
        type = ComputeBudgetInstruction.decodeInstructionType(ix);
      } catch {
        fail('malformed compute budget instruction');
      }
      if (type === 'SetComputeUnitLimit' && cuLimit === undefined) {
        cuLimit = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
      } else if (type === 'SetComputeUnitPrice' && cuPrice === undefined) {
        cuPrice = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
      } else {
        fail(`compute budget instruction not allowed: ${type}`);
      }
    } else if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      if (ix.data[0] !== TokenInstruction.TransferChecked) fail('only TransferChecked is allowed on the token program');
      if (transfer) fail('exactly one transfer is allowed');
      try {
        transfer = decodeTransferCheckedInstruction(ix);
      } catch {
        fail('malformed TransferChecked instruction');
      }
    } else if (ix.programId.equals(MEMO_PROGRAM_ID)) {
      if (nonce !== undefined) fail('exactly one memo is allowed');
      nonce = Buffer.from(ix.data).toString('utf8');
    } else {
      fail(`program not allowed: ${ix.programId.toBase58()}`);
    }
  }

  // 4. Priority-fee griefing: the seller pays these, so cap them.
  if (cuPrice !== undefined) {
    if (cuPrice > limits.maxComputeUnitPrice) fail(`compute unit price ${cuPrice} exceeds cap ${limits.maxComputeUnitPrice}`);
    if (cuLimit === undefined) fail('compute unit limit is required when a price is set');
  }
  if (cuLimit !== undefined && cuLimit > limits.maxComputeUnitLimit) {
    fail(`compute unit limit ${cuLimit} exceeds cap ${limits.maxComputeUnitLimit}`);
  }

  // 5. The transfer itself: exact amount, mint, decimals, recipient.
  if (!transfer) return fail('missing TransferChecked instruction');
  if (nonce === undefined) return fail('missing memo with payment nonce');
  const mint = new PublicKey(requirements.asset);
  const expectedDestination = getAssociatedTokenAddressSync(mint, new PublicKey(requirements.payTo));
  const { keys: t, data } = transfer;
  if (!t.mint.pubkey.equals(mint)) fail('wrong token mint');
  if (data.decimals !== requirements.extra.decimals) fail('wrong token decimals');
  if (data.amount !== BigInt(requirements.maxAmountRequired)) {
    fail(`amount ${data.amount} does not equal price ${requirements.maxAmountRequired}`);
  }
  if (!t.destination.pubkey.equals(expectedDestination)) fail('wrong recipient token account');
  if (!t.owner.pubkey.equals(keys[1]) || !t.owner.isSigner) fail('transfer authority must be the signing token owner');
  if (t.multiSigners.length > 0) fail('multisig authorities are not supported');

  const priorityLamports = cuPrice ? Number((cuPrice * BigInt(cuLimit!) + 999_999n) / 1_000_000n) : 0;
  return {
    tx,
    payer: keys[1],
    nonce,
    amount: data.amount,
    feeLamports: LAMPORTS_PER_SIGNATURE * 2 + priorityLamports,
  };
}
