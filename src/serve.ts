/**
 * Standalone runner for the FindSaunaPlunge MCP server.
 *
 * In production `handleMcp` is mounted inside the site's Cloudflare Worker and
 * reads the venue feed through the Worker's ASSETS binding. This file lets the
 * same handler run anywhere — a container, a laptop, a registry's build
 * sandbox — by pointing that binding at the public feed on findsaunaplunge.com.
 *
 *   node src/serve.ts            # Streamable HTTP on $PORT (default 8080), POST /mcp
 *   node src/serve.ts --stdio    # JSON-RPC over stdio, one message per line
 *
 * Node 24+ (native TypeScript). No dependencies.
 */
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

import { handleMcp, type McpEnv } from './mcp.ts';

const ORIGIN = process.env.FINDSAUNAPLUNGE_ORIGIN ?? 'https://findsaunaplunge.com';

/** The ASSETS binding, satisfied by the public site: same path, public host. */
const env: McpEnv = {
  ASSETS: {
    fetch: (input: Request | string) => {
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      return fetch(`${ORIGIN}${path}`, { headers: { 'user-agent': 'findsaunaplunge-mcp-standalone' } });
    },
  },
};

async function stdio(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const body = line.trim();
    if (!body) continue;
    const response = await handleMcp(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
      }),
      env,
    );
    const text = await response.text();
    if (text.trim()) process.stdout.write(text.trim() + '\n');
  }
}

function http(): void {
  const port = Number(process.env.PORT ?? 8080);
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = `${ORIGIN}${req.url ?? '/mcp'}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const response = await handleMcp(
      new Request(url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }),
      env,
    );
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  }).listen(port, () => console.error(`findsaunaplunge mcp: http://localhost:${port}/mcp`));
}

if (process.argv.includes('--stdio')) await stdio();
else http();
