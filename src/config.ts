import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
export const NETWORK = process.env.NETWORK ?? 'solana-localnet';

export const DATA_AGENT_PORT = Number(process.env.DATA_AGENT_PORT ?? 4001);
export const ANALYST_PORT = Number(process.env.ANALYST_PORT ?? 4002);
export const DATA_AGENT_URL = process.env.DATA_AGENT_URL ?? `http://localhost:${DATA_AGENT_PORT}`;
export const ANALYST_URL = process.env.ANALYST_URL ?? `http://localhost:${ANALYST_PORT}`;

export const WALLET_DIR = path.resolve(process.env.WALLET_DIR ?? path.join('.wallets', NETWORK));
const CONFIG_PATH = path.join(WALLET_DIR, 'config.json');

// The test stablecoin uses 6 decimals, like USDC: 1 unit = $0.000001.
export const DECIMALS = 6;
export const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 10 ** DECIMALS));
export const fmtUsd = (units: bigint): string => `$${(Number(units) / 10 ** DECIMALS).toFixed(4)}`;

export const connection = (): Connection => new Connection(RPC_URL, 'confirmed');

export type Role = 'treasury' | 'orchestrator' | 'analyst' | 'data' | 'attacker';
export const ROLES: Role[] = ['treasury', 'orchestrator', 'analyst', 'data', 'attacker'];

const keypairPath = (role: Role) => path.join(WALLET_DIR, `${role}.json`);

export function keypairExists(role: Role): boolean {
  return fs.existsSync(keypairPath(role));
}

export function saveKeypair(role: Role, kp: Keypair): void {
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(keypairPath(role), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
}

export function loadKeypair(role: Role): Keypair {
  const file = keypairPath(role);
  if (!fs.existsSync(file)) throw new Error(`missing wallet ${file}; run \`npm run setup\` first`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

export interface NetworkConfig {
  network: string;
  rpcUrl: string;
  mint: string;
  decimals: number;
  agents: Record<Role, string>;
}

export function saveNetworkConfig(cfg: NetworkConfig): void {
  fs.mkdirSync(WALLET_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function loadNetworkConfig(): NetworkConfig {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`missing ${CONFIG_PATH}; run \`npm run setup\` first`);
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export const agentKey = (cfg: NetworkConfig, role: Role): PublicKey => new PublicKey(cfg.agents[role]);
