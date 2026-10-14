import { formatEther, getAddress, parseEther, type Address } from 'viem';
import {
  EXPLORER,
  MONAD_ROLES,
  NETWORK,
  RPC_URL,
  addressUrl,
  chain,
  deploymentExists,
  fmtUsd,
  keyExists,
  loadAccount,
  loadDeployment,
  publicClient,
  saveDeployment,
  saveKey,
  usd,
  walletClient,
  type Deployment,
  type MonadRole,
} from './config';
import { compileTestUSD } from './compile';
import { tokenAbi } from './token';
import { generatePrivateKey } from 'viem/accounts';

// The treasury deploys the token and funds everyone. Sellers need MON for gas (they submit payments);
// buyers (orchestrator, attacker) never need MON.
const SELLER_MON = parseEther(process.env.SELLER_MON ?? '1');
const USD_TARGET: Partial<Record<MonadRole, number>> = { orchestrator: 25, analyst: 5, attacker: 1 };

async function main() {
  console.log(`network ${NETWORK} (chain ${chain.id})  rpc ${RPC_URL}\n`);
  for (const role of MONAD_ROLES) if (!keyExists(role)) saveKey(role, generatePrivateKey());
  const accounts = Object.fromEntries(MONAD_ROLES.map((r) => [r, loadAccount(r)])) as Record<MonadRole, ReturnType<typeof loadAccount>>;
  const treasury = walletClient(accounts.treasury);

  const treasuryBalance = await publicClient.getBalance({ address: accounts.treasury.address });
  if (treasuryBalance === 0n) {
    throw new Error(`treasury ${accounts.treasury.address} has no MON. Fund it (testnet: https://faucet.monad.xyz) and re-run.`);
  }

  // 1. Token: reuse the recorded deployment if its code is still there.
  let token: Address | undefined;
  let deployTx: `0x${string}` | undefined;
  if (deploymentExists()) {
    const d = loadDeployment();
    const code = await publicClient.getCode({ address: d.token });
    if (code && code !== '0x') [token, deployTx] = [d.token, d.deployTx];
  }
  if (!token) {
    console.log('compiling and deploying TestUSD…');
    const { abi, bytecode } = compileTestUSD();
    deployTx = await treasury.deployContract({ abi, bytecode });
    const receipt = await confirmed(deployTx);
    token = getAddress(receipt.contractAddress!);
    console.log(`  deployed at ${token}  ${EXPLORER}/tx/${deployTx}`);
  }

  // 2. Gas money for the sellers.
  for (const role of ['data', 'analyst'] as MonadRole[]) {
    const balance = await publicClient.getBalance({ address: accounts[role].address });
    if (balance < SELLER_MON / 2n) {
      const hash = await treasury.sendTransaction({ to: accounts[role].address, value: SELLER_MON - balance });
      await confirmed(hash);
      console.log(`  sent ${formatEther(SELLER_MON - balance)} MON to ${role}  ${EXPLORER}/tx/${hash}`);
    }
  }

  // 3. Test stablecoin for the buyers.
  for (const [role, dollars] of Object.entries(USD_TARGET) as [MonadRole, number][]) {
    const balance = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [accounts[role].address] });
    if (balance < usd(dollars)) {
      const hash = await treasury.writeContract({ address: token, abi: tokenAbi, functionName: 'mint', args: [accounts[role].address, usd(dollars) - balance] });
      await confirmed(hash);
      console.log(`  minted ${fmtUsd(usd(dollars) - balance)} tUSDC to ${role}`);
    }
  }

  const deployment: Deployment = {
    network: NETWORK,
    chainId: chain.id,
    token,
    tokenName: 'Test USD Coin',
    tokenVersion: '1',
    deployTx: deployTx!,
    agents: Object.fromEntries(MONAD_ROLES.map((r) => [r, accounts[r].address])) as Record<MonadRole, Address>,
  };
  saveDeployment(deployment);

  console.log(`\ntUSDC ${addressUrl(token)}\n`);
  for (const role of MONAD_ROLES) {
    const address = accounts[role].address;
    const [mon, stable] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [address] }),
    ]);
    console.log(`${role.padEnd(13)} ${address}  ${Number(formatEther(mon)).toFixed(4).padStart(9)} MON  ${fmtUsd(stable).padStart(9)} tUSDC`);
  }
  console.log('\nsetup complete');
}

async function confirmed(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
