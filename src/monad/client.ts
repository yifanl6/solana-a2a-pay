import { getAddress, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { chain } from './config';
import { transferWithAuthorizationTypes } from './token';
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  tokenDomain,
  type Authorization,
  type EvmPaymentPayload,
  type EvmPaymentRequirements,
  type PaymentRequiredResponse,
  type SettlementResponse,
} from './x402';

export interface SpendPolicy {
  network: string;
  asset: Address;
  maxPerCall: bigint;
  budget: bigint;
  allowedPayees: Address[];
}

export class PolicyError extends Error {}

export interface PaymentRecord {
  resource: string;
  payTo: Address;
  amount: bigint;
  transaction: Hex;
}

export interface PaidResponse<T = any> {
  status: number;
  body: T;
  payment?: PaymentRecord;
}

/** Signs an EIP-3009 authorization for exactly the quoted price. Exported so the attack harness can tamper with it. */
export async function signAuthorization(
  account: PrivateKeyAccount,
  req: EvmPaymentRequirements,
  overrides: Partial<Authorization> = {},
  domainOverrides: Partial<ReturnType<typeof tokenDomain>> = {},
): Promise<EvmPaymentPayload> {
  const now = Math.floor(Date.now() / 1000);
  const authorization: Authorization = {
    from: account.address,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: String(now - 30), // tolerate clock skew
    validBefore: String(now + req.maxTimeoutSeconds),
    nonce: req.extra.nonce,
    ...overrides,
  };
  const signature = await account.signTypedData({
    domain: { ...tokenDomain(req, chain.id), ...domainOverrides },
    types: transferWithAuthorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  return { x402Version: X402_VERSION, scheme: 'exact', network: req.network, payload: { signature, authorization } };
}

export const paymentHeader = (payload: EvmPaymentPayload) => encodeHeader(payload);

/**
 * An HTTP client that pays x402 402 challenges by signing EIP-3009 authorizations, within a hard spend policy.
 * It never needs gas: the seller submits the authorization. The policy is checked before anything is signed.
 */
export class X402Client {
  spent = 0n;
  private reserved = 0n;
  readonly payments: PaymentRecord[] = [];

  constructor(
    private account: PrivateKeyAccount,
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

    this.reserved += amount; // reserve before signing so concurrent calls can't jointly exceed the budget
    try {
      const payload = await signAuthorization(this.account, req);
      const paid = await fetch(url, { headers: { [PAYMENT_HEADER]: paymentHeader(payload) } });
      const body = await readBody(paid);
      const receiptHeader = paid.headers.get(PAYMENT_RESPONSE_HEADER);
      if (!receiptHeader) throw new Error(`payment not accepted (${paid.status}): ${body?.error ?? JSON.stringify(body)}`);
      // A receipt means the money moved, even if the handler then failed (e.g. a 502).
      const receipt = decodeHeader<SettlementResponse>(receiptHeader);
      const payment: PaymentRecord = { resource: req.resource, payTo: req.payTo, amount, transaction: receipt.transaction };
      this.spent += amount;
      this.payments.push(payment);
      return { status: paid.status, body, payment };
    } finally {
      this.reserved -= amount;
    }
  }

  private choose(accepts: EvmPaymentRequirements[]): EvmPaymentRequirements {
    const p = this.policy;
    const candidates = accepts.filter(
      (a) => a.scheme === 'exact' && a.network === p.network && getAddress(a.asset) === getAddress(p.asset),
    );
    if (candidates.length === 0) throw new PolicyError(`no offer in the accepted token on ${p.network}`);
    const req = candidates.reduce((a, b) => (BigInt(a.maxAmountRequired) <= BigInt(b.maxAmountRequired) ? a : b));
    const amount = BigInt(req.maxAmountRequired);

    if (!p.allowedPayees.some((k) => getAddress(k) === getAddress(req.payTo))) throw new PolicyError(`payee ${req.payTo} is not on the allow-list`);
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
