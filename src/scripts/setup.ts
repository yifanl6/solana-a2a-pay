import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createMint, getAccount, getMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import {
  DECIMALS,
  NETWORK,
  RPC_URL,
  ROLES,
  WALLET_DIR,
  connection,
  fmtUsd,
  keypairExists,
  loadKeypair,
  loadNetworkConfig,
  saveKeypair,
  saveNetworkConfig,
  usd,
  type Role,
} from '../config';

// Who needs SOL: the treasury creates the mint and token accounts; sellers pay settlement fees.
// Buyers (orchestrator, attacker) never need SOL because sellers sponsor fees.
const SOL_TARGET: Partial<Record<Role, number>> = { treasury: 2, data: 1, analyst: 1 };
const USD_TARGET: Partial<Record<Role, number>> = { orchestrator: 1.0, analyst: 0.25, attacker: 0.1 };

const conn = connection();

async function main() {
  console.log(`network ${NETWORK}  rpc ${RPC_URL}\nwallets ${WALLET_DIR}\n`);

  const wallets = {} as Record<Role, Keypair>;
  for (const role of ROLES) {
    if (!keypairExists(role)) saveKeypair(role, Keypair.generate());
    wallets[role] = loadKeypair(role);
  }

  for (const [role, sol] of Object.entries(SOL_TARGET) as [Role, number][]) {
    await ensureSol(role, wallets[role].publicKey, sol);
  }

  const treasury = wallets.treasury;
  const mint = await ensureMint(treasury);

  for (const role of ['orchestrator', 'analyst', 'data', 'attacker'] as Role[]) {
    const ata = await getOrCreateAssociatedTokenAccount(conn, treasury, mint, wallets[role].publicKey);
    const target = usd(USD_TARGET[role] ?? 0);
    const balance = (await getAccount(conn, ata.address)).amount;
    if (balance < target) await mintTo(conn, treasury, mint, ata.address, treasury, target - balance);
  }

  saveNetworkConfig({
    network: NETWORK,
    rpcUrl: RPC_URL,
    mint: mint.toBase58(),
    decimals: DECIMALS,
    agents: Object.fromEntries(ROLES.map((r) => [r, wallets[r].publicKey.toBase58()])) as Record<Role, string>,
  });

  console.log(`test stablecoin (tUSDC) mint ${mint.toBase58()}\n`);
  for (const role of ROLES) {
    const pk = wallets[role].publicKey;
    const sol = (await conn.getBalance(pk)) / LAMPORTS_PER_SOL;
    let tokens = 0n;
    try {
      tokens = (await getOrCreateAssociatedTokenAccount(conn, treasury, mint, pk)).amount;
    } catch {}
    console.log(`${role.padEnd(13)} ${pk.toBase58().padEnd(45)} ${sol.toFixed(3).padStart(8)} SOL  ${fmtUsd(tokens).padStart(9)} tUSDC`);
  }
  console.log('\nsetup complete');
}

async function ensureSol(role: Role, pk: PublicKey, target: number) {
  const balance = await conn.getBalance(pk);
  if (balance >= (target / 2) * LAMPORTS_PER_SOL) return;
  console.log(`airdropping ${target} SOL to ${role}…`);
  try {
    const sig = await conn.requestAirdrop(pk, target * LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  } catch (e) {
    throw new Error(
      `airdrop to ${role} (${pk.toBase58()}) failed: ${(e as Error).message}\n` +
        `On devnet the faucet is rate limited: fund it at https://faucet.solana.com and re-run setup.`,
    );
  }
}

async function ensureMint(treasury: Keypair): Promise<PublicKey> {
  try {
    const existing = new PublicKey(loadNetworkConfig().mint);
    await getMint(conn, existing); // still exists (a --reset validator wipes it)
    return existing;
  } catch {
    return createMint(conn, treasury, treasury.publicKey, null, DECIMALS);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
