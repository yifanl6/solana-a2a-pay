// Single entry point for hosted deploys. AGENT selects what this process runs:
// data | analyst | web, or `all` (default) to run the whole stack in one process, with only the dashboard on $PORT.
const agent = process.env.AGENT ?? 'all';
const entries: Record<string, string[]> = {
  data: ['./data-agent'],
  analyst: ['./analyst-agent'],
  web: ['./web'],
  all: ['./data-agent', './analyst-agent', './web'],
};
if (!entries[agent]) throw new Error(`unknown AGENT=${agent}; expected one of ${Object.keys(entries).join(', ')}`);
if (agent === 'all') {
  // Agents talk over localhost; only the dashboard (which also proxies /agents/*) is public.
  process.env.DATA_AGENT_PORT ??= '4101';
  process.env.ANALYST_PORT ??= '4102';
  process.env.DATA_AGENT_URL ??= `http://localhost:${process.env.DATA_AGENT_PORT}`;
  process.env.ANALYST_URL ??= `http://localhost:${process.env.ANALYST_PORT}`;
}
for (const entry of entries[agent]) await import(entry);
export {};
