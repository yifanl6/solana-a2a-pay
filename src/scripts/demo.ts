import { spawn, type ChildProcess } from 'node:child_process';
import { ANALYST_URL, DATA_AGENT_URL } from '../config';

// One-command demo: starts both agents, runs the orchestrator, then the attack suite, then shuts down.
// Assumes a validator is running and `npm run setup` has been done.
const children: ChildProcess[] = [];
const start = (script: string) => {
  const child = spawn('npx', ['tsx', script], { stdio: 'inherit', env: process.env });
  children.push(child);
  return child;
};
const run = (script: string, args: string[] = []) =>
  new Promise<number>((resolve) => spawn('npx', ['tsx', script, ...args], { stdio: 'inherit', env: process.env }).on('exit', (c) => resolve(c ?? 1)));

async function waitFor(url: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

const banner = (t: string) => console.log(`\n${'═'.repeat(70)}\n  ${t}\n${'═'.repeat(70)}`);

async function main() {
  start('src/agents/data-agent.ts');
  start('src/agents/analyst-agent.ts');
  await Promise.all([waitFor(`${DATA_AGENT_URL}/`), waitFor(`${ANALYST_URL}/`)]);

  banner('orchestrator → analyst → data agent');
  const a = await run('src/agents/orchestrator.ts', process.argv.slice(2));
  banner('adversarial checks against the data agent');
  const b = await run('src/scripts/attack.ts');
  process.exitCode = a || b;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => children.forEach((c) => c.kill()));
