import { PublicKey } from '@solana/web3.js';

// Wire shapes follow x402 v1 ("exact" scheme). Solana-specific fields live in `extra`.
export const X402_VERSION = 1;

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string; // base units; "exact" means the transfer must equal this
  resource: string;
  description: string;
  mimeType: string;
  payTo: string; // seller wallet; tokens go to its associated token account
  maxTimeoutSeconds: number;
  asset: string; // SPL mint
  extra: {
    feePayer: string; // seller co-signs as fee payer, so buyers need no SOL
    decimals: number;
    nonce: string; // single-use, must be echoed in a Memo instruction
  };
}

export interface PaymentRequiredResponse {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  scheme: 'exact';
  network: string;
  payload: { transaction: string }; // base64 VersionedTransaction, signed by the token owner only
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
}

export const PAYMENT_HEADER = 'X-PAYMENT';
export const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

export const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');

export function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T;
}
