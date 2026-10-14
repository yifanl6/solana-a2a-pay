import { getAddress, isAddress, isHex, verifyTypedData, type Address, type Hex } from 'viem';
import { transferWithAuthorizationTypes } from './token';

// x402 v1 "exact" scheme on EVM: an EIP-3009 transferWithAuthorization signed by the buyer, submitted by the seller.
export const X402_VERSION = 1;
export const PAYMENT_HEADER = 'X-PAYMENT';
export const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

export interface EvmPaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra: {
    name: string; // EIP-712 domain of the token
    version: string;
    nonce: Hex; // seller-issued, single-use; must be the authorization nonce
  };
}

export interface PaymentRequiredResponse {
  x402Version: number;
  error?: string;
  accepts: EvmPaymentRequirements[];
}

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface EvmPaymentPayload {
  x402Version: number;
  scheme: 'exact';
  network: string;
  payload: { signature: Hex; authorization: Authorization };
}

export interface SettlementResponse {
  success: boolean;
  transaction: Hex;
  network: string;
  payer: Address;
}

export const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');
export const decodeHeader = <T>(header: string): T => JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T;

export const tokenDomain = (req: Pick<EvmPaymentRequirements, 'asset' | 'extra'>, chainId: number) => ({
  name: req.extra.name,
  version: req.extra.version,
  chainId,
  verifyingContract: req.asset,
});

export class PaymentRejected extends Error {}
const fail = (reason: string): never => {
  throw new PaymentRejected(reason);
};

/** Seconds the authorization must still be valid for when it reaches us, so it can land on-chain. */
export const MIN_VALIDITY_SECONDS = 6;

/**
 * Off-chain checks of a buyer's signed authorization against the seller's own requirements.
 * On-chain checks (balance, unused nonce) happen afterwards by simulating the exact call the seller will send.
 */
export async function verifyAuthorization(
  payload: EvmPaymentPayload,
  req: EvmPaymentRequirements,
  chainId: number,
  now = Math.floor(Date.now() / 1000),
): Promise<{ authorization: Authorization; signature: Hex; payer: Address; nonce: Hex }> {
  if (payload?.x402Version !== X402_VERSION) fail('unsupported x402Version');
  if (payload.scheme !== 'exact' || payload.network !== req.network) fail('scheme or network mismatch');
  const a = payload.payload?.authorization;
  const signature = payload.payload?.signature;
  if (!a || !isHex(signature)) fail('missing authorization or signature');
  if (!isAddress(a.from) || !isAddress(a.to) || !isHex(a.nonce) || a.nonce.length !== 66) fail('malformed authorization');

  let value: bigint, validAfter: bigint, validBefore: bigint;
  try {
    [value, validAfter, validBefore] = [BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore)];
  } catch {
    return fail('malformed authorization amounts');
  }

  // Recipient and amount: exact, to the seller.
  if (getAddress(a.to) !== getAddress(req.payTo)) fail('wrong recipient');
  if (value !== BigInt(req.maxAmountRequired)) fail(`amount ${value} does not equal price ${req.maxAmountRequired}`);

  // Validity window: usable now, still usable when it lands, and not an open-ended authorization.
  if (validAfter > BigInt(now)) fail('authorization not yet valid');
  if (validBefore < BigInt(now + MIN_VALIDITY_SECONDS)) fail('authorization expired or about to expire');
  if (validBefore > BigInt(now + req.maxTimeoutSeconds + 30)) fail('authorization validity window too long');

  // Signature over the seller's token domain. A signature for any other token, chain, or amount fails here.
  const valid = await verifyTypedData({
    address: a.from,
    domain: tokenDomain(req, chainId),
    types: transferWithAuthorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: { from: a.from, to: a.to, value, validAfter, validBefore, nonce: a.nonce },
    signature,
  }).catch(() => false);
  if (!valid) fail('invalid signature');

  return { authorization: a, signature, payer: getAddress(a.from), nonce: a.nonce.toLowerCase() as Hex };
}
