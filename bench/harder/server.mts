// Harder bench: 2 tool shapes x operating instructions on/off x 5 scenarios, among 93 working rival tools.
import { createServer } from 'node:http';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createMerged } from '../../src/app.js';
import { createApp as createBefore } from '/tmp/claude-0/split-tree/src/app.js';
import { connectOAuth } from '../../test/helpers.js';

const DIR = '/tmp/claude-0/bench5/';
const SECRET = 'bench-only-secret';
const LOG = DIR + 'calls.jsonl';
type Run = { shape: 'before' | 'merged'; manual: boolean; scenario: string };
const runs: Record<string, Run> = JSON.parse(readFileSync(DIR + 'sessions.json', 'utf8'));
const { seed, scenarios } = JSON.parse(readFileSync(DIR + 'scenarios.json', 'utf8'));
const distractors: { servers: Record<string, string>; tools: { server: string; name: string; description: string; inputSchema: unknown }[] } = JSON.parse(readFileSync(DIR + 'distractors.json', 'utf8'));
const distractorNames = new Set(distractors.tools.map((tool) => tool.name));

// Rival connectors answer plausibly. They know nothing of what the travel server holds, and some of it is stale.
const TOMORROW = '2026-11-15';
function rival(tool: string, args: any): unknown {
  switch (tool) {
    case 'gmail__search_threads': return { threads: [
      { id: 't1', from: 'Alessia (Folklands)', subject: 'Viewing tomorrow 10:00, Bynes Road', snippet: 'Just confirming 10am at Peninsula Square, Greenwich SE10 0DX. Call me if you are running late.', date: '2026-11-14' },
      { id: 't2', from: 'Halifax', subject: 'Your decision in principle', snippet: 'Your decision in principle is valid for 90 days.', date: '2026-11-13' } ] };
    case 'gmail__list_unread': case 'slack__list_unread': return { items: [] };
    case 'calendar__list_events': return { events: [
      { id: 'e1', title: 'Flat viewing', start: `${TOMORROW}T10:00:00+00:00`, end: `${TOMORROW}T10:30:00+00:00`, location: 'Peninsula Square, Greenwich SE10 0DX' },
      { id: 'e2', title: 'Dinner with Sam', start: `${TOMORROW}T19:30:00+00:00`, end: `${TOMORROW}T21:30:00+00:00`, location: 'Dalston' } ] };
    case 'calendar__create_event': return { id: 'e-new', status: 'created', ...args };
    case 'reminders__create_reminder': return { id: 'r-new', status: 'created', ...args };
    case 'memory__recall': return { facts: [
      { id: 'f1', category: 'profile', fact: 'Lives at SE1 7PB (Camberwell).', saved: '2026-03-02' },
      { id: 'f2', category: 'work', fact: 'Works near Liverpool Street station.', saved: '2026-03-02' },
      { id: 'f3', category: 'preference', fact: 'Prefers not to take buses.', saved: '2026-05-19' } ] };
    case 'memory__remember_fact': case 'memory__update_fact': return { id: 'f-new', status: 'saved', ...args };
    case 'notes__search_notes': return { notes: [] };
    case 'notes__save_note': return { id: 'n-new', status: 'saved' };
    case 'maps__save_place': return { status: 'saved', ...args };
    case 'rides__list_saved_places': return { places: [{ label: 'Home', address: 'SE1 7PB' }] };
    case 'maps__get_directions': return { mode: args?.mode ?? 'transit', duration_minutes: 34, summary: 'Bus 76 towards Waterloo, then walk', steps: ['Walk 4 min to the bus stop', 'Bus 76, 22 min, 9 stops', 'Walk 8 min'], note: 'Schedule data may be incomplete for this area.' };
    case 'maps__get_travel_time': return { mode: args?.mode ?? 'transit', duration_minutes: 34, distance_km: 5.1 };
    case 'maps__search_places': case 'maps__nearby_transit': return { results: [] };
    case 'city_alerts__get_transit_alerts': return { city: args?.city ?? 'London', alerts: [], note: 'No alerts reported in the last 24 hours.' };
    case 'rail_tickets__search_fares': return { fares: [{ fare_id: 'x1', depart: '09:02', arrive: '09:58', changes: 1, price_gbp: 6.4 }, { fare_id: 'x2', depart: '09:32', arrive: '10:28', changes: 1, price_gbp: 6.4 }] };
    case 'weather__get_forecast': case 'weather__get_current': return { summary: 'Dry, 9C, light wind.' };
    default: return { status: 'ok', result: null };
  }
}

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
/** In the outage scenario TfL's line status endpoint fails; everything else works. */
const statusDown = (async (input: RequestInfo | URL, init?: RequestInit) =>
  /\/Line\/.*\/Status/.test(new URL(String(input)).pathname) ? new Response('{"message":"unavailable"}', { status: 503 }) : sharedFetch(input, init)) as typeof fetch;

