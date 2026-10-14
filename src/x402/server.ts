import type { Request, RequestHandler, Response } from 'express';
import { Connection, Keypair, PublicKey, type TransactionSignature } from '@solana/web3.js';
import { NonceStore } from './nonce';
import { DEFAULT_LIMITS, PaymentRejected, verifyPayment, type VerifyLimits } from './verify';
import {
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

export interface SellerOptions {
  name: string;
  connection: Connection;
  keypair: Keypair; // receives payments AND acts as fee payer (self-hosted facilitator)
  mint: PublicKey;
  decimals: number;
  network: string;
  limits?: VerifyLimits;
  log?: (msg: string) => void;
}

export interface PaywallOptions {
  price: bigint; // base units
  description: string;
  mimeType?: string;
}

/** Attached to res.locals.payment once a request has been paid and settled. */
export interface SettledPayment {
  signature: TransactionSignature;
  payer: string;
  amount: string;
  feeLamports: number;
}

export function createSeller(opts: SellerOptions) {
  const nonces = new NonceStore();
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const log = opts.log ?? ((m: string) => console.log(`[${opts.name}] ${m}`));
  const offers: Array<{ path: string } & PaywallOptions> = [];

  const requirementsFor = (req: Request, p: PaywallOptions, nonce: string): PaymentRequirements => ({
    scheme: 'exact',
    network: opts.network,
    maxAmountRequired: p.price.toString(),
    resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    description: p.description,
    mimeType: p.mimeType ?? 'application/json',
    payTo: opts.keypair.publicKey.toBase58(),
    maxTimeoutSeconds: 60,
    asset: opts.mint.toBase58(),
    extra: { feePayer: opts.keypair.publicKey.toBase58(), decimals: opts.decimals, nonce },
  });

  function paywall(p: PaywallOptions): RequestHandler {
    return async (req, res, next) => {
      // Nonces are bound to method + path, not the full URL, since the Host header is client controlled.
      const resourceKey = `${req.method} ${req.originalUrl}`;
      const paymentRequired = (error: string) => {
        const body: PaymentRequiredResponse = {
          x402Version: X402_VERSION,
          error,
          accepts: [requirementsFor(req, p, nonces.issue(resourceKey, p.price))],
        };
        res.status(402).json(body);
      };

      const header = req.header(PAYMENT_HEADER);
      if (!header) return paymentRequired(`${PAYMENT_HEADER} header is required`);

      let verified;
      try {
        const payload = decodeHeader<PaymentPayload>(header);
        // Verify against the seller's own requirements, never anything the client echoes back.
        verified = verifyPayment(payload, requirementsFor(req, p, ''), limits);
      } catch (e) {
        const reason = e instanceof PaymentRejected ? e.message : 'malformed X-PAYMENT header';
        log(`rejected payment for ${resourceKey}: ${reason}`);
        return paymentRequired(reason);
      }

      // Burn the nonce before submitting, so a concurrent replay can't race the confirmation.
      const nonceError = nonces.consume(verified.nonce, resourceKey, p.price);
      if (nonceError) {
        log(`rejected payment for ${resourceKey}: ${nonceError}`);
        return paymentRequired(nonceError);
      }

      verified.tx.sign([opts.keypair]);
      let signature: TransactionSignature;
      try {
        signature = await opts.connection.sendRawTransaction(verified.tx.serialize(), { maxRetries: 3 });
        await waitForConfirmation(opts.connection, signature);
      } catch (e) {
        const reason = `settlement failed: ${(e as Error).message.split('\n')[0]}`;
        log(`${reason} (payer ${verified.payer.toBase58()})`);
        return paymentRequired(reason);
      }

      const settlement: SettlementResponse = {
        success: true,
        transaction: signature,
        network: opts.network,
        payer: verified.payer.toBase58(),
      };
      res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeader(settlement));
      res.locals.payment = {
        signature,
        payer: settlement.payer,
        amount: verified.amount.toString(),
        feeLamports: verified.feeLamports,
      } satisfies SettledPayment;
      log(`paid ${p.price} units by ${short(settlement.payer)} for ${req.originalUrl}  tx ${short(signature)}  fee ${verified.feeLamports} lamports`);
      next();
    };
  }

  return {
    /** Registers a paid route's metadata for discovery and returns its paywall middleware. */
    paywall(path: string, p: PaywallOptions): RequestHandler {
      offers.push({ path, ...p });
      return paywall(p);
    },
    /** GET / handler: what this agent sells, for discovery by other agents. */
    describe(): RequestHandler {
      return (_req: Request, res: Response) => {
        res.json({
          agent: opts.name,
          x402Version: X402_VERSION,
          network: opts.network,
          payTo: opts.keypair.publicKey.toBase58(),
          asset: opts.mint.toBase58(),
          offers: offers.map((o) => ({ path: o.path, price: o.price.toString(), description: o.description })),
        });
      };
    },
  };
}

export async function waitForConfirmation(connection: Connection, signature: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('confirmation timed out');
}

export const short = (s: string): string => `${s.slice(0, 4)}…${s.slice(-4)}`;
