import { formatEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DATA_AGENT_URL, chain, fmtUsd, loadAccount, loadDeployment, publicClient } from './config';
import { paymentHeader, signAuthorization } from './client';
import { balanceOf } from './run';
import { PAYMENT_HEADER, type EvmPaymentPayload, type EvmPaymentRequirements, type PaymentRequiredResponse } from './x402';

// Adversarial checks against a live data agent. Each attack gets a fresh, valid 402 quote, then tampers with the payment.
const dep = loadDeployment();
const attacker = loadAccount('attacker');
const seller = dep.agents.data;
const URL_A = `${DATA_AGENT_URL}/account/${dep.agents.treasury}`;
const URL_B = `${DATA_AGENT_URL}/account/${dep.agents.orchestrator}`;
const now = () => Math.floor(Date.now() / 1000);
const randomNonce = (): Hex => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`;

async function quote(url: string): Promise<EvmPaymentRequirements> {
  const res = await fetch(url);
  if (res.status !== 402) throw new Error(`expected 402 from ${url}, got ${res.status}`);
  return ((await res.json()) as PaymentRequiredResponse).accepts[0];
}

interface Attack {
  name: string;
  defense: string;
  run: () => Promise<{ url: string; payload: EvmPaymentPayload }>;
}

let replay: EvmPaymentPayload;

const attacks: Attack[] = [
  {
    name: 'underpay by one unit',
    defense: 'exact amount',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, req, { value: String(BigInt(req.maxAmountRequired) - 1n) }) };
    },
  },
  {
    name: 'pay yourself (wrong recipient)',
    defense: 'recipient check',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, req, { to: attacker.address }) };
    },
  },
  {
    name: 'sign for a worthless token (different contract)',
    defense: 'EIP-712 domain: verifyingContract',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, req, {}, { verifyingContract: privateKeyToAccount(generatePrivateKey()).address }) };
    },
  },
  {
    name: 'cross-chain signature (mainnet chain id)',
    defense: 'EIP-712 domain: chainId',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, req, {}, { chainId: chain.id === 143 ? 10143 : 143 }) };
    },
  },
  {
    name: 'tamper with amount after signing',
    defense: 'signature check',
    run: async () => {
      const req = await quote(URL_A);
      const payload = await signAuthorization(attacker, req, { value: '1' });
      payload.payload.authorization.value = req.maxAmountRequired;
      return { url: URL_A, payload };
    },
  },
  {
    name: "spend someone else's tokens (forged from)",
    defense: 'signature check',
    run: async () => {
      const req = await quote(URL_A);
      const payload = await signAuthorization(attacker, req);
      payload.payload.authorization.from = dep.agents.orchestrator;
      return { url: URL_A, payload };
    },
  },
  {
    name: 'expired authorization',
    defense: 'validity window',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, req, { validAfter: String(now() - 600), validBefore: String(now() - 60) }) };
    },
  },
  {
    name: 'not-yet-valid authorization',
    defense: 'validity window',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, req, { validAfter: String(now() + 3600), validBefore: String(now() + 3660) }) };
    },
  },
  {
    name: 'open-ended authorization (valid for a year)',
    defense: 'max validity window',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, req, { validBefore: String(now() + 365 * 86400) }) };
    },
  },
  {
    name: 'gas griefing: valid signature, empty wallet',
    defense: 'simulate before submitting',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(privateKeyToAccount(generatePrivateKey()), req) };
    },
  },
  {
    name: 'forged nonce',
    defense: 'seller-issued nonce',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, req, { nonce: randomNonce() }) };
    },
  },
  {
    name: 'nonce from a different resource',
    defense: 'nonce bound to resource',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_B, payload: await signAuthorization(attacker, req) };
    },
  },
  {
    name: 'wrong network in payload',
    defense: 'network check',
    run: async () => {
      const req = await quote(URL_A);
      return { url: URL_A, payload: await signAuthorization(attacker, { ...req, network: 'base' }) };
    },
  },
  {
    name: 'replay a payment that already settled',
    defense: 'nonce burned off-chain, and EIP-3009 on-chain',
    run: async () => ({ url: URL_A, payload: replay }),
  },
];

async function send(url: string, payload: EvmPaymentPayload) {
  const res = await fetch(url, { headers: { [PAYMENT_HEADER]: paymentHeader(payload) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: body.error ?? '' };
}

async function main() {
  console.log(`attacking data agent at ${DATA_AGENT_URL} (seller ${seller})\n`);
  const monBefore = await publicClient.getBalance({ address: seller });
  const tokensBefore = await balanceOf(dep, seller);

  // One honest payment first, so there is something to replay.
  const req = await quote(URL_A);
  replay = await signAuthorization(attacker, req);
  const first = await send(URL_A, replay);
  if (first.status !== 200) throw new Error(`honest payment failed (${first.status}): ${first.error}`);
  console.log('  ✓ control: honest $0.005 payment accepted (200)\n');

  let blocked = 0;
  for (const a of attacks) {
    const { url, payload } = await a.run();
    const { status, error } = await send(url, payload);
    const ok = status === 402;
    if (ok) blocked++;
    console.log(`  ${ok ? '✓ blocked' : '✗ ACCEPTED'}  ${a.name}`);
    console.log(`             ${a.defense} → ${status} "${error}"`);
  }

  await new Promise((r) => setTimeout(r, 2000)); // let state reads catch up with the last receipt
  const monAfter = await publicClient.getBalance({ address: seller });
  const tokensAfter = await balanceOf(dep, seller);
  console.log(`\n${blocked}/${attacks.length} attacks blocked`);
  console.log(`seller MON change -${formatEther(monBefore - monAfter)} (one honest settlement's gas; rejected attacks cost nothing)`);
  console.log(`seller token change +${fmtUsd(tokensAfter - tokensBefore)} (expected +$0.0050: the honest payment)`);
  if (blocked !== attacks.length || tokensAfter - tokensBefore !== 5000n) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
