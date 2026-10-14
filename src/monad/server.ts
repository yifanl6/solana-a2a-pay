import type { Request, RequestHandler, Response } from 'express';
import { BaseError, ContractFunctionRevertedError, formatEther, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { NonceStore } from '../x402/nonce';
import { chain, publicClient, txUrl, walletClient } from './config';
import { tokenAbi } from './token';
import {
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PaymentRejected,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  verifyAuthorization,
  type EvmPaymentPayload,
  type EvmPaymentRequirements,
  type PaymentRequiredResponse,
  type SettlementResponse,
} from './x402';

export interface SellerOptions {
  name: string;
  account: PrivateKeyAccount; // receives payments AND submits them, paying gas (self-hosted facilitator)
  token: Address;
  tokenName: string;
  tokenVersion: string;
  network: string;
  log?: (msg: string) => void;
}

export interface PaywallOptions {
  price: bigint;
  description: string;
  mimeType?: string;
}

export interface SettledPayment {
  transaction: Hex;
  payer: Address;
  amount: string;
  gasFeeWei: string;
  explorer: string;
}

export interface PaymentEvent extends SettledPayment {
  at: string;
  resource: string;
}

export function createSeller(opts: SellerOptions) {
  const nonces = new NonceStore(120_000, 50_000, 32, '0x');
  const wallet = walletClient(opts.account);
  const log = opts.log ?? ((m: string) => console.log(`[${opts.name}] ${m}`));
  const offers: Array<{ path: string } & PaywallOptions> = [];
  const recent: PaymentEvent[] = [];
  const sender = new SerialSender(opts.account.address);

  const requirementsFor = (req: Request, p: PaywallOptions, nonce: Hex): EvmPaymentRequirements => ({
    scheme: 'exact',
    network: opts.network,
    maxAmountRequired: p.price.toString(),
    resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    description: p.description,
    mimeType: p.mimeType ?? 'application/json',
    payTo: opts.account.address,
    maxTimeoutSeconds: 60,
    asset: opts.token,
    extra: { name: opts.tokenName, version: opts.tokenVersion, nonce },
  });

  function paywall(p: PaywallOptions): RequestHandler {
    return async (req, res, next) => {
      const resourceKey = `${req.method} ${req.originalUrl}`;
      const paymentRequired = (error: string) => {
        const nonce = nonces.issue(resourceKey, p.price) as Hex;
        res.status(402).json({ x402Version: X402_VERSION, error, accepts: [requirementsFor(req, p, nonce)] } satisfies PaymentRequiredResponse);
      };
      const reject = (reason: string) => {
        log(`rejected payment for ${resourceKey}: ${reason}`);
        paymentRequired(reason);
      };

      const header = req.header(PAYMENT_HEADER);
      if (!header) return paymentRequired(`${PAYMENT_HEADER} header is required`);

      let verified;
      try {
        // Checked against the seller's own requirements, never anything the client echoes back.
        verified = await verifyAuthorization(decodeHeader<EvmPaymentPayload>(header), requirementsFor(req, p, '0x'), chain.id);
      } catch (e) {
        return reject(e instanceof PaymentRejected ? e.message : 'malformed X-PAYMENT header');
      }

      // Burn the off-chain nonce first; EIP-3009 also enforces single use on-chain.
      const nonceError = nonces.consume(verified.nonce, resourceKey, p.price);
      if (nonceError) return reject(nonceError);

      const a = verified.authorization;
      const call = {
        account: opts.account,
        address: opts.token,
        abi: tokenAbi,
        functionName: 'transferWithAuthorization',
        args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, verified.signature],
      } as const;

      // Simulate before spending gas: catches insufficient balance, used nonces, bad signatures on-chain.
      let gas: bigint;
      try {
        await publicClient.simulateContract(call);
        gas = ((await publicClient.estimateContractGas(call)) * 12n) / 10n; // Monad charges the gas limit, keep it tight
      } catch (e) {
        return reject(`simulation failed: ${revertReason(e)}`);
      }

      let transaction: Hex;
      let gasFeeWei: bigint;
      try {
        transaction = await sender.send((nonce) => wallet.writeContract({ ...call, gas, nonce }));
        const receipt = await publicClient.waitForTransactionReceipt({ hash: transaction, timeout: 30_000 });
        if (receipt.status !== 'success') throw new Error(`transaction reverted (${transaction})`);
        gasFeeWei = receipt.gasUsed * receipt.effectiveGasPrice;
      } catch (e) {
        return reject(`settlement failed: ${revertReason(e)}`);
      }

      const settlement: SettlementResponse = { success: true, transaction, network: opts.network, payer: verified.payer };
      res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeader(settlement));
      const payment: SettledPayment = {
        transaction,
        payer: verified.payer,
        amount: p.price.toString(),
        gasFeeWei: gasFeeWei.toString(),
        explorer: txUrl(transaction),
      };
      res.locals.payment = payment;
      recent.unshift({ ...payment, at: new Date().toISOString(), resource: req.originalUrl });
      recent.length = Math.min(recent.length, 50);
      log(`paid ${p.price} units by ${short(verified.payer)} for ${req.originalUrl}  tx ${short(transaction)}  gas ${formatEther(gasFeeWei)} MON`);
      next();
    };
  }

  return {
    paywall(path: string, p: PaywallOptions): RequestHandler {
      offers.push({ path, ...p });
      return paywall(p);
    },
    /** GET / handler: what this agent sells (for discovery by other agents) and its recent settlements. */
    describe(): RequestHandler {
      return (_req: Request, res: Response) => {
        res.json({
          agent: opts.name,
          x402Version: X402_VERSION,
          network: opts.network,
          chainId: chain.id,
          payTo: opts.account.address,
          asset: opts.token,
          offers: offers.map((o) => ({ path: o.path, price: o.price.toString(), description: o.description })),
          recentPayments: recent,
        });
      };
    },
  };
}

/**
 * Serializes submissions from one account and tracks its nonce locally, so concurrent paid requests
 * don't race on the account nonce. Resyncs from the chain after any failed send.
 */
class SerialSender {
  private next: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private address: Address) {}

  send(fn: (nonce: number) => Promise<Hex>): Promise<Hex> {
    const run = this.queue.then(async () => {
      this.next ??= await publicClient.getTransactionCount({ address: this.address, blockTag: 'pending' });
      try {
        const hash = await fn(this.next);
        this.next++;
        return hash;
      } catch (e) {
        this.next = undefined;
        throw e;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

export function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name === 'ERC20InsufficientBalance') return 'insufficient token balance';
    if (name) return name;
    return e.shortMessage;
  }
  return (e as Error).message.split('\n')[0];
}

export const short = (s: string): string => `${s.slice(0, 6)}…${s.slice(-4)}`;
