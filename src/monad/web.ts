import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { formatEther, isAddress } from 'viem';
import { ANALYST_URL, DATA_AGENT_URL, EXPLORER, NETWORK, chain, loadAccount, loadDeployment, publicClient } from './config';
import { balanceOf, runOrchestration, type RunResult } from './run';

// Public dashboard: lets anyone trigger a live orchestrator run against the hosted agents and watch it settle on Monad.
const dep = loadDeployment();
const account = loadAccount('orchestrator');
const PORT = Number(process.env.PORT ?? 4100);
const COOLDOWN_MS = Number(process.env.RUN_COOLDOWN_MS ?? 15_000);
const MAX_RUNS_PER_HOUR = Number(process.env.MAX_RUNS_PER_HOUR ?? 40);
const HTML_PATH = path.resolve('src/monad/dashboard.html');

let running = false;
let lastRunAt = 0;
let runTimes: number[] = [];
let lastRun: (RunResult & { at: string }) | null = null;

const app = express();
app.get('/', (_req, res) => res.type('html').send(fs.readFileSync(HTML_PATH, 'utf8')));

// Public passthrough to the agents, so external x402 clients can pay them through this one URL:
// e.g. GET /agents/analyst/risk/0x… returns the analyst's 402 quote, and the retry with X-PAYMENT settles.
const AGENTS: Record<string, string> = { analyst: ANALYST_URL, data: DATA_AGENT_URL };
app.use('/agents/:agent', async (req, res) => {
  const base = AGENTS[req.params.agent];
  if (!base || req.method !== 'GET') return res.status(404).json({ error: 'unknown agent' });
  try {
    const payment = req.header('X-PAYMENT');
    const upstream = await fetch(base + req.url, { headers: payment ? { 'X-PAYMENT': payment } : {}, signal: AbortSignal.timeout(60_000) });
    res.status(upstream.status);
    for (const h of ['content-type', 'x-payment-response']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).json({ error: `${req.params.agent} agent unreachable` });
  }
});

app.get('/api/status', async (_req, res) => {
  try {
    const roles = [
      { role: 'orchestrator', address: account.address, url: null },
      { role: 'analyst', address: dep.agents.analyst, url: '/agents/analyst' },
      { role: 'data', address: dep.agents.data, url: '/agents/data' },
    ];
    const agents = await Promise.all(
      roles.map(async (r) => ({
        ...r,
        mon: formatEther(await publicClient.getBalance({ address: r.address })),
        tusdc: (await balanceOf(dep, r.address)).toString(),
      })),
    );
    const describe = async (url: string) => {
      try {
        return (await (await fetch(`${url}/`, { signal: AbortSignal.timeout(5000) })).json()) as { recentPayments: Array<Record<string, string> & { at: string }>; offline?: boolean };
      } catch {
        return { recentPayments: [], offline: true };
      }
    };
    const [analyst, data] = await Promise.all([describe(ANALYST_URL), describe(DATA_AGENT_URL)]);
    const recent = [
      ...analyst.recentPayments.map((p) => ({ ...p, seller: 'analyst' })),
      ...data.recentPayments.map((p) => ({ ...p, seller: 'data' })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 20);
    res.json({
      network: NETWORK,
      chainId: chain.id,
      explorer: EXPLORER,
      token: dep.token,
      agents,
      recent,
      lastRun,
      online: { analyst: !analyst.offline, data: !data.offline },
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Server-sent events: one `result` event per report as it settles, then `done` with the totals.
app.get('/api/run', async (req, res) => {
  const custom = String(req.query.address ?? '').trim();
  if (custom && !isAddress(custom)) return res.status(400).json({ error: 'invalid EVM address' });

  const now = Date.now();
  runTimes = runTimes.filter((t) => now - t < 3_600_000);
  if (running) return res.status(429).json({ error: 'a run is already in progress, try again in a few seconds' });
  if (now - lastRunAt < COOLDOWN_MS) return res.status(429).json({ error: `cooldown: try again in ${Math.ceil((COOLDOWN_MS - (now - lastRunAt)) / 1000)}s` });
  if (runTimes.length >= MAX_RUNS_PER_HOUR) return res.status(429).json({ error: 'hourly demo limit reached (testnet gas is finite)' });

  running = true;
  lastRunAt = now;
  runTimes.push(now);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Three targets at $0.02 each against a $0.05 budget: two get paid, the third is refused by policy.
  const targets = [custom || dep.agents.data, dep.token, dep.agents.treasury];
  send('start', { targets, orchestrator: account.address });
  try {
    const run = await runOrchestration(dep, account, targets, (r) => send('result', r));
    lastRun = { ...run, at: new Date().toISOString() };
    send('done', run);
  } catch (e) {
    send('fail', { error: (e as Error).message });
  } finally {
    running = false;
    res.end();
  }
});

app.listen(PORT, () => console.log(`[web] ${NETWORK} dashboard on :${PORT}  analyst ${ANALYST_URL}  data ${DATA_AGENT_URL}`));