const scrub = (text: string) => text.replace(/ \(listed by get_operating_instructions\)/g, '').replace(/ rather than re-reading the operating instructions/g, '').replace(/ \(see get_operating_instructions\)/g, '');
const sessions = new Map<string, Promise<{ rpc: (method: string, params: unknown) => Promise<any> }>>();
function session(id: string) {
  const run = runs[id];
  if (!run) throw new Error('unknown session');
  if (!sessions.has(id)) {
    sessions.set(id, (async () => {
      const app = (run.shape === 'merged' ? createMerged : createBefore)({ fetch: scenarios[run.scenario].status_down ? statusDown : sharedFetch, mcpSecret: SECRET, dataDir: mkdtempSync(join(tmpdir(), `bench-${id}-`)) });
      let token = (await connectOAuth(app, SECRET)).access_token;
      const send = (method: string, params: unknown) => app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const rpc = async (method: string, params: unknown) => {
        let response = await send(method, params);
        if (response.status === 401) { token = (await connectOAuth(app, SECRET)).access_token; response = await send(method, params); }
        return response.json();
      };
      // A returning user: places and a preference were saved in earlier conversations.
      for (const [label, place] of Object.entries(seed.places)) await rpc('tools/call', { name: 'remember', arguments: { action: 'save_place', label, place } });
      await rpc('tools/call', { name: 'remember', arguments: { action: 'set_preferences', avoid_modes: seed.avoid_modes } });
      return { rpc };
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
    const { session: id, kind, tool, args, page, n, text } = JSON.parse(raw);
    const run = runs[id];
    const { rpc } = await session(id);
    if (kind === 'reply') {
      out = { recorded: true };
      entry = { session: id, kind, n, text: String(text).slice(0, 2000) };
    } else if (kind === 'state') {
      out = (await rpc('tools/call', { name: 'remember', arguments: { action: 'show' } })).result.structuredContent.remembered;
      entry = { session: id, kind };
    } else if (kind === 'list') {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } });
      let own = (await rpc('tools/list', {})).result.tools.map(({ name, description, inputSchema }: any) => ({ server: 'tube', name: `tube__${name}`, description, inputSchema }));
      if (!run.manual) own = JSON.parse(scrub(JSON.stringify(own.filter((item: any) => item.name !== 'tube__get_operating_instructions'))));
      const order = Object.keys(distractors.servers);
      const tools = [...order.slice(0, 4), 'tube', ...order.slice(4)].flatMap((server) => server === 'tube' ? own : distractors.tools.filter((item) => item.server === server));
      const PAGE = 9000;
      const pages: unknown[][] = [[]];
      let size = 0;
      for (const item of tools) {
        const length = JSON.stringify(item).length;
        if (size + length > PAGE && pages.at(-1)!.length) { pages.push([]); size = 0; }
        pages.at(-1)!.push(item); size += length;
      }
      const wanted = Math.min(Math.max(Number(page) || 1, 1), pages.length);
      const tubeInstructions = run.manual ? init.result.instructions : 'Journey planning, timetables, live departures and line status for London public transport.';
      out = { page: wanted, pages: pages.length, ...(wanted === 1 ? { note: 'Tools are named server__tool. Each server may give instructions for its own tools.', server_instructions: { ...distractors.servers, tube: tubeInstructions }, tool_names: tools.map((item: any) => item.name) } : {}), tools: pages[wanted - 1], ...(wanted < pages.length ? { next: `Run list ${wanted + 1} for the next page of tool definitions. Read every page before starting.` } : {}) };
      entry = { session: id, kind, page: wanted };
    } else {
      const name = String(tool);
      if (distractorNames.has(name)) {
        out = rival(name, args);
        entry = { session: id, kind: 'call', tool, args, isError: false, status: 'rival', rival: true };
      } else if (!run.manual && name.replace(/^tube__/, '') === 'get_operating_instructions') {
        out = { isError: true, error: 'Unknown tool.' };
        entry = { session: id, kind: 'call', tool, args, isError: true, status: 'hidden_tool' };
      } else {
        const reply = await rpc('tools/call', { name: name.replace(/^tube__/, ''), arguments: args ?? {} });
        const result = reply.result ?? { isError: true, error: reply.error };
        out = result.isError ? { isError: true, content: result.content ?? result.error } : result.structuredContent;
        entry = { session: id, kind: 'call', tool, args, isError: Boolean(result.isError), status: result.structuredContent?.status ?? result.structuredContent?.error?.code ?? null };
      }
    }
  } catch (error) {
    out = { isError: true, harness_error: String(error) };
    entry = { ...entry, harness_error: String(error) };
  }
  const body = JSON.stringify(out);
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry, ms: Date.now() - started, request_chars: raw.length, response_chars: body.length, ...(entry.kind === 'call' ? { result: body.slice(0, 3500) } : {}) }) + '\n');
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(body);
}).listen(4603, '127.0.0.1', () => console.log('bench5 on 4603'));
