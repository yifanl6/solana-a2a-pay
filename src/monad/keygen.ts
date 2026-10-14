import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { MONAD_ROLES, keyExists, saveKey, loadAccount } from './config';

// Creates any missing wallets. Only the treasury needs funding from the faucet; setup distributes the rest.
for (const role of MONAD_ROLES) if (!keyExists(role)) saveKey(role, generatePrivateKey());
for (const role of MONAD_ROLES) console.log(`${role.padEnd(13)} ${loadAccount(role).address}`);
