import express from 'express';
import { isAddress, type Address } from 'viem';
import { DATA_AGENT_PORT, NETWORK, loadAccount, loadDeployment, publicClient, usd } from './config';
import { createSeller } from './server';
import { tokenAbi } from './token';

// Seller only: sells raw on-chain account data at $0.005 per call.
const dep = loadDeployment();
const account = loadAccount('data');
const seller = createSeller({
  name: 'data-agent',
  account,
  token: dep.token,
  tokenName: dep.tokenName,
  tokenVersion: dep.tokenVersion,
  network: NETWORK,
});

export async function accountSnapshot(address: Address) {
  const [block, balance, txCount, code, stable] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getBalance({ address }),
    publicClient.getTransactionCount({ address }),
    publicClient.getCode({ address }),
    publicClient.readContract({ address: dep.token, abi: tokenAbi, functionName: 'balanceOf', args: [address] }),
  ]);
  return {
    address,
    network: NETWORK,
    block: block.toString(),
    balanceWei: balance.toString(),
    txCount,
    isContract: !!code && code !== '0x',
    codeSize: code && code !== '0x' ? (code.length - 2) / 2 : 0,
    stablecoinBalance: stable.toString(),
  };
}
export type AccountSnapshot = Awaited<ReturnType<typeof accountSnapshot>>;

const app = express();
app.set('trust proxy', true);
app.get('/', seller.describe());
app.get(
  '/account/:address',
  (req, res, next) => (isAddress(req.params.address) ? next() : res.status(400).json({ error: 'invalid EVM address' })),
  seller.paywall('/account/:address', { price: usd(0.005), description: 'On-chain account snapshot for a Monad address' }),
  async (req, res) => {
    try {
      res.json({ ...(await accountSnapshot(req.params.address as Address)), payment: res.locals.payment });
    } catch (e) {
      console.error(`[data-agent] refund owed to ${res.locals.payment.payer} (tx ${res.locals.payment.transaction}): ${e}`);
      res.status(502).json({ error: 'RPC unavailable', refundOwed: res.locals.payment });
    }
  },
);

app.listen(DATA_AGENT_PORT, () => {
  console.log(`[data-agent] ${NETWORK} listening on :${DATA_AGENT_PORT}  payTo ${account.address}  price $0.005/call`);
});
