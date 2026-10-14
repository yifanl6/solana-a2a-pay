import { parseAbi } from 'viem';

// Runtime ABI for contracts/TestUSD.sol, so hosted agents don't need the compiler.
export const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
  'function mint(address to, uint256 amount)',
  'function faucet()',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'error AuthorizationNotYetValid()',
  'error AuthorizationExpired()',
  'error AuthorizationAlreadyUsed()',
  'error InvalidSignature()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
]);

export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;
