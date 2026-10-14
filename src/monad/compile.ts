import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Abi, Hex } from 'viem';

const require = createRequire(import.meta.url);

/** Compiles contracts/TestUSD.sol with solc-js, resolving @openzeppelin imports from node_modules. */
export function compileTestUSD(): { abi: Abi; bytecode: Hex } {
  const solc = require('solc');
  const input = {
    language: 'Solidity',
    sources: { 'TestUSD.sol': { content: fs.readFileSync(path.resolve('contracts/TestUSD.sol'), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const findImports = (p: string) => {
    try {
      return { contents: fs.readFileSync(require.resolve(p), 'utf8') };
    } catch {
      return { error: `not found: ${p}` };
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const c = out.contracts['TestUSD.sol'].TestUSD;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}
