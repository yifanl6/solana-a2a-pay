import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { monad, monadTestnet } from 'viem/chains';

// x402 network names; mainnet is opt-in via MONAD_NETWORK=monad.
export const NETWORK = process.env.MONAD_NETWORK ?? 'monad-testnet';
const CHAINS: Record<string, Chain> = { 'monad-testnet': monadTestnet, monad };
export const chain = CHAINS[NETWORK] ?? (() => { throw new Error(`unknown MONAD_NETWORK ${NETWORK}`); })();
export const RPC_URL = process.env.RPC_URL ?? chain.rpcUrls.default.http[0];
export const EXPLORER = chain.blockExplorers!.default.url;
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;

export const DATA_AGENT_PORT = Number(process.env.DATA_AGENT_PORT ?? process.env.PORT ?? 4101);
export const ANALYST_PORT = Number(process.env.ANALYST_PORT ?? process.env.PORT ?? 4102);
export const DATA_AGENT_URL = process.env.DATA_AGENT_URL ?? 'http://localhost:4101';
export const ANALYST_URL = process.env.ANALYST_URL ?? 'http://localhost:4102';

// Test stablecoin: 6 decimals, like USDC.
export const DECIMALS = 6;
export const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 10 ** DECIMALS));
export const fmtUsd = (units: bigint): string => `$${(Number(units) / 10 ** DECIMALS).toFixed(4)}`;

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
export const walletClient = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(RPC_URL) });

export type MonadRole = 'treasury' | 'orchestrator' | 'analyst' | 'data' | 'attacker';
export const MONAD_ROLES: MonadRole[] = ['treasury', 'orchestrator', 'analyst', 'data', 'attacker'];

// Keys come from <ROLE>_PRIVATE_KEY (for hosted agents) or .wallets/<network>/<role>.key (local).
const WALLET_DIR = path.resolve(process.env.WALLET_DIR ?? path.join('.wallets', NETWORK));
const keyPath = (role: MonadRole) => path.join(WALLET_DIR, `${role}.key`);
const envKey = (role: MonadRole) => process.env[`${role.toUpperCase()}_PRIVATE_KEY`] as Hex | undefined;

export const keyExists = (role: MonadRole) => !!envKey(role) || fs.existsSync(keyPath(role));

export function saveKey(role: MonadRole, key: Hex): void {
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(keyPath(role), key, { mode: 0o600 });
}

export function loadAccount(role: MonadRole): PrivateKeyAccount {
  const key = envKey(role) ?? (fs.existsSync(keyPath(role)) ? (fs.readFileSync(keyPath(role), 'utf8').trim() as Hex) : undefined);
  if (!key) throw new Error(`no key for ${role}: set ${role.toUpperCase()}_PRIVATE_KEY or run \`npm run monad:setup\``);
  return privateKeyToAccount(key);
}

// Public deployment record, committed to the repo so hosted agents and judges can find the token.
export interface Deployment {
  network: string;
  chainId: number;
  token: Address;
  tokenName: string;
  tokenVersion: string;
  deployTx: Hex;
  agents: Record<MonadRole, Address>;
}
const DEPLOYMENT_PATH = path.resolve('deployments', `${NETWORK}.json`);

export function saveDeployment(d: Deployment): void {
  fs.mkdirSync(path.dirname(DEPLOYMENT_PATH), { recursive: true });
  fs.writeFileSync(DEPLOYMENT_PATH, JSON.stringify(d, null, 2) + '\n');
}

export function loadDeployment(): Deployment {
  if (!fs.existsSync(DEPLOYMENT_PATH)) throw new Error(`missing ${DEPLOYMENT_PATH}; run \`npm run monad:setup\` first`);
  return JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
}

export const deploymentExists = () => fs.existsSync(DEPLOYMENT_PATH);
