// Single entry point for hosted deploys: AGENT selects which service this process runs.
const entries: Record<string, string> = { data: './data-agent', analyst: './analyst-agent', web: './web' };
const agent = process.env.AGENT ?? 'web';
if (!entries[agent]) throw new Error(`unknown AGENT=${agent}; expected one of ${Object.keys(entries).join(', ')}`);
await import(entries[agent]);
export {};
