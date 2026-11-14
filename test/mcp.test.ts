import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { journeySchema, londonTime, mapConcurrent, withLondonOffset } from '../src/journeys.js';
import { connectOAuth, fakeTfl, lineWith, NETWORK_STATUS, networkLines, prediction } from './helpers.js';

const SECRET = 'test-only-not-a-production-credential';
const PATH = '/mcp';
const AT = '2026-11-10T08:00:00Z';
const FROM = '940GZZLUWYP';
const TO = '940GZZLUBNK';
const JOURNEY_PATH = `/Journey/JourneyResults/${FROM}/to/${TO}`;

function route(overrides: Record<string, unknown> = {}) {
  return {
    duration: 35, startDateTime: '2026-11-10T08:00:00', arrivalDateTime: '2026-11-10T08:35:00',
    legs: [
      { duration: 5, departureTime: '2026-11-10T08:00:00', arrivalTime: '2026-11-10T08:05:00',
        mode: { id: 'walking' }, departurePoint: { commonName: 'Home' }, arrivalPoint: { commonName: 'Wembley Park' } },
      { duration: 30, departureTime: '2026-11-10T08:05:00', arrivalTime: '2026-11-10T08:35:00',
        mode: { id: 'tube' }, departurePoint: { commonName: 'Wembley Park' }, arrivalPoint: { commonName: 'Bank' },
        instruction: { summary: 'Metropolitan line' }, routeOptions: [{ name: 'Metropolitan' }],
        disruptions: [{ description: '<p>Minor delays</p>' }], path: { lineString: 'huge geometry must not escape' } },
    ],
    ...overrides,
  };
}

function setup(routes: Parameters<typeof fakeTfl>[0] = {}, secret: string | undefined = SECRET) {
  const tfl = fakeTfl(routes);
  let time = Date.parse(AT);
  const app = createApp({ fetch: tfl.fetch, appKey: 'upstream-key-must-stay-private', mcpSecret: secret, now: () => time });
  let token: string | undefined;
  const bearer = async () => `Bearer ${token ??= (await connectOAuth(app, SECRET)).access_token}`;
  const rpc = async (method: string, params: unknown = {}, path = PATH, headers: Record<string, string> = {}) => app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: await bearer(), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const call = async (name: string, args: unknown = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    expect(response.status).toBe(200);
    return (await response.json() as any).result;
  };
  return { app, tfl, rpc, call, bearer, advance: (milliseconds: number) => { time += milliseconds; } };
}

