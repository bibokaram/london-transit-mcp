// Bench harness: stands in for an MCP client connection, one isolated server per session, and logs every call.
import { createServer } from 'node:http';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createMerged } from '../../src/app.js';
import { createApp as createBefore } from '/tmp/claude-0/split-tree/src/app.js';
import { connectOAuth } from '../../test/helpers.js';

const SECRET = 'bench-only-secret';
const LOG = '/tmp/claude-0/bench2/calls.jsonl';
const variants: Record<string, 'before' | 'merged'> = JSON.parse(readFileSync('/tmp/claude-0/bench2/sessions.json', 'utf8'));

// TfL answers are shared between sessions for ten minutes, so parallel runs do not trip its keyless rate limit.
const cache = new Map<string, { at: number; status: number; body: string }>();
const sharedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const key = String(input);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return new Response(hit.body, { status: hit.status });
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, init);
    if (response.status === 429 && attempt < 3) { await new Promise((done) => setTimeout(done, 3000 * (attempt + 1))); continue; }
    const body = await response.text();
    if (response.ok || response.status === 300) cache.set(key, { at: Date.now(), status: response.status, body });
    return new Response(body, { status: response.status });
  }
}) as typeof fetch;

const sessions = new Map<string, Promise<{ rpc: (method: string, params: unknown) => Promise<any> }>>();
function session(id: string) {
  if (!variants[id]) throw new Error('unknown session');
  if (!sessions.has(id)) {
    sessions.set(id, (async () => {
      const app = (variants[id] === 'merged' ? createMerged : createBefore)({ fetch: sharedFetch, mcpSecret: SECRET, dataDir: mkdtempSync(join(tmpdir(), `bench-${id}-`)) });
      let token = (await connectOAuth(app, SECRET)).access_token;
      const send = (method: string, params: unknown) => app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      return { rpc: async (method, params) => {
        let response = await send(method, params);
        if (response.status === 401) { token = (await connectOAuth(app, SECRET)).access_token; response = await send(method, params); }
        return response.json();
      } };
    })());
  }
  return sessions.get(id)!;
}

createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const started = Date.now();
  let out: unknown;
  let entry: Record<string, unknown> = {};
  try {
    const { session: id, kind, tool, args, page } = JSON.parse(raw);
    const { rpc } = await session(id);
    if (kind === 'list') {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } });
      const tools = (await rpc('tools/list', {})).result.tools.map(({ name, description, inputSchema }: any) => ({ name, description, inputSchema }));
      const PAGE = 9000;
      const pages: unknown[][] = [[]];
      let size = 0;
      for (const tool of tools) {
        const length = JSON.stringify(tool).length;
        if (size + length > PAGE && pages.at(-1)!.length) { pages.push([]); size = 0; }
        pages.at(-1)!.push(tool); size += length;
      }
      const wanted = Math.min(Math.max(Number(page) || 1, 1), pages.length);
      out = { page: wanted, pages: pages.length, ...(wanted === 1 ? { server_instructions: init.result.instructions, tool_names: tools.map((tool: any) => tool.name) } : {}), tools: pages[wanted - 1], ...(wanted < pages.length ? { next: `Run list ${wanted + 1} for the next page of tool definitions. Read every page before starting.` } : {}) };
      entry = { session: id, kind, page: wanted };
    } else {
      const reply = await rpc('tools/call', { name: tool, arguments: args ?? {} });
      const result = reply.result ?? { isError: true, error: reply.error };
      out = result.isError ? { isError: true, content: result.content ?? result.error } : result.structuredContent;
      entry = { session: id, kind: 'call', tool, args, isError: Boolean(result.isError), status: result.structuredContent?.status ?? result.structuredContent?.error?.code ?? null };
    }
  } catch (error) {
    out = { isError: true, harness_error: String(error) };
    entry = { ...entry, harness_error: String(error) };
  }
  const text = JSON.stringify(out);
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry, variant: variants[(entry.session as string) ?? ''], ms: Date.now() - started, request_chars: raw.length, response_chars: text.length }) + '\n');
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(text);
}).listen(4600, '127.0.0.1', () => console.log('bench harness on 4599'));
