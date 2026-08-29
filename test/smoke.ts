/**
 * Smoke test: runs the standalone server both ways it ships — JSON-RPC over
 * stdio (what registries and Docker introspection use) and Streamable HTTP —
 * and checks the protocol surface against the live feed on findsaunaplunge.com.
 *
 *   node test/smoke.ts      (Node 24+, no dependencies)
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serve = join(root, 'src', 'serve.ts');
const TOOLS = ['search_venues', 'get_venue', 'list_cities', 'get_city_stats', 'get_data_freshness'];
const TIMEOUT_MS = 30_000;

type Message = { id?: number; result?: any; error?: any };

function toolNames(list: Message): string[] {
  return list.result.tools.map((t: { name: string }) => t.name);
}

function toolPayload(call: Message): any {
  assert.equal(call.result.isError, false, 'tool call is not an error envelope');
  return JSON.parse(call.result.content[0].text);
}

async function stdio(): Promise<void> {
  const child: ChildProcess = spawn(process.execPath, [serve, '--stdio'], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const pending = new Map<number, (m: Message) => void>();
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (!line.trim()) return;
      const message: Message = JSON.parse(line);
      if (message.id !== undefined) pending.get(message.id)?.(message);
    });
    let nextId = 1;
    const send = (method: string, params?: unknown): Promise<Message> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, resolve);
        setTimeout(() => reject(new Error(`stdio: no response to ${method} within ${TIMEOUT_MS}ms`)), TIMEOUT_MS).unref();
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'findsaunaplunge');
    assert.ok(init.result.instructions, 'server ships instructions');
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await send('tools/list');
    assert.deepEqual(toolNames(list), TOOLS);
    for (const tool of list.result.tools) {
      assert.ok(tool.description && tool.inputSchema, `${tool.name} has a description and an inputSchema`);
    }

    const freshness = toolPayload(await send('tools/call', { name: 'get_data_freshness', arguments: {} }));
    assert.ok(freshness.venueCount > 0, 'feed has venues');
    assert.ok(freshness.generatedAt && freshness.newestVerified, 'feed reports build and verification dates');

    const cities = toolPayload(await send('tools/call', { name: 'list_cities', arguments: {} }));
    const first = (cities.cities ?? cities)[0];
    assert.ok(first?.slug, 'list_cities returns slugs');

    const found = toolPayload(await send('tools/call', { name: 'search_venues', arguments: { citySlug: first.slug, limit: 1 } }));
    const venue = (found.venues ?? found)[0];
    assert.ok(venue?.id, 'search_venues returns a venue with an id');

    const full = toolPayload(await send('tools/call', { name: 'get_venue', arguments: { id: venue.id } }));
    assert.equal(full.id ?? full.venue?.id, venue.id, 'get_venue returns the record asked for');

    const rejected = toolPayload(await send('tools/call', { name: 'search_venues', arguments: { city: first.slug } }));
    assert.match(rejected.error, /Unknown argument/, 'misnamed filters are rejected, not ignored');

    console.log(`stdio ok: ${TOOLS.length} tools, ${freshness.venueCount} venues, newest verified ${freshness.newestVerified}`);
  } finally {
    child.stdin?.end();
    child.kill();
  }
}

async function http(): Promise<void> {
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const child: ChildProcess = spawn(process.execPath, [serve], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'inherit', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr!.on('data', (chunk) => { if (String(chunk).includes('findsaunaplunge mcp:')) resolve(); });
      child.on('exit', (code) => reject(new Error(`http: server exited with ${code} before listening`)));
      setTimeout(() => reject(new Error('http: server did not start')), TIMEOUT_MS).unref();
    });
    const base = `http://127.0.0.1:${port}/mcp`;

    const docs = await fetch(base, { headers: { accept: 'text/html' } });
    assert.equal(docs.status, 200, 'GET with an HTML accept header serves the documentation');

    const sse = await fetch(base, { headers: { accept: 'text/event-stream' } });
    assert.equal(sse.status, 405, 'server-initiated SSE is declined, as documented');

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(toolNames(await res.json()), TOOLS);
    console.log('http ok: docs on GET, tools/list on POST');
  } finally {
    child.kill();
  }
}

try {
  await stdio();
  await http();
} catch (error) {
  console.error(error);
  process.exit(1);
}