describe('MCP boundary and transport', () => {
  it('is disabled without configuration and does not call TfL', async () => {
    const tfl = fakeTfl({});
    const app = createApp({ fetch: tfl.fetch });
    expect((await app.request(PATH, { method: 'POST' })).status).toBe(404);
    expect(tfl.calls).toHaveLength(0);
  });

  it('hides tools behind OAuth, rejects cross-origin requests and never caches', async () => {
    const { rpc, tfl } = setup();
    for (const authorization of ['', 'Bearer wrong', `Bearer ${SECRET}`]) {
      const response = await rpc('tools/list', {}, PATH, { Authorization: authorization });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    for (const path of ['/mcp/wrong', '/mcp/' + SECRET]) expect((await rpc('tools/list', {}, path)).status).toBe(404);
    expect((await rpc('tools/list', {}, PATH, { Origin: 'https://attacker.example' })).status).toBe(403);
    expect(tfl.calls).toHaveLength(0);
  });

  it.each(['GET', 'DELETE', 'PUT', 'OPTIONS'])('rejects %s without starting a standalone event stream', async (method) => {
    const { app, bearer } = setup();
    const response = await app.request(PATH, { method, headers: { Authorization: await bearer() } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('rejects oversized and malformed requests', async () => {
    const { app, bearer } = setup();
    const Authorization = await bearer();
    expect((await app.request(PATH, { method: 'POST', headers: { Authorization }, body: 'x'.repeat(65 * 1024) })).status).toBe(413);
    const malformed = await app.request(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization }, body: '{' });
    expect(malformed.status).toBe(400);
  });

  it('supports the official client initialize, tools/list, tools/call and notification lifecycle', async () => {
    const { app, bearer } = setup({ [NETWORK_STATUS]: { body: networkLines() } });
    const client = new Client({ name: 'tube-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost${PATH}`), {
      requestInit: { headers: { Authorization: await bearer() } },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => app.request(new Request(input, init))) as typeof fetch,
    });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toContain('you do not need it first');
      const tools = (await client.listTools()).tools;
      // train_service is offered only when the server has a Realtime Trains token.
      expect(tools.map((tool) => tool.name).sort()).toEqual(['change_journey', 'follow_journey', 'get_context', 'line_status', 'live_departures', 'plan_journey', 'plan_journeys_batch', 'remember', 'show_journey', 'timetable']);
      expect(tools.filter((tool) => !/^remember$|^follow_|^change_/.test(tool.name)).every((tool) => tool.annotations?.readOnlyHint && tool.annotations.openWorldHint)).toBe(true);
      const response = await client.callTool({ name: 'line_status', arguments: { lines: ['victoria'] } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ source: 'TfL Unified API', timezone: 'Europe/London', lines: [{ id: 'victoria', level: 'good' }] });
    } finally {
      await client.close();
    }
  });
});

describe('journey tools', () => {
  it('summarises routes and sends TfL the exact requested London time', async () => {
    const { call, tfl } = setup({ [JOURNEY_PATH]: { body: { journeys: [route()] } } });
    const response = await call('plan_journey', { from: FROM, to: TO, at: AT, time_is: 'arriving' });
    expect(response.structuredContent).toMatchObject({ status: 'ok', query: { at: AT, time_is: 'arriving' }, routes: [{ duration_minutes: 35, walking_minutes: 5, changes: 0, disrupted: true, disruptions: ['Minor delays'] }] });
    expect(JSON.stringify(response)).not.toContain('geometry');
    expect(JSON.stringify(response)).not.toContain('upstream-key');
    const params = tfl.calls[0]!.searchParams;
    expect(params.get('date')).toBe('20261110');
    expect(params.get('time')).toBe('0800');
    expect(params.get('timeIs')).toBe('arriving');
    expect(params.get('nationalSearch')).toBe('true');
  });

  it('uses UK daylight saving rather than the machine timezone', () => {
    expect(londonTime('2026-07-01T23:30:00Z')).toEqual({ date: '20260702', time: '0030' });
    expect(londonTime('2026-11-10T08:00:00+02:00')).toEqual({ date: '20261110', time: '0600' });
  });

  it.each([
    { from: FROM, to: TO, at: 'tomorrow at 8' },
    { from: FROM, to: TO, at: '2026-11-10T08:00:00' },
    { from: FROM, to: TO, time_is: 'arriving' },
    { from: FROM, to: TO, max_routes: 4 },
    { from: '  ', to: TO },
    { from: '..', to: TO },
    { from: FROM, to: TO, invented: true },
  ])('rejects invalid inputs without calling TfL: %j', async (args) => {
    const { call, tfl } = setup();
    expect((await call('plan_journey', args)).isError).toBe(true);
    expect(tfl.calls).toHaveLength(0);
    expect(journeySchema.safeParse(args).success).toBe(false);
  });

  it('returns HTTP 300 ambiguities as actionable candidates, without selecting one', async () => {
    const options = Array.from({ length: 10 }, (_, index) => ({ parameterValue: `10000${index}`, place: { commonName: `Bank ${index}`, modes: ['tube'] } }));
    const { call } = setup({ [JOURNEY_PATH]: { status: 300, body: { fromLocationDisambiguation: { disambiguationOptions: options } } } });
    const data = (await call('plan_journey', { from: FROM, to: TO })).structuredContent;
    expect(data.status).toBe('needs_disambiguation');
    expect(data.from.options).toHaveLength(8);
    expect(data.from.truncated).toBe(true);
    expect(data).not.toHaveProperty('to');
    expect(data.next_action).toContain('do not guess');
  });

  it('reports how every endpoint was sent to TfL, including postcodes and IDs passed through', async () => {
    const { call } = setup({ [`/Journey/JourneyResults/SW1A%201AA/to/${TO}`]: { body: { journeys: [route()] } } });
    const data = (await call('plan_journey', { from: 'SW1A 1AA', to: TO })).structuredContent;
    expect(data.resolved).toEqual({ from: { input: 'SW1A 1AA', used: 'SW1A 1AA' }, to: { input: TO, used: TO } });
  });

  it('gives route and leg times the London offset, lists no line for walking legs and tidies place names', async () => {
    const walk = { duration: 5, departureTime: '2026-07-01T08:00:00', arrivalTime: '2026-07-01T08:05:00', mode: { id: 'walking' },
      departurePoint: { commonName: 'Home' }, arrivalPoint: { commonName: 'Wembley  Park\n Station' }, routeOptions: [{ name: '' }] };
    const summer = route({ startDateTime: '2026-07-01T08:00:00', arrivalDateTime: '2026-07-01T08:35:00', legs: [walk] });
    const { call } = setup({ [JOURNEY_PATH]: { body: { journeys: [summer, route()] } } });
    const [bst, gmt] = (await call('plan_journey', { from: FROM, to: TO })).structuredContent.routes;
    expect(bst).toMatchObject({ departure: '2026-07-01T08:00:00+01:00', arrival: '2026-07-01T08:35:00+01:00' });
    expect(bst.legs[0]).toMatchObject({ departure: '2026-07-01T08:00:00+01:00', to: 'Wembley Park Station', lines: [] });
    expect(gmt).toMatchObject({ departure: '2026-11-10T08:00:00+00:00', arrival: '2026-11-10T08:35:00+00:00' });
    expect(gmt.legs[1].lines).toEqual(['Metropolitan']);
  });

  it('adds the offset in force at each London wall-clock time, across the clock changes', () => {
    expect(withLondonOffset('2026-03-29T00:30:00')).toBe('2026-03-29T00:30:00+00:00');
    expect(withLondonOffset('2026-03-29T03:00:00')).toBe('2026-03-29T03:00:00+01:00');
    expect(withLondonOffset('2026-10-25T00:30:00')).toBe('2026-10-25T00:30:00+01:00');
    expect(withLondonOffset('2026-10-25T02:30:00')).toBe('2026-10-25T02:30:00+00:00');
    expect(withLondonOffset('2026-11-12T14:00:00Z')).toBe('2026-11-12T14:00:00Z');
  });

  it('caps route count and distinguishes no journeys from normal service', async () => {
    const { call } = setup({ [JOURNEY_PATH]: { body: { journeys: [route(), route(), route(), route()] } } });
    const data = (await call('plan_journey', { from: FROM, to: TO })).structuredContent;
    expect(data.routes).toHaveLength(3);
    expect(data.routes_truncated).toBe(true);
    const empty = setup({ [JOURNEY_PATH]: { body: { journeys: [] } } });
    expect((await empty.call('plan_journey', { from: FROM, to: TO })).structuredContent.status).toBe('no_journeys');
  });

  it('bounds legs and disruptions and retains walking totals from omitted legs', async () => {
    const walking = route().legs[0]!;
    const { call } = setup({ [JOURNEY_PATH]: { body: { journeys: [route({ legs: Array.from({ length: 20 }, (_, index) => ({ ...walking, disruptions: [{ description: `issue ${index} ${'x'.repeat(2000)}` }] })) })] } } });
    const data = (await call('plan_journey', { from: FROM, to: TO })).structuredContent.routes[0];
    expect(data.legs).toHaveLength(16);
    expect(data.walking_minutes).toBe(100);
    expect(data.legs_truncated).toBe(true);
    expect(data.disruptions).toHaveLength(5);
    expect(data.disruptions_truncated).toBe(true);
    expect(data.disruptions[0].length).toBe(600);
  });

  it.each([{ unexpected: 'payload' }, { journeys: [{ duration: 'bad' }] }])('handles malformed upstream data safely', async (body) => {
    const { call } = setup({ [JOURNEY_PATH]: { body } });
    const response = await call('plan_journey', { from: FROM, to: TO });
    expect(response.isError).toBe(true);
    expect(response.structuredContent.error.code).toBe('tfl_unavailable');
  });

  it('caches identical plans for 30 seconds and then refreshes', async () => {
    const { call, tfl, advance } = setup({ [JOURNEY_PATH]: { body: { journeys: [route()] } } });
    const args = { from: FROM, to: TO, at: AT };
    await call('plan_journey', args);
    await call('plan_journey', args);
    expect(tfl.calls).toHaveLength(1);
    advance(30_001);
    await call('plan_journey', args);
    expect(tfl.calls).toHaveLength(2);
  });

  it('routes date validation failures to the timestamp without exposing upstream details', async () => {
    const { call } = setup({ [JOURNEY_PATH]: { status: 400, body: {
      message: 'Date cannot be more than 7 days in the past. TOPSECRET', relativeUri: '/private?app_key=TOPSECRET',
    } } });
    const response = await call('plan_journey', { from: FROM, to: TO, at: '2020-01-01T08:00:00Z' });
    expect(response).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_travel_time', retryable: false } } });
    expect(JSON.stringify(response)).not.toContain('TOPSECRET');
    expect(response.structuredContent.error.message).toContain('Correct at');
  });

  it('still reports a TfL outage as unavailable, not as a date out of range', async () => {
    for (const failure of [{ status: 500, body: { exceptionType: 'NullReferenceException' } }, { status: 503, body: {} }]) {
      const { call } = setup({ [JOURNEY_PATH]: failure });
      const response = await call('plan_journey', { from: FROM, to: TO, at: '2027-03-01T09:00:00Z' });
      expect(response.structuredContent.error).toMatchObject({ code: 'tfl_unavailable', retryable: true });
    }
  });

  it('words a missing stop for the tool that was called', async () => {
    const { call } = setup();
    const live = (await call('live_departures', { stop: '490NOTASTOP1' })).structuredContent.error;
    expect(live).toMatchObject({ code: 'place_not_found', retryable: false });
    expect(live.message).toContain('by name');
    expect(live.message).not.toMatch(/use a postcode/);
    const plan = (await call('plan_journey', { from: FROM, to: TO })).structuredContent.error;
    expect(plan.message).toContain('postcode or coordinates');
  });

  it('does not misclassify generic TfL validation errors as missing places', async () => {
    const { call } = setup({ [JOURNEY_PATH]: { status: 400, body: { message: 'Invalid parameter' } } });
    expect((await call('plan_journey', { from: FROM, to: TO })).structuredContent.error.code).toBe('invalid_journey_request');
  });

  it('encodes places so crafted names cannot escape the TfL journey path', async () => {
    const { call, tfl } = setup();
    await call('plan_journey', { from: '../../Line/victoria/Status', to: 'SW1A 1AA?app_key=evil' });
    expect(tfl.calls.every((url) => /^\/(Journey\/JourneyResults|StopPoint\/Search)\//.test(url.pathname))).toBe(true);
    const journey = tfl.calls.find((url) => url.pathname.startsWith('/Journey/'))!;
    expect(journey.searchParams.get('app_key')).toBe('upstream-key-must-stay-private');
    expect(tfl.calls.some((url) => url.searchParams.has('evil'))).toBe(false);
  });

  it('preserves batch ordering, one shared default time and partial failures', async () => {
    const { call, tfl } = setup({
      [JOURNEY_PATH]: { body: { journeys: [route(), route()] } },
      [`/Journey/JourneyResults/BAD/to/${TO}`]: { status: 429 },
    });
    const data = (await call('plan_journeys_batch', { origins: [FROM, 'BAD', FROM], to: TO })).structuredContent;
    expect(Date.parse(data.query.at)).toBe(Date.parse(AT));
    expect(data.journeys.map((item: any) => item.origin)).toEqual([FROM, 'BAD', FROM]);
    expect(data.journeys[0].routes).toHaveLength(1);
    expect(data.journeys[1]).toMatchObject({ status: 'error', error: { code: 'tfl_rate_limited' } });
    expect(tfl.calls.filter((url) => url.pathname === JOURNEY_PATH)).toHaveLength(1);
    expect(tfl.calls.filter((url) => url.pathname.startsWith('/Journey/')).every((url) => url.searchParams.get('time') === '0800')).toBe(true);
  });

  it('keeps each origin beside its candidates when a batch origin is ambiguous', async () => {
    const options = [{ parameterValue: '51.5,-0.1', place: { commonName: 'Croydon Road', modes: [] } }];
    const { call } = setup({
      [JOURNEY_PATH]: { body: { journeys: [route()] } },
      [`/Journey/JourneyResults/Croydon/to/${TO}`]: { status: 300, body: { fromLocationDisambiguation: { disambiguationOptions: options } } },
      '/StopPoint/Search/croydon': { body: { matches: [{ id: '910GECROYDN', name: 'East Croydon Rail Station', modes: ['national-rail'], icsId: '1001089' }] } },
    });
    const data = (await call('plan_journeys_batch', { origins: ['Croydon', FROM], to: TO })).structuredContent;
    expect(data.journeys[0]).toMatchObject({ origin: 'Croydon', status: 'needs_disambiguation', resolved: { from: { input: 'Croydon', used: 'Croydon' } } });
    expect(data.journeys[0].from.options).toEqual([
      { value: '1001089', name: 'East Croydon', modes: ['national-rail'] },
      { value: '51.5,-0.1', name: 'Croydon Road', modes: [] },
    ]);
    expect(data.journeys[1]).toMatchObject({ origin: FROM, status: 'ok' });
  });

  it('rejects unbounded batches and missing arrive-by times before any network call', async () => {
    const { call, tfl } = setup();
    for (const args of [{ origins: Array(26).fill(FROM), to: TO }, { origins: [], to: TO }, { origins: [FROM], to: TO, time_is: 'arriving' }]) {
      expect((await call('plan_journeys_batch', args)).isError).toBe(true);
    }
    expect(tfl.calls).toHaveLength(0);
  });

  it('never schedules more than three concurrent origin plans', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapConcurrent([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return item * 2;
    });
    expect(peak).toBe(3);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });
});

describe('existing data through MCP', () => {
  it('reads a board from a station name, and says which station it took the name to mean', async () => {
    const { call, tfl } = setup({
      '/StopPoint/Search/wembley%20park': { body: { matches: [{ id: FROM, name: 'Wembley Park Underground Station', modes: ['tube'] }] } },
      [`/StopPoint/${FROM}`]: { body: { id: FROM, commonName: 'Wembley Park Underground Station', modes: ['tube'], lines: [{ id: 'victoria', name: 'Victoria' }], lineModeGroups: [{ modeName: 'tube', lineIdentifier: ['victoria'] }] } },
      [`/StopPoint/${FROM}/Arrivals`]: { body: [prediction({ timeToStation: 90, expectedArrival: '2026-11-10T08:01:30Z' })] },
    });
    const data = (await call('live_departures', { stop: 'Wembley Park' })).structuredContent;
    expect(data.stop).toEqual({ input: 'Wembley Park', id: FROM, name: 'Wembley Park', matched_by: 'name' });
    expect(data.arrivals).toHaveLength(1);
    // An ID is used as given, with no search.
    const before = tfl.calls.length;
    const byId = (await call('live_departures', { stop: FROM })).structuredContent;
    expect(byId).not.toHaveProperty('stop');
    expect(tfl.calls.slice(before).some((url) => url.pathname.includes('/Search/'))).toBe(false);
  });

  it('hands back candidates when a name matches several stops, and never picks one', async () => {
    const { call, tfl } = setup({ '/StopPoint/Search/camberwell': { body: { matches: [{ id: '490G000100', name: 'Camberwell Green', modes: ['bus'] }, { id: '490G000101', name: 'Camberwell Church Street', modes: ['bus'] }] } } });
    const data = (await call('live_departures', { stop: 'Camberwell' })).structuredContent;
    expect(data).toMatchObject({ status: 'needs_disambiguation', arrivals: [], stops: [{ id: '490G000100', name: 'Camberwell Green' }, { id: '490G000101' }] });
    expect(data.next_action).toContain('id of the one meant');
    // Only searches were made: no board was read for a guess.
    expect(tfl.calls.every((url) => url.pathname.includes('/Search/'))).toBe(true);
  });

  it('says so when nothing matches a stop name', async () => {
    const { call } = setup({ '/StopPoint/Search/nowhere%20at%20all': { body: { matches: [] } } });
    expect((await call('live_departures', { stop: 'nowhere at all' })).structuredContent).toMatchObject({ status: 'stop_not_found', arrivals: [] });
  });

  it('filters departures and shares the existing app cache', async () => {
    const { call, app, tfl } = setup({
      [`/StopPoint/${FROM}`]: { body: { id: FROM, lines: [{ id: 'victoria' }] } },
      [`/StopPoint/${FROM}/Arrivals`]: { body: [
        prediction({ timeToStation: 90, expectedArrival: '2026-11-10T08:01:30Z' }), prediction({ timeToStation: 180, expectedArrival: '2026-11-10T08:03:00Z' }),
        prediction({ platformName: 'Southbound - Platform 1', expectedArrival: '2026-11-10T08:01:00Z' }),
      ] },
    });
    await app.request(`/api/arrivals?stop=${FROM}`);
    const count = tfl.calls.length;
    const data = (await call('live_departures', { stop: FROM, direction: 'Northbound', limit: 1 })).structuredContent;
    expect(data.arrivals).toHaveLength(1);
    expect(data.arrivals[0].bound).toBe('Northbound');
    expect(data.truncated).toBe(true);
    expect(tfl.calls).toHaveLength(count);
  });

  it('defaults line_status to London rail from one cached network request', async () => {
    const { call, tfl } = setup({ [NETWORK_STATUS]: { body: networkLines() } });
    const data = (await call('line_status')).structuredContent;
    expect(data.lines.map((line: any) => line.id)).toEqual(['jubilee', 'victoria', 'elizabeth', 'mildmay', 'dlr']);
    expect(data.lines[0]).toMatchObject({ id: 'jubilee', mode: 'tube', level: 'good' });
    await call('line_status', { modes: ['national-rail'] });
    expect(tfl.calls).toHaveLength(1);
  });

  it('reports the cable car by line ID or mode, but leaves it out of the London rail default', async () => {
    const cableCar = { ...lineWith('london-cable-car', 'London Cable Car', { statusSeverity: 10, statusSeverityDescription: 'Good Service' }), modeName: 'cable-car' };
    const { call } = setup({ [NETWORK_STATUS]: { body: [...networkLines(), cableCar] } });
    expect((await call('line_status', { lines: ['london-cable-car'] })).structuredContent).toMatchObject({ lines: [{ id: 'london-cable-car', mode: 'cable-car', level: 'good' }] });
    expect((await call('line_status', { modes: ['cable-car'] })).structuredContent.lines.map((line: any) => line.id)).toEqual(['london-cable-car']);
    expect((await call('line_status')).structuredContent.lines.map((line: any) => line.id)).not.toContain('london-cable-car');
  });

  it('reports National Rail operators by line ID or mode, and lists unknown IDs back', async () => {
    const { call } = setup({ [NETWORK_STATUS]: { body: networkLines() } });
    const swr = (await call('line_status', { lines: ['south-western-railway', 'jubilee'] })).structuredContent;
    expect(swr.lines).toEqual([
      { id: 'jubilee', name: 'Jubilee', status: 'Good Service', level: 'good', reason: null, mode: 'tube' },
      { id: 'south-western-railway', name: 'South Western Railway', status: 'Special Service', level: 'minor', reason: 'Fewer trains between Surbiton and Waterloo.', mode: 'national-rail' },
    ]);
    const union = (await call('line_status', { lines: ['victoria'], modes: ['national-rail'] })).structuredContent;
    expect(union.lines.map((line: any) => line.id)).toEqual(['victoria', 'south-western-railway']);
    const unknown = (await call('line_status', { lines: ['southwestern', 'victoria'] })).structuredContent;
    expect(unknown.lines.map((line: any) => line.id)).toEqual(['victoria']);
    expect(unknown.unknown_lines).toEqual(['southwestern']);
    expect(unknown.next_action).toContain('south-western-railway');
  });

  it('merges Tube predictions with Elizabeth line departures at an interchange', async () => {
    const elizabeth = (id: string, modes: string[]) => ({ id, modes, lines: [{ id: 'elizabeth', name: 'Elizabeth line' }], lineModeGroups: [{ modeName: 'elizabeth-line', lineIdentifier: ['elizabeth'] }] });
    const board = [
      { platformName: 'Platform A', destinationNaptanId: '910GABWDXR', destinationName: 'Abbey Wood', scheduledTimeOfDeparture: '2026-11-10T08:03:00Z', estimatedTimeOfDeparture: '2026-11-10T08:04:00Z', departureStatus: 'Delayed' },
      { platformName: 'Platform B', destinationNaptanId: '910GPADTLL', destinationName: 'Paddington', scheduledTimeOfArrival: '2026-11-10T08:01:00Z' },
      { platformName: 'Platform A', destinationNaptanId: '910GSHENFLD', destinationName: 'Shenfield Rail Station', scheduledTimeOfDeparture: '2026-11-10T07:58:00Z', departureStatus: 'Delayed', cause: 'This service has been delayed by a fault with the signalling system' },
      { platformName: 'Platform B', destinationNaptanId: '910GHTRWTM4', destinationName: 'Heathrow Terminal 4 Rail Station', scheduledTimeOfDeparture: '2026-11-10T07:50:00Z', estimatedTimeOfDeparture: '2026-11-10T07:51:00Z', departureStatus: 'OnTime' },
    ];
    const { call, tfl } = setup({
      '/StopPoint/HUBPAD': { body: { id: 'HUBPAD', modes: ['tube', 'elizabeth-line', 'national-rail', 'bus'], lines: [{ id: 'bakerloo' }, { id: 'elizabeth' }],
        children: [{ id: '940GZZLUPAC', modes: ['tube'] }, { id: '910GPADTLL', modes: ['elizabeth-line'] }, { id: '910GPADTON', modes: ['elizabeth-line', 'national-rail'] }, { id: '490BUS', modes: ['bus'] }] } },
      '/StopPoint/940GZZLUPAC/Arrivals': { body: [prediction({ lineId: 'bakerloo', lineName: 'Bakerloo', timeToStation: 120, expectedArrival: '2026-11-10T08:02:00Z', destinationNaptanId: 'X' })] },
      '/StopPoint/910GPADTLL': { body: elizabeth('910GPADTLL', ['elizabeth-line']) },
      '/StopPoint/910GPADTON': { body: elizabeth('910GPADTON', ['elizabeth-line', 'national-rail']) },
      '/StopPoint/910GPADTLL/ArrivalDepartures': { body: board },
      '/StopPoint/910GPADTON/ArrivalDepartures': { body: board },
    });
    const data = (await call('live_departures', { stop: 'HUBPAD' })).structuredContent;
    // The Shenfield train is overdue with no estimate: listed last, with expected null rather than a past time.
    expect(data.arrivals).toEqual([
      expect.objectContaining({ line: 'bakerloo', mode: 'tube', minutes: 2 }),
      { line: 'elizabeth', lineName: 'Elizabeth line', mode: 'elizabeth-line', bound: null, platform: 'Platform A', destination: 'Abbey Wood', minutes: 4, expected: '2026-11-10T08:04:00Z', location: null,
        scheduled: '2026-11-10T08:03:00Z', status: 'Delayed', reason: null },
      { line: 'elizabeth', lineName: 'Elizabeth line', mode: 'elizabeth-line', bound: null, platform: 'Platform A', destination: 'Shenfield', minutes: null, expected: null, location: null,
        scheduled: '2026-11-10T07:58:00Z', status: 'Delayed', reason: 'This service has been delayed by a fault with the signalling system' },
    ]);
    expect(data.coverage_note).toContain('South Western Railway');
    expect(tfl.calls.some((url) => url.pathname.startsWith('/StopPoint/910G') && url.pathname.endsWith('/Arrivals'))).toBe(false);
    expect(tfl.calls.find((url) => url.pathname.endsWith('/ArrivalDepartures'))!.searchParams.get('lineIds')).toBe('elizabeth');
  });

  it('reads Overground departures per line at a starting station, never its /Arrivals guesses', async () => {
    const { call, tfl } = setup({
      '/StopPoint/910GCLPHMJ1': { body: { id: '910GCLPHMJ1', modes: ['bus', 'national-rail', 'overground'], lines: [{ id: 'mildmay', name: 'Mildmay' }, { id: 'windrush', name: 'Windrush' }, { id: 'southern', name: 'Southern' }],
        lineModeGroups: [{ modeName: 'overground', lineIdentifier: ['mildmay', 'windrush'] }, { modeName: 'national-rail', lineIdentifier: ['southern'] }] } },
      '/StopPoint/910GCLPHMJ1/ArrivalDepartures': () => ({ body: [{ platformName: 'Platform 2', destinationNaptanId: '910GDALS', destinationName: 'Dalston Junction Rail Station', scheduledTimeOfDeparture: '2026-11-10T08:05:00Z', estimatedTimeOfDeparture: '2026-11-10T08:05:00Z', departureStatus: 'OnTime' }] }),
      '/StopPoint/910GCLPHMJ1/Arrivals': { body: [prediction({ lineId: 'mildmay', timeToStation: 27 })] },
    });
    const data = (await call('live_departures', { stop: '910GCLPHMJ1', line: 'windrush' })).structuredContent;
    expect(data.arrivals).toEqual([expect.objectContaining({ line: 'windrush', lineName: 'Windrush', destination: 'Dalston Junction', minutes: 5, status: 'OnTime' })]);
    expect(data.coverage_note).toContain('not included');
    expect(tfl.calls.map((url) => url.pathname)).not.toContain('/StopPoint/910GCLPHMJ1/Arrivals');
    expect(tfl.calls.filter((url) => url.pathname.endsWith('/ArrivalDepartures')).map((url) => url.searchParams.get('lineIds'))).toEqual(['windrush']);
  });

  it('shows a DLR train listed on both faces of a platform pair once', async () => {
    const dlr = (platformName: string, timeToStation: number, destinationName: string, expectedArrival: string) =>
      prediction({ lineId: 'dlr', lineName: 'DLR', platformName, timeToStation, destinationName, destinationNaptanId: destinationName, expectedArrival, vehicleId: undefined });
    const { call } = setup({
      '/StopPoint/940GZZDLCAN': { body: { id: '940GZZDLCAN', modes: ['dlr'], lines: [{ id: 'dlr' }] } },
      '/StopPoint/940GZZDLCAN/Arrivals': { body: [
        dlr('Platform 6', 202, 'Bank DLR Station', '2026-11-10T08:03:22Z'), dlr('Platform 5', 203, 'Bank DLR Station', '2026-11-10T08:03:23Z'),
        dlr('Platform 3', 442, 'Stratford DLR Station', '2026-11-10T08:07:22Z'), dlr('Platform 3', 443, 'Stratford DLR Station', '2026-11-10T08:07:23Z'),
        dlr('Platform 5', 502, 'Bank DLR Station', '2026-11-10T08:08:22Z'),
      ] },
    });
    const data = (await call('live_departures', { stop: '940GZZDLCAN' })).structuredContent;
    expect(data.arrivals.map((arrival: any) => [arrival.destination, arrival.platform, arrival.minutes])).toEqual([
      ['Bank', '', 3], ['Stratford', 'Platform 3', 7], ['Bank', 'Platform 5', 8],
    ]);
    expect(data.coverage_note).toBeUndefined();
  });

  it('explains that a National Rail-only station has no live departures', async () => {
    const { call } = setup({
      '/StopPoint/910GSURBITN': { body: { id: '910GSURBITN', modes: ['national-rail'], lines: [{ id: 'south-western-railway' }] } },
      '/StopPoint/910GSURBITN/Arrivals': { body: [] },
    });
    const data = (await call('live_departures', { stop: '910GSURBITN' })).structuredContent;
    expect(data.arrivals).toEqual([]);
    expect(data.next_action).toContain('only by National Rail');
    expect(data.coverage_note).toContain('plan_journey');
  });

  it('redacts upstream network failures and advises retry without inventing service', async () => {
    const app = createApp({ mcpSecret: SECRET, fetch: (async () => { throw new Error('https://secret.example?app_key=TOPSECRET'); }) as typeof fetch });
    const { access_token } = await connectOAuth(app, SECRET);
    const response = await app.request(PATH, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'line_status', arguments: {} } }) });
    const body = await response.text();
    expect(body).not.toContain('TOPSECRET');
    expect(JSON.parse(body).result).toMatchObject({ isError: true, structuredContent: { error: { code: 'tfl_unavailable' } } });
  });
});
