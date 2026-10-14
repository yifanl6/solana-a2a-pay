import { spawn, type ChildProcess } from 'node:child_process';

// Runs the whole Monad stack on this machine and publishes the dashboard through a Cloudflare quick tunnel.
// The public URL lives as long as this process does. Set NO_TUNNEL=1 to run locally only.
const children: ChildProcess[] = [];
const start = (agent: string, port: number) => {
  const child = spawn('npx', ['tsx', 'src/monad/start.ts'], { stdio: 'inherit', env: { ...process.env, AGENT: agent, PORT: String(port) } });
  children.push(child);
};
const shutdown = () => {
  children.forEach((c) => c.kill());
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start('data', 4101);
start('analyst', 4102);
start('web', 4100);

if (!process.env.NO_TUNNEL) {
  const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', 'http://localhost:4100'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(tunnel);
  const watch = (chunk: Buffer) => {
    const url = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (url) console.log(`\n  ▶ live dashboard: ${url}\n  ▶ agents: ${url}/agents/analyst/  ${url}/agents/data/\n`);
  };
  tunnel.stdout.on('data', watch);
  tunnel.stderr.on('data', watch);
  tunnel.on('exit', (code) => console.error(`[tunnel] cloudflared exited (${code})`));
}
