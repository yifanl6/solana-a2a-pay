import type { RequestHandler } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

/** Rejects bad addresses before the paywall, so nobody is charged for a request that would 400. */
export const requireAddress: RequestHandler = (req, res, next) => {
  try {
    new PublicKey(req.params.address);
    next();
  } catch {
    res.status(400).json({ error: 'invalid Solana address' });
  }
};

export async function tokenBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const { value } = await connection.getTokenAccountBalance(ata, 'confirmed');
  return BigInt(value.amount);
}

/** Token amount `owner` received in transaction `signature`, read from the chain's own balance records. */
export async function receivedInTx(
  connection: Connection,
  signature: string,
  mint: PublicKey,
  owner: PublicKey,
): Promise<bigint | null> {
  const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (!tx?.meta || tx.meta.err) return null;
  const pick = (list: typeof tx.meta.preTokenBalances) =>
    BigInt(list?.find((b) => b.mint === mint.toBase58() && b.owner === owner.toBase58())?.uiTokenAmount.amount ?? '0');
  return pick(tx.meta.postTokenBalances) - pick(tx.meta.preTokenBalances);
}
