import { NETWORK, fmtUsd, loadAccount, loadDeployment } from './config';
import { runOrchestration, type ReportResult } from './run';

// Buyer only, with a hard budget. Default targets: the agents' own wallets plus the token contract.
const dep = loadDeployment();
const account = loadAccount('orchestrator');
const targets = process.argv.length > 2 ? process.argv.slice(2) : [dep.agents.data, dep.token, dep.agents.treasury];

function print(r: ReportResult) {
  console.log(`▶ risk report for ${r.address}`);
  if (r.outcome === 'refused') return console.log(`  ⛔ refused by spend policy: ${r.reason}\n`);
  if (r.outcome === 'failed') return console.log(`  ✗ ${r.reason}\n`);
  console.log(`  paid ${fmtUsd(BigInt(r.paid!.amount))}  (${r.ms} ms)  ${r.paid!.explorer}`);
  console.log(`  score ${r.report!.score}/100 (${r.report!.level})`);
  for (const f of r.report!.factors) console.log(`    ${f.points >= 0 ? '+' : ''}${f.points}  ${f.factor}: ${f.detail}`);
  const p = r.provenance!;
  const got = p.dataAgentReceived === null ? '?' : fmtUsd(BigInt(p.dataAgentReceived));
  console.log(`  provenance: data agent received ${got} ${p.verified ? '✓ verified on-chain' : '✗ NOT VERIFIED'}  ${p.explorer}`);
  console.log(`  budget left ${fmtUsd(BigInt(r.budgetLeft))}\n`);
}

async function main() {
  console.log(`orchestrator ${account.address} on ${NETWORK}`);
  console.log('policy: budget $0.0500, max $0.0200/call, payees [analyst]\n');
  const run = await runOrchestration(dep, account, targets, print);
  console.log(`tracked spend ${fmtUsd(BigInt(run.trackedSpend))} across ${run.results.filter((r) => r.paid).length} payments`);
  console.log(`on-chain balance change ${fmtUsd(BigInt(run.onChainDelta))} ${run.matches ? '✓ matches' : '✗ MISMATCH'}`);
  if (!run.matches) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
