import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RttClient, trainTime } from '../src/rtt.js';
import { connectOAuth, fakeTfl, lineWith, NETWORK_STATUS, networkLines, type Route } from './helpers.js';

const SECRET = 'test-only-not-a-production-credential';
const AT = '2026-11-16T08:30:00Z';
const FROM = '940GZZLUWYP';
const TO = '940GZZLUBNK';
const JOURNEY_PATH = `/Journey/JourneyResults/${FROM}/to/${TO}`;

const leg = (mode: string, line: string | null, from: string, to: string, departure: string, arrival: string, duration: number) => ({
  duration, departureTime: `2026-11-16T${departure}:00`, arrivalTime: `2026-11-16T${arrival}:00`, mode: { id: mode },
  departurePoint: { commonName: from }, arrivalPoint: { commonName: to },
  routeOptions: line ? [{ name: line, lineIdentifier: { id: line.toLowerCase() } }] : [{ name: '' }],
});
const busRoute = { duration: 40, startDateTime: '2026-11-16T08:30:00', arrivalDateTime: '2026-11-16T09:10:00', legs: [
  leg('walking', null, 'Home', 'Stop A', '08:30', '08:32', 2), leg('bus', '436', 'Stop A', 'Oval', '08:32', '08:41', 9), leg('tube', 'Northern', 'Oval', 'Bank', '08:45', '09:10', 25),
] };
const railRoute = { duration: 47, startDateTime: '2026-11-16T08:30:00', arrivalDateTime: '2026-11-16T09:17:00', legs: [
  leg('walking', null, 'Home', 'Denmark Hill', '08:30', '08:47', 17), leg('overground', 'Windrush', 'Denmark Hill', 'Whitechapel', '08:50', '09:10', 20), leg('tube', 'District', 'Whitechapel', 'Aldgate East', '09:13', '09:17', 4),
] };

type Options = { rttToken?: string; dataDir?: string };
function setup(routes: Record<string, Route>, options: Options = {}) {
  const upstream = fakeTfl(routes);
  let time = Date.parse(AT);
  const app = createApp({ fetch: upstream.fetch, mcpSecret: SECRET, now: () => time, ...options });
  let token: string | undefined;
  const send = async (method: string, params: unknown) => {
    token ??= (await connectOAuth(app, SECRET)).access_token;
    return app.request('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  };
  const rpc = async (method: string, params: unknown = {}) => {
    let response = await send(method, params);
    // Access tokens last an hour; a test that moves the clock further logs in again.
    if (response.status === 401) {
      token = undefined;
      response = await send(method, params);
    }
    return (await response.json() as any).result;
  };
  const call = async (name: string, args: unknown = {}) => rpc('tools/call', { name, arguments: args });
  return { upstream, rpc, call, advance: (milliseconds: number) => { time += milliseconds; } };
}

describe('mode control', () => {
  it('asks TfL for routes without an excluded mode and reports the filter', async () => {
    const { call, upstream } = setup({ [JOURNEY_PATH]: { body: { journeys: [railRoute] } } });
    const data = (await call('plan_journey', { from: FROM, to: TO, at: AT, exclude_modes: ['bus'] })).structuredContent;
    const modes = upstream.calls.at(-1)!.searchParams.get('mode')!.split(',');
    expect(modes).not.toContain('bus');
    expect(modes).not.toContain('replacement-bus');
    expect(modes).toEqual(expect.arrayContaining(['tube', 'national-rail', 'walking']));
    expect(data.mode_filter).toEqual({ excluded: ['bus'], source: 'request' });
    expect(data.routes[0].legs[1]).toMatchObject({ mode: 'overground', line_ids: ['windrush'] });
  });

  it('drops a route that still uses an excluded mode, whatever TfL returns', async () => {
    const { call } = setup({ [JOURNEY_PATH]: { body: { journeys: [busRoute, railRoute] } } });
    const data = (await call('plan_journey', { from: FROM, to: TO, at: AT, exclude_modes: ['bus'] })).structuredContent;
    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].legs.map((item: any) => item.mode)).not.toContain('bus');
    expect(data.routes_dropped_for_excluded_modes).toBe(1);
  });

  it('excludes nothing unless the call asks', async () => {
    const { call, upstream } = setup({ [JOURNEY_PATH]: { body: { journeys: [busRoute, railRoute] } } });
    const data = (await call('plan_journey', { from: FROM, to: TO, at: AT })).structuredContent;
    expect(data.mode_filter).toEqual({ excluded: [], source: 'none' });
    expect(data.routes).toHaveLength(2);
    expect(upstream.calls.at(-1)!.searchParams.has('mode')).toBe(false);
  });

  it('says when nothing avoids the excluded mode instead of returning a bus route', async () => {
    const { call } = setup({ [JOURNEY_PATH]: { body: { journeys: [busRoute] } } });
    const data = (await call('plan_journey', { from: FROM, to: TO, at: AT, exclude_modes: ['bus'] })).structuredContent;
    expect(data).toMatchObject({ status: 'no_journeys', routes: [] });
    expect(data.next_action).toContain('No route avoids bus');
  });

  it('carries the exclusion and preference through a batch', async () => {
    const { call, upstream } = setup({ [JOURNEY_PATH]: { body: { journeys: [railRoute] } } });
    const data = (await call('plan_journeys_batch', { origins: [FROM], to: TO, at: AT, preference: 'fewest_changes', exclude_modes: ['bus'] })).structuredContent;
    expect(data.journeys[0].mode_filter).toEqual({ excluded: ['bus'], source: 'request' });
    const params = upstream.calls.at(-1)!.searchParams;
    expect(params.get('journeyPreference')).toBe('leastinterchange');
    expect(params.get('mode')!.split(',')).not.toContain('bus');
  });
});

describe('saved places', () => {
  const routes = { [JOURNEY_PATH]: { body: { journeys: [railRoute] } }, [NETWORK_STATUS]: { body: networkLines() } };

  it('saves a place, lists it in the operating instructions and plans with its label', async () => {
    const { call, upstream } = setup(routes);
    const saved = (await call('remember', { action: 'save_place', label: 'Home', place: FROM, note: 'flat' })).structuredContent;
    expect(saved).toMatchObject({ status: 'saved', saved: { label: 'home', place: FROM, note: 'flat' }, durable: false });
    expect(saved.warning).toContain('restart');
    await call('remember', { action: 'save_place', label: 'work', place: TO });
    const manual = (await call('get_context')).structuredContent;
    expect(manual.user.saved_places).toEqual([{ label: 'home', place: FROM, note: 'flat' }, { label: 'work', place: TO }]);
    const data = (await call('plan_journey', { from: 'home', to: 'Work', at: AT })).structuredContent;
    expect(data.status).toBe('ok');
    expect(data.resolved).toMatchObject({ from: { input: 'home', used: FROM, saved_place: 'home' }, to: { input: 'Work', used: TO, saved_place: 'work' } });
    expect(upstream.calls.at(-1)!.pathname).toBe(JOURNEY_PATH);
  });

  it('replaces a label, reports what it replaced, and forgets on request', async () => {
    const { call } = setup(routes);
    await call('remember', { action: 'save_place', label: 'home', place: 'SW1A 1AA' });
    const replaced = (await call('remember', { action: 'save_place', label: 'home', place: FROM })).structuredContent;
    expect(replaced).toMatchObject({ status: 'replaced', replaced: { place: 'SW1A 1AA' }, saved: { place: FROM } });
    expect((await call('remember', { action: 'forget_place', label: 'HOME' })).structuredContent).toMatchObject({ status: 'forgotten', removed: { place: FROM } });
    expect((await call('remember', { action: 'forget_place', label: 'home' })).structuredContent).toMatchObject({ status: 'not_found', remembered: { places: [] } });
    expect((await call('get_context')).structuredContent.user.saved_places).toEqual([]);
  });

  it('rejects bad labels, a label as a place, and more places than the limit', async () => {
    const { call } = setup(routes);
    for (const label of ['', '9lives', 'x'.repeat(21), 'mum\'s']) expect((await call('remember', { action: 'save_place', label, place: FROM })).isError).toBe(true);
    await call('remember', { action: 'save_place', label: 'home', place: FROM });
    expect((await call('remember', { action: 'save_place', label: 'flat', place: 'home' })).structuredContent.status).toBe('rejected');
    for (let index = 0; index < 19; index++) await call('remember', { action: 'save_place', label: `place ${index}`, place: FROM });
    expect((await call('remember', { action: 'save_place', label: 'one more', place: FROM })).structuredContent).toMatchObject({ status: 'rejected' });
  });

  it('keeps places across a restart when it has a directory, and survives a corrupt file', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tube-places-'));
    const first = setup(routes, { dataDir });
    expect((await first.call('remember', { action: 'save_place', label: 'home', place: FROM })).structuredContent).toMatchObject({ durable: true });
    expect(JSON.parse(readFileSync(join(dataDir, 'owner.json'), 'utf8')).places).toHaveLength(1);
    const second = setup(routes, { dataDir });
    expect((await second.call('get_context')).structuredContent.user).toMatchObject({ saved_places: [{ label: 'home', place: FROM }] });
    expect((await second.call('get_context')).structuredContent.user).not.toHaveProperty('not_durable');
    expect((await second.call('get_context')).structuredContent.owner_setup_pending.map((item: any) => item.missing)).toEqual(['RTT_TOKEN']);
    writeFileSync(join(dataDir, 'owner.json'), '{not json');
    const third = setup(routes, { dataDir });
    expect((await third.call('get_context')).structuredContent.user.saved_places).toEqual([]);
  });

  it('marks only the storing tools as not read-only', async () => {
    const { rpc } = setup(routes);
    const writers = (await rpc('tools/list')).tools.filter((tool: any) => !tool.annotations.readOnlyHint).map((tool: any) => tool.name);
    expect(writers.sort()).toEqual(['change_journey', 'follow_journey', 'remember']);
  });
});

const HUB = {
  id: 'HUBLBG', commonName: 'London Bridge', modes: ['tube', 'national-rail', 'bus'],
  lines: [{ id: 'jubilee', name: 'Jubilee' }, { id: 'southern', name: 'Southern' }, { id: 'thameslink', name: 'Thameslink' }],
  lineModeGroups: [{ modeName: 'tube', lineIdentifier: ['jubilee'] }, { modeName: 'national-rail', lineIdentifier: ['southern', 'thameslink'] }],
  children: [
    { id: '940GZZLULNB', commonName: 'London Bridge Underground Station', stopType: 'NaptanMetroStation', modes: ['tube'], lines: [{ id: 'jubilee', name: 'Jubilee' }] },
    { id: '910GLNDNBDC', commonName: 'London Bridge Rail Station', stopType: 'NaptanRailStation', modes: ['national-rail'], lines: [{ id: 'southern', name: 'Southern' }, { id: 'thameslink', name: 'Thameslink' }] },
  ],
};
const train = (over: { id: string; code: string; name: string; due: string; forecast?: string | null; to: string; platform?: string; display?: string; cancelled?: boolean; mode?: string; callType?: string }) => ({
  temporalData: {
    departure: { scheduleAdvertised: `2026-11-16T${over.due}:00+00:00`, ...(over.forecast ? { realtimeForecast: `2026-11-16T${over.forecast}:00+00:00` } : {}), isCancelled: over.cancelled ?? false },
    scheduledCallType: over.callType ?? 'ADVERTISED_OPEN', displayAs: over.display ?? 'CALL',
  },
  locationMetadata: { platform: { planned: over.platform ?? '', actual: null }, numberOfVehicles: 8 },
  scheduleMetadata: { uniqueIdentity: `gb-nr:${over.id}:2026-11-16`, identity: over.id, departureDate: '2026-11-16', operator: { code: over.code, name: over.name }, modeType: over.mode ?? 'TRAIN', inPassengerService: true },
  origin: [{ location: { description: 'London Bridge', shortCodes: ['LBG'] } }],
  destination: [{ location: { description: over.to, shortCodes: ['XXX'] } }],
  reasons: over.cancelled ? [{ type: 'CANCEL', shortText: 'Train fault', longText: 'A fault on this train.' }] : [],
});
const BOARD = { systemStatus: { realtimeNetworkRail: 'OK', rttCore: 'OK' }, services: [
  train({ id: 'S1', code: 'SN', name: 'Southern', due: '08:36', forecast: '08:41', to: 'Caterham', platform: '12' }),
  train({ id: 'T1', code: 'TL', name: 'Thameslink', due: '08:38', forecast: '08:38', to: 'Brighton', platform: '5' }),
  train({ id: 'S2', code: 'SN', name: 'Southern', due: '08:44', to: 'Epsom', cancelled: true }),
  train({ id: 'S3', code: 'SN', name: 'Southern', due: '08:40', to: 'London Bridge', display: 'TERMINATES' }),
  train({ id: 'S4', code: 'SE', name: 'Southeastern', due: '08:50', to: 'Dartford', mode: 'REPLACEMENT_BUS' }),
  train({ id: 'S5', code: 'SN', name: 'Southern', due: '08:52', to: 'Depot', callType: 'OPERATIONAL_ONLY' }),
] };
const TOKEN_REPLY = { body: { token: 'short-lived-access', entitlements: [], validUntil: '2026-11-16T08:50:00+00:00' } };
const rttHeaders = { 'X-RateLimit-Limit-Minute': '10', 'X-RateLimit-Remaining-Minute': '9', 'X-RateLimit-Remaining-Day': '990' };

/** A stand-in for TfL and Realtime Trains that also records the bearer each request carried. */
function upstreams(routes: Record<string, Route>, rail: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const base = fakeTfl(routes);
  const bearers: { path: string; bearer: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'data.rtt.io') return base.fetch(input, init);
    bearers.push({ path: `${url.pathname}${url.search}`, bearer: new Headers(init?.headers).get('Authorization') });
    const reply = rail[url.pathname];
    if (!reply) return new Response('{"error":"not found"}', { status: 404 });
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof fetch;
  return { fetch: fetchImpl, bearers, calls: base.calls };
}

function railSetup(rail: Parameters<typeof upstreams>[1], token: string | null = 'refresh-token') {
  const up = upstreams({
    '/StopPoint/HUBLBG': { body: HUB }, '/StopPoint/940GZZLULNB': { body: HUB }, '/StopPoint/910GLNDNBDC': { body: HUB },
    '/StopPoint/940GZZLULNB/Arrivals': { body: [] }, '/StopPoint/910GLNDNBDC/ArrivalDepartures': { body: [] },
    '/StopPoint/Search/east%20croydon': { body: { matches: [] } }, [NETWORK_STATUS]: { body: networkLines() },
  }, rail);
  let time = Date.parse(AT);
  const app = createApp({ fetch: up.fetch, mcpSecret: SECRET, now: () => time, rttToken: token ?? undefined });
  let auth: string | undefined;
  const rpc = async (method: string, params: unknown = {}) => {
    auth ??= (await connectOAuth(app, SECRET)).access_token;
    const response = await app.request('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${auth}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await response.json() as any).result;
  };
  return { up, rpc, call: (name: string, args: unknown = {}) => rpc('tools/call', { name, arguments: args }), advance: (milliseconds: number) => { time += milliseconds; } };
}

describe('National Rail live departures from Realtime Trains', () => {
  it('adds other operators to a station board, buying an access token with the refresh token', async () => {
    const { call, up } = railSetup({ '/api/get_access_token': TOKEN_REPLY, '/gb-nr/location': { body: BOARD, headers: rttHeaders } });
    const data = (await call('live_departures', { stop: 'HUBLBG', limit: 20 })).structuredContent;
    expect(up.bearers.map((item) => item.bearer)).toEqual(['Bearer refresh-token', 'Bearer short-lived-access']);
    expect(up.bearers[1]!.path).toBe('/gb-nr/location?code=LBG');
    // Thameslink is TfL's to report here; the terminating and operational-only trains cannot be boarded.
    expect(data.arrivals.map((item: any) => item.service_id)).toEqual(['gb-nr:S1:2026-11-16', 'gb-nr:S2:2026-11-16', 'gb-nr:S4:2026-11-16']);
    expect(data.arrivals[0]).toMatchObject({ line: 'southern', lineName: 'Southern', mode: 'national-rail', destination: 'Caterham', platform: '12', status: 'Delayed', minutes: 11, coaches: 8, source: 'realtime-trains' });
    expect(data.arrivals[1]).toMatchObject({ status: 'Cancelled', expected: null, minutes: null, reason: 'A fault on this train.' });
    expect(data.arrivals[2]).toMatchObject({ mode: 'replacement-bus', line: 'southeastern', status: 'Scheduled' });
    expect(data.source).toContain('Realtime Trains');
    expect(data.coverage_note).toContain('buses standing in for trains');
    expect(data.coverage_note).not.toContain('not included');
  });

  it('serves a repeat inside a minute from cache and filters by operator', async () => {
    const { call, up } = railSetup({ '/api/get_access_token': TOKEN_REPLY, '/gb-nr/location': { body: BOARD, headers: rttHeaders } });
    await call('live_departures', { stop: 'HUBLBG' });
    const southern = (await call('live_departures', { stop: 'HUBLBG', line: 'southern' })).structuredContent;
    expect(southern.arrivals.every((item: any) => item.line === 'southern')).toBe(true);
    expect(southern.arrivals).toHaveLength(2);
    expect(up.bearers.filter((item) => item.path.startsWith('/gb-nr/location'))).toHaveLength(1);
  });

  it('does not spend a rail request on a Tube line filter', async () => {
    const { call, up } = railSetup({ '/api/get_access_token': TOKEN_REPLY, '/gb-nr/location': { body: BOARD } });
    await call('live_departures', { stop: 'HUBLBG', line: 'jubilee' });
    expect(up.bearers).toHaveLength(0);
  });

  it('filters by a later calling point and then lists every operator from Realtime Trains', async () => {
    const { call, up } = railSetup({ '/api/get_access_token': TOKEN_REPLY, '/gb-nr/location': { body: BOARD } });
    const data = (await call('live_departures', { stop: 'HUBLBG', calling_at: 'ECR', limit: 20 })).structuredContent;
    expect(up.bearers.at(-1)!.path).toBe('/gb-nr/location?code=LBG&filterTo=ECR');
    expect(data.arrivals.map((item: any) => item.operator_code)).toContain('TL');
    expect(data.coverage_note).toContain('later call at');
    // TfL's own boards were not read: they cannot be filtered by calling point.
    expect(up.calls.some((url) => url.pathname.endsWith('/Arrivals') || url.pathname.endsWith('/ArrivalDepartures'))).toBe(false);
  });

  it('explains an unusable calling_at instead of guessing', async () => {
    const { call, up } = railSetup({ '/api/get_access_token': TOKEN_REPLY, '/gb-nr/location': { body: BOARD } });
    const data = (await call('live_departures', { stop: 'HUBLBG', calling_at: 'east croydon' })).structuredContent;
    expect(data.arrivals).toEqual([]);
    expect(data.next_action).toContain('CRS code');
    expect(up.bearers).toHaveLength(0);
  });

  it('keeps the TfL board and says what is missing when the allowance runs out, without hammering the feed', async () => {
    const { call, up } = railSetup({ '/api/get_access_token': TOKEN_REPLY, '/gb-nr/location': { status: 429, body: {}, headers: { 'Retry-After': '120' } } });
    const first = (await call('live_departures', { stop: 'HUBLBG' })).structuredContent;
    expect(first.coverage_note).toContain('allowance is used up');
    expect(first.next_action).toContain('could not be read');
    await call('live_departures', { stop: 'HUBLBG' });
    expect(up.bearers.filter((item) => item.path.startsWith('/gb-nr/location'))).toHaveLength(1);
    const manual = (await call('get_context')).structuredContent;
    expect(manual.feeds.national_rail_live.state).toBe('rate_limited');
  });

  it('uses a long-life access token directly when it is not a refresh token', async () => {
    const { call, up } = railSetup({ '/api/get_access_token': { status: 401, body: { error: 'Invalid or expired token' } }, '/gb-nr/location': { status: 204 } }, 'long-life-access');
    const data = (await call('live_departures', { stop: 'HUBLBG' })).structuredContent;
    expect(up.bearers.at(-1)).toEqual({ path: '/gb-nr/location?code=LBG', bearer: 'Bearer long-life-access' });
    expect(data.next_action).toContain('next hour');
  });

  it('without a token behaves as before and offers no train_service tool', async () => {
    const { call, rpc, up } = railSetup({}, null);
    const data = (await call('live_departures', { stop: 'HUBLBG' })).structuredContent;
    expect(data.coverage_note).toContain('Southern are not included');
    expect(up.bearers).toHaveLength(0);
    expect((await rpc('tools/list')).tools.map((tool: any) => tool.name)).not.toContain('train_service');
    expect((await call('live_departures', { stop: 'HUBLBG', calling_at: 'ECR' })).structuredContent.next_action).toContain('no token');
  });

  it('follows one train through its advertised calls', async () => {
    const call = (station: string, crs: string, display: string, arrive: string | null, depart: string | null, actual = false) => ({
      location: { description: station, shortCodes: [crs] },
      temporalData: {
        displayAs: display, scheduledCallType: display === 'PASS' ? null : 'ADVERTISED_OPEN',
        ...(arrive ? { arrival: { scheduleAdvertised: `2026-11-16T${arrive}:00+00:00`, realtimeForecast: `2026-11-16T${arrive}:00+00:00` } } : {}),
        ...(depart ? { departure: { scheduleAdvertised: `2026-11-16T${depart}:00+00:00`, ...(actual ? { realtimeActual: `2026-11-16T${depart.slice(0, 3)}${String(Number(depart.slice(3)) + 3).padStart(2, '0')}:00+00:00` } : {}) } } : {}),
      },
      locationMetadata: { platform: { planned: '4', actual: actual ? '5' : null } },
    });
    const { call: tool, up } = railSetup({ '/api/get_access_token': TOKEN_REPLY, '/gb-nr/service': { body: { service: {
      scheduleMetadata: { operator: { code: 'SN', name: 'Southern' }, modeType: 'TRAIN' },
      origin: [{ location: { description: 'London Bridge' } }], destination: [{ location: { description: 'Caterham' } }],
      locations: [call('London Bridge', 'LBG', 'CALL', null, '08:36', true), call('Bermondsey Junction', 'XBJ', 'PASS', null, '08:38'), call('East Croydon', 'ECR', 'CALL', '08:51', '08:52'), call('Purley', 'PUR', 'CANCELLED', '08:58', '08:59')],
    } } } });
    const data = (await tool('train_service', { service_id: 'gb-nr:S1:2026-11-16' })).structuredContent;
    expect(up.bearers.at(-1)!.path).toBe('/gb-nr/service?uniqueIdentity=S1%3A2026-11-16');
    expect(data).toMatchObject({ operator: 'Southern', destination: 'Caterham', source: 'Realtime Trains' });
    expect(data.calls.map((item: any) => item.station)).toEqual(['London Bridge', 'East Croydon', 'Purley']);
    expect(data.calls[0]).toMatchObject({ platform: '5', departure: { status: 'Delayed', late_minutes: 3, actual: true } });
    expect(data.calls[2]).toMatchObject({ call: 'cancelled', arrival: { status: 'Cancelled', expected: null } });
    expect((await tool('train_service', { service_id: 'not an id' })).isError).toBe(true);
  });

  it('never returns the token', async () => {
    const { call } = railSetup({ '/api/get_access_token': TOKEN_REPLY, '/gb-nr/location': { status: 500, body: { error: 'refresh-token short-lived-access' } } });
    const text = JSON.stringify([await call('live_departures', { stop: 'HUBLBG' }), await call('get_context')]);
    expect(text).not.toContain('refresh-token');
    expect(text).not.toContain('short-lived-access');
    expect(JSON.parse(text)[1].structuredContent.feeds.national_rail_live.state).toBe('failing');
  });

  it('reads times as live, scheduled, unreported or cancelled', () => {
    const due = '2026-11-16T08:36:00+00:00';
    expect(trainTime({ scheduleAdvertised: due })).toMatchObject({ status: 'Scheduled', expected: due });
    expect(trainTime({ scheduleAdvertised: due, realtimeForecast: due })).toMatchObject({ status: 'OnTime', late_minutes: 0 });
    expect(trainTime({ scheduleAdvertised: due, realtimeNoReport: true })).toMatchObject({ status: 'NoReport', expected: null });
    expect(trainTime({ scheduleAdvertised: due, realtimeForecast: due, isCancelled: true })).toMatchObject({ status: 'Cancelled', expected: null });
    expect(trainTime(null)).toBeNull();
  });

  it('reports what it knows about the feed without spending a request', () => {
    const client = new RttClient((async () => new Response('{}')) as typeof fetch, undefined, () => 0);
    expect(client.state()).toMatchObject({ configured: false, last_ok_at: null, blocked_until: null });
  });
});

describe('the remember tool', () => {
  const routes = { [JOURNEY_PATH]: { body: { journeys: [busRoute, railRoute] } }, [NETWORK_STATUS]: { body: networkLines() } };

  it('shows what is saved, and returns the full state with every change', async () => {
    const { call, upstream } = setup(routes);
    expect((await call('remember', { action: 'show' })).structuredContent).toMatchObject({ status: 'ok', remembered: { places: [], avoid_modes: [], followed_journeys: [] } });
    const saved = (await call('remember', { action: 'save_place', label: 'Home', place: FROM })).structuredContent;
    expect(saved.remembered.places).toEqual([{ label: 'home', place: FROM }]);
    const preferred = (await call('remember', { action: 'set_preferences', avoid_modes: ['bus'], note: 'fine late at night' })).structuredContent;
    expect(preferred.remembered).toMatchObject({ places: [{ label: 'home' }], avoid_modes: ['bus'], preference_note: 'fine late at night' });
    const shown = (await call('remember', { action: 'show' }));
    expect(shown.structuredContent.remembered).toEqual(preferred.remembered);
    // Reading what is saved is small and asks TfL nothing.
    expect(shown.content[0].text.length).toBeLessThan(700);
    expect(upstream.calls).toHaveLength(0);
    expect((await call('remember', { action: 'forget_place', label: 'home' })).structuredContent.remembered.places).toEqual([]);
  });

  it('rejects fields that belong to another action, saying which', async () => {
    const { call } = setup(routes);
    const rejected = async (args: object) => (await call('remember', args)).structuredContent;
    expect(await rejected({ action: 'save_place', label: 'home' })).toMatchObject({ status: 'rejected', next_action: 'save_place needs both label and place.' });
    expect((await rejected({ action: 'save_place', label: 'home', place: FROM, avoid_modes: ['bus'] })).next_action).toContain('Call remember twice');
    expect((await rejected({ action: 'forget_place', label: 'home', place: FROM })).next_action).toContain('takes only label');
    expect((await rejected({ action: 'set_preferences' })).next_action).toContain('needs avoid_modes');
    expect((await rejected({ action: 'set_preferences', avoid_modes: [], label: 'home' })).status).toBe('rejected');
    expect((await rejected({ action: 'show', label: 'home' })).status).toBe('rejected');
    expect((await call('remember', { action: 'delete_everything' })).isError).toBe(true);
    expect((await call('remember', { action: 'show' })).structuredContent.remembered.places).toEqual([]);
  });

  it('is the only remembering tool', async () => {
    const { rpc } = setup(routes);
    const names = (await rpc('tools/list')).tools.map((tool: any) => tool.name);
    expect(names).toContain('remember');
    expect(names.filter((name: string) => /place|preferences/.test(name))).toEqual([]);
  });
});

describe('travel preferences', () => {
  const both = { [JOURNEY_PATH]: { body: { journeys: [busRoute, railRoute] } }, [NETWORK_STATUS]: { body: networkLines() } };

  it('applies a saved preference when a call says nothing, and names the faster route it hid', async () => {
    const { call, upstream } = setup(both);
    const saved = (await call('remember', { action: 'set_preferences', avoid_modes: ['bus'], note: 'fine late at night' })).structuredContent;
    expect(saved).toMatchObject({ status: 'saved', saved: { avoid_modes: ['bus'], note: 'fine late at night' } });
    const data = (await call('plan_journey', { from: FROM, to: TO, at: AT })).structuredContent;
    expect(data.routes.map((route: any) => route.duration_minutes)).toEqual([47]);
    expect(data.mode_filter).toMatchObject({ excluded: ['bus'], source: 'saved_preference', faster_with_avoided_modes: { duration_minutes: 40, saves_minutes: 7, uses: ['bus'] } });
    // One call without buses, one with everything for the comparison.
    expect(upstream.calls.filter((url) => url.pathname === JOURNEY_PATH).map((url) => url.searchParams.has('mode'))).toEqual([true, false]);
    const manual = (await call('get_context')).structuredContent;
    expect(manual.user).toMatchObject({ avoid_modes: ['bus'], preference_note: 'fine late at night' });
  });

  it('keeps the avoided mode reachable for one call and clears on request', async () => {
    const { call } = setup(both);
    await call('remember', { action: 'set_preferences', avoid_modes: ['bus'] });
    const lifted = (await call('plan_journey', { from: FROM, to: TO, at: AT, ignore_preference: true })).structuredContent;
    expect(lifted.mode_filter).toEqual({ excluded: [], source: 'none', preference_ignored: ['bus'] });
    expect(lifted.routes).toHaveLength(2);
    // An empty exclusion list no longer lifts anything: the preference still holds.
    expect((await call('plan_journey', { from: FROM, to: TO, at: AT, exclude_modes: [] })).structuredContent.mode_filter.source).toBe('saved_preference');
    expect((await call('remember', { action: 'set_preferences', avoid_modes: [] })).structuredContent).toMatchObject({ saved: { avoid_modes: [] }, previous: { avoid_modes: ['bus'] } });
    expect((await call('plan_journey', { from: FROM, to: TO, at: AT })).structuredContent.mode_filter.source).toBe('none');
  });

  it('adds a one-off exclusion to the saved preference instead of replacing it', async () => {
    const tubeFree = { ...railRoute, legs: [railRoute.legs[0], railRoute.legs[1]], duration: 60 };
    const { call, upstream } = setup({ ...both, [JOURNEY_PATH]: { body: { journeys: [busRoute, railRoute, tubeFree] } } });
    await call('remember', { action: 'set_preferences', avoid_modes: ['bus'] });
    const data = (await call('plan_journey', { from: FROM, to: TO, at: AT, exclude_modes: ['tube'] })).structuredContent;
    expect(data.mode_filter).toMatchObject({ excluded: ['tube', 'bus'], source: 'request_and_saved_preference', from_request: ['tube'], from_saved_preference: ['bus'] });
    const [filtered, comparison] = upstream.calls.filter((url) => url.pathname === JOURNEY_PATH).map((url) => url.searchParams.get('mode')!.split(','));
    expect(filtered).not.toContain('tube');
    expect(filtered).not.toContain('bus');
    // The comparison lifts only the saved preference: it still keeps the Tube out, as the user asked today.
    expect(comparison).toContain('bus');
    expect(comparison).not.toContain('tube');
    expect(data.routes.map((route: any) => route.duration_minutes)).toEqual([60]);
    expect(data.mode_filter).not.toHaveProperty('faster_with_avoided_modes');
    // Repeating a saved mode in the request is harmless.
    expect((await call('plan_journey', { from: FROM, to: TO, at: AT, exclude_modes: ['tube', 'bus'] })).structuredContent.mode_filter).toEqual({ excluded: ['tube', 'bus'], source: 'request' });
  });

  it('says nothing about the avoided mode when it would not save much', async () => {
    const slowBus = { ...busRoute, duration: 45 };
    const { call } = setup({ ...both, [JOURNEY_PATH]: { body: { journeys: [slowBus, railRoute] } } });
    await call('remember', { action: 'set_preferences', avoid_modes: ['bus'] });
    const data = (await call('plan_journey', { from: FROM, to: TO, at: AT })).structuredContent;
    expect(data.mode_filter).not.toHaveProperty('faster_with_avoided_modes');
  });

  it('offers the avoided mode when nothing else gets there', async () => {
    const { call } = setup({ ...both, [JOURNEY_PATH]: { body: { journeys: [busRoute] } } });
    await call('remember', { action: 'set_preferences', avoid_modes: ['bus'] });
    const data = (await call('plan_journey', { from: FROM, to: TO, at: AT })).structuredContent;
    expect(data).toMatchObject({ status: 'no_journeys', mode_filter: { faster_with_avoided_modes: { duration_minutes: 40, uses: ['bus'] } } });
  });
});

describe('following a journey', () => {
  const DH = '910GDENMRKH';
  const WPL = '940GZZLUWPL';
  const P = (from: string, to: string) => `/Journey/JourneyResults/${from}/to/${to}`;
  const point = (name: string, naptanId?: string) => ({ commonName: name, ...(naptanId ? { naptanId } : {}) });
  const one = (mode: string, line: string | null, from: [string, string?], to: [string, string?], departure: string, arrival: string) => ({
    duration: 0, startDateTime: `2026-11-16T${departure}:00`, arrivalDateTime: `2026-11-16T${arrival}:00`,
    legs: [{ ...leg(mode, line, from[0], to[0], departure, arrival, 1), departurePoint: point(...from), arrivalPoint: point(...to) }],
  });
  const walk = one('walking', null, ['Home'], ['Denmark Hill', DH], '08:30', '08:47');
  const windrush = one('overground', 'Windrush', ['Denmark Hill', DH], ['Whitechapel', WPL], '08:50', '09:10');
  const district = (arrive: string) => one('tube', 'District', ['Whitechapel', WPL], ['Aldgate East', '940GZZLUADE'], '09:13', arrive);
  const whole = { duration: 47, startDateTime: '2026-11-16T08:30:00', arrivalDateTime: '2026-11-16T09:17:00', legs: [...walk.legs, ...windrush.legs, ...district('09:17').legs] };
  const southeastern = one('national-rail', 'Southeastern', ['Denmark Hill', DH], ['Aldgate East', '940GZZLUADE'], '08:52', '09:20');
  const network = [...networkLines(),
    { ...lineWith('windrush', 'Windrush', { statusSeverity: 10, statusSeverityDescription: 'Good Service' }), modeName: 'overground' },
    { ...lineWith('district', 'District', { statusSeverity: 10, statusSeverityDescription: 'Good Service' }), modeName: 'tube' },
    { ...lineWith('southeastern', 'Southeastern', { statusSeverity: 10, statusSeverityDescription: 'Good Service' }), modeName: 'national-rail' }];
  /** The whole trip, each leg on its own, and TfL's free choice for the rest of it from Denmark Hill. */
  const routes = (over: Record<string, Route> = {}) => ({
    [JOURNEY_PATH]: { body: { journeys: [busRoute, whole] } },
    [P(FROM, DH)]: { body: { journeys: [walk] } },
    [P(DH, WPL)]: { body: { journeys: [windrush] } },
    [P(WPL, TO)]: { body: { journeys: [district('09:17')] } },
    [P(DH, TO)]: { body: { journeys: [{ ...whole, legs: whole.legs.slice(1), startDateTime: '2026-11-16T08:50:00' }] } },
    [NETWORK_STATUS]: { body: network }, ...over,
  });
  const journeyCalls = (upstream: { calls: URL[] }) => upstream.calls.filter((url) => url.pathname.startsWith('/Journey'));

  it('saves the chosen route as legs, lists it, and reports on plan while its own lines hold', async () => {
    const { call, advance } = setup(routes());
    const started = (await call('follow_journey', { action: 'start', from: FROM, to: TO, at: AT, route: 2 })).structuredContent;
    expect(started).toMatchObject({ status: 'ok', saved: 'new', tracking: { label: 'current', phase: 'travelling', current_leg: 1, planned_arrival: '2026-11-16T09:17:00+00:00', verdict: 'on_plan', arrival_change_minutes: 0 } });
    expect(started.leg_plan).toEqual([{ leg: 1, to: DH, by: 'walk' }, { leg: 2, to: WPL, by: 'windrush' }, { leg: 3, to: TO, by: 'district' }]);
    expect(started.routes).toHaveLength(1);
    expect(started.warning).toContain('restart');
    const manual = (await call('get_context')).structuredContent;
    expect(manual.user.followed_journeys).toEqual([expect.objectContaining({ label: 'current', planned_arrival: '2026-11-16T09:17:00+00:00' })]);
    advance(5 * 60_000);
    const checked = (await call('follow_journey', { action: 'check' })).structuredContent;
    expect(checked.tracking).toMatchObject({ phase: 'travelling', current_leg: 1, verdict: 'on_plan', your_route: { from: 'Denmark Hill' } });
    expect(checked.tracking).not.toHaveProperty('tfl_suggests');
  });

  it('times the rest of the traveller\'s own route and mentions a faster TfL suggestion', async () => {
    const { call, advance, upstream } = setup(routes({ [P(WPL, TO)]: { body: { journeys: [district('09:31')] } }, [P(DH, TO)]: { body: { journeys: [southeastern] } } }));
    await call('follow_journey', { action: 'start', from: FROM, to: TO, at: AT, route: 2, label: 'commute' });
    advance(10 * 60_000);
    const checked = (await call('follow_journey', { action: 'check', label: 'commute' })).structuredContent;
    expect(checked.tracking).toMatchObject({ verdict: 'later', arrival_change_minutes: 14, expected_arrival: '2026-11-16T09:31:00+00:00', tfl_suggests: { from: 'Denmark Hill', saves_minutes: 11 } });
    expect(checked.tracking.note).toContain('still works');
    // The Windrush leg is asked for from Denmark Hill, on the Overground alone, from when the walk ends at 08:47.
    const windrushCall = journeyCalls(upstream).filter((url) => url.pathname === P(DH, WPL)).at(-1)!;
    expect(windrushCall.searchParams.get('time')).toBe('0847');
    expect(windrushCall.searchParams.get('mode')).toBe('overground,walking');
  });

  it('says the route is broken when one of its lines cannot be timed, and offers TfL\'s way round', async () => {
    const { call, advance } = setup(routes({ [P(DH, TO)]: { body: { journeys: [southeastern] } } }));
    await call('follow_journey', { action: 'start', from: FROM, to: TO, at: AT, route: 2 });
    advance(5 * 60_000);
    const broken = setup(routes({ [P(DH, WPL)]: { body: { journeys: [one('national-rail', 'Southeastern', ['Denmark Hill', DH], ['Whitechapel', WPL], '08:55', '09:25')] } }, [P(DH, TO)]: { body: { journeys: [southeastern] } } }));
    await broken.call('follow_journey', { action: 'start', from: FROM, to: TO, at: AT, route: 2 });
    const checked = (await broken.call('follow_journey', { action: 'check' })).structuredContent;
    expect(checked.tracking).toMatchObject({ verdict: 'route_broken', broken_leg: { leg: { to: WPL, by: 'windrush' }, tfl_offered: ['southeastern'] }, tfl_suggests: { arrives: '2026-11-16T09:20:00+00:00' }, expected_arrival: '2026-11-16T09:20:00+00:00' });
    expect((await call('follow_journey', { action: 'check' })).structuredContent.tracking.verdict).toBe('on_plan');
  });

  it('knows the last leg, the arrival, the expiry and an ended journey', async () => {
    const { call, advance } = setup(routes());
    await call('follow_journey', { action: 'start', from: FROM, to: TO, at: AT, route: 2 });
    advance(44 * 60_000);
    expect((await call('follow_journey', { action: 'check' })).structuredContent.tracking).toMatchObject({ phase: 'travelling', current_leg: 3, verdict: 'on_plan' });
    advance(10 * 60_000);
    expect((await call('follow_journey', { action: 'check' })).structuredContent.tracking).toMatchObject({ phase: 'arrived', verdict: 'arrived' });
    advance(2 * 60 * 60_000);
    expect((await call('follow_journey', { action: 'check' })).structuredContent).toMatchObject({ status: 'not_tracking', followed_labels: [] });
    await call('follow_journey', { action: 'start', from: FROM, to: TO, at: new Date(Date.parse(AT) + 174 * 60_000).toISOString(), route: 2 });
    expect((await call('follow_journey', { action: 'end' })).structuredContent).toMatchObject({ status: 'ended', ended: { label: 'current' } });
    expect((await call('follow_journey', { action: 'end' })).structuredContent.status).toBe('not_tracking');
  });

  it('saves nothing when the plan has no such route', async () => {
    const { call } = setup(routes());
    const data = (await call('follow_journey', { action: 'start', from: FROM, to: TO, at: AT, route: 3 })).structuredContent;
    expect(data.tracking).toBeNull();
    expect(data.next_action).toContain('choose 1 to 2');
    expect((await call('follow_journey', { action: 'check' })).structuredContent.status).toBe('not_tracking');
  });

  it('honours the saved preference when following and survives a restart with storage', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tube-journey-'));
    const first = setup(routes(), { dataDir });
    await first.call('remember', { action: 'set_preferences', avoid_modes: ['bus'] });
    const started = (await first.call('follow_journey', { action: 'start', from: FROM, to: TO, at: AT })).structuredContent;
    expect(started.routes[0].legs.map((item: any) => item.mode)).not.toContain('bus');
    expect(started).not.toHaveProperty('warning');
    const second = setup(routes(), { dataDir });
    expect((await second.call('follow_journey', { action: 'check' })).structuredContent).toMatchObject({ tracking: { label: 'current', verdict: 'on_plan' }, leg_plan: [{ by: 'walk' }, { by: 'windrush' }, { by: 'district' }] });
    expect((await second.call('get_context')).structuredContent.user.avoid_modes).toEqual(['bus']);
  });

  const LEGS = [{ to: DH, by: 'walk' }, { to: WPL, by: 'windrush' }, { to: TO, by: 'district' }];

  it('builds a journey from chosen legs, each timed from where the last one ended, and compares it with TfL', async () => {
    const { call, upstream } = setup(routes({ [JOURNEY_PATH]: { body: { journeys: [busRoute] } } }));
    const data = (await call('change_journey', { action: 'set_legs', from: FROM, at: AT, legs: LEGS })).structuredContent;
    expect(data).toMatchObject({ status: 'ok', built_from_legs: true, refresh: { tool: 'change_journey', arguments: { action: 'set_legs', from: FROM, legs: LEGS } } });
    expect(data.routes[0]).toMatchObject({ departure: '2026-11-16T08:30:00+00:00', arrival: '2026-11-16T09:17:00+00:00', duration_minutes: 47, walking_minutes: 1, changes: 1 });
    expect(data.routes[0].legs.map((item: any) => item.line_ids[0] ?? item.mode)).toEqual(['walking', 'windrush', 'district']);
    expect(data.compared_with_tfl).toMatchObject({ this_route_arrives_minutes_later: 7, tfl_first_choice: { lines: ['436', 'northern'] } });
    const legCalls = journeyCalls(upstream).slice(0, 3);
    expect(legCalls.map((url) => [url.pathname, url.searchParams.get('time'), url.searchParams.get('mode')])).toEqual([
      [P(FROM, DH), '0830', 'walking'], [P(DH, WPL), '0847', 'overground,walking'], [P(WPL, TO), '0910', 'tube,walking'],
    ]);
    // Timing a route does not follow it unless a label is given.
    expect((await call('follow_journey', { action: 'check' })).structuredContent.status).toBe('not_tracking');
  });

  it('names the leg that cannot be timed and saves nothing', async () => {
    const { call } = setup(routes());
    const data = (await call('change_journey', { action: 'set_legs', from: FROM, at: AT, follow_as: 'commute', legs: [LEGS[0], { to: WPL, by: 'jubilee' }, LEGS[2]] })).structuredContent;
    expect(data).toMatchObject({ status: 'leg_failed', failed_leg: 2, leg: { to: WPL, by: 'jubilee' }, tfl_offered: ['windrush'], legs_timed: 1 });
    expect((await call('change_journey', { action: 'set_legs', from: FROM, at: AT, legs: [{ to: DH, by: 'hoverboard' }] })).structuredContent.reason).toContain('not a line');
    expect((await call('follow_journey', { action: 'check', label: 'commute' })).structuredContent.status).toBe('not_tracking');
  });

  it('plans once, then changes a leg of that plan by timing only the changed leg and those after it', async () => {
    const SHH = '940GZZLUSHH';
    const { call, upstream } = setup(routes({
      [P(DH, SHH)]: { body: { journeys: [one('overground', 'Windrush', ['Denmark Hill', DH], ['Shadwell', SHH], '08:50', '09:06')] } },
      [P(SHH, TO)]: { body: { journeys: [one('tube', 'District', ['Shadwell', SHH], ['Aldgate East', '940GZZLUADE'], '09:15', '09:25')] } },
    }));
    const planned = (await call('plan_journey', { from: FROM, to: TO, at: AT })).structuredContent;
    expect(planned.amend_with).toContain('route 1–2');
    expect(journeyCalls(upstream)).toHaveLength(1);
    const changed = (await call('change_journey', { action: 'replace_leg', route: 2, leg: 2, to: SHH })).structuredContent;
    expect(changed).toMatchObject({ status: 'ok', amended: { journey: 'plan', route: 1 }, change: { arrives_minutes_later: 8, legs_timed_again: 2 } });
    // The walk to Denmark Hill keeps the time the plan gave it: only the two legs from the change on were asked of TfL,
    // plus TfL's own choice for the comparison, which the first plan call already answered.
    expect(changed.routes[0].legs.map((item: any) => [item.departure.slice(11, 16), item.line_ids[0] ?? item.mode])).toEqual([['08:30', 'walking'], ['08:50', 'windrush'], ['09:15', 'district']]);
    expect(journeyCalls(upstream).slice(1).map((url) => url.pathname)).toEqual([P(DH, SHH), P(SHH, TO)]);
    expect(changed.refresh).toMatchObject({ tool: 'change_journey', arguments: { action: 'set_legs' } });
    // Changes chain on the amended route, and it can be followed from there.
    const again = (await call('change_journey', { action: 'replace_leg', leg: 2, to: WPL, follow_as: 'trip' })).structuredContent;
    expect(again).toMatchObject({ tracking: { label: 'trip', planned_arrival: '2026-11-16T09:17:00+00:00' }, change: { arrives_minutes_later: -8 } });
    expect((await call('follow_journey', { action: 'check', label: 'trip' })).structuredContent.status).toBe('ok');
  });

  it('says so when there is no plan to change, and reserves the name', async () => {
    const { call } = setup(routes());
    expect((await call('change_journey', { action: 'replace_leg', leg: 1, by: 'walk' })).structuredContent).toMatchObject({ status: 'no_plan', planned_routes: 0 });
    await call('plan_journey', { from: FROM, to: TO, at: AT });
    expect((await call('change_journey', { action: 'replace_leg', route: 3, leg: 1, by: 'walk' })).structuredContent).toMatchObject({ status: 'no_plan', planned_routes: 2 });
    expect((await call('follow_journey', { action: 'start', from: FROM, to: TO, at: AT, label: 'plan' })).isError).toBe(true);
  });

  it('follows a built journey and changes one leg, keeping the rest', async () => {
    const SHH = '940GZZLUSHH';
    const { call } = setup(routes({
      [P(DH, SHH)]: { body: { journeys: [one('overground', 'Windrush', ['Denmark Hill', DH], ['Shadwell', SHH], '08:50', '09:06')] } },
      [P(SHH, TO)]: { body: { journeys: [one('tube', 'District', ['Shadwell', SHH], ['Aldgate East', '940GZZLUADE'], '09:15', '09:25')] } },
    }));
    const saved = (await call('change_journey', { action: 'set_legs', from: FROM, at: AT, legs: LEGS, follow_as: 'commute' })).structuredContent;
    expect(saved).toMatchObject({ saved: 'new', tracking: { label: 'commute', planned_arrival: '2026-11-16T09:17:00+00:00' } });
    const changed = (await call('change_journey', { action: 'replace_leg', journey: 'commute', leg: 2, to: SHH })).structuredContent;
    expect(changed.leg_plan).toEqual([{ leg: 1, to: DH, by: 'walk' }, { leg: 2, to: SHH, by: 'windrush' }, { leg: 3, to: TO, by: 'district' }]);
    expect(changed.change).toMatchObject({ arrival_before: '2026-11-16T09:17:00+00:00', arrival_after: '2026-11-16T09:25:00+00:00', arrives_minutes_later: 8, legs_timed_again: 2 });
    expect(changed.tracking.planned_arrival).toBe('2026-11-16T09:25:00+00:00');
    // A change that cannot be timed leaves the saved journey as it was.
    const failed = (await call('change_journey', { action: 'replace_leg', journey: 'commute', leg: 2, by: 'jubilee' })).structuredContent;
    expect(failed).toMatchObject({ status: 'leg_failed', failed_leg: 2, unchanged: { journey: 'commute' } });
    expect((await call('follow_journey', { action: 'check', label: 'commute' })).structuredContent.leg_plan[1]).toEqual({ leg: 2, to: SHH, by: 'windrush' });
    expect((await call('change_journey', { journey: 'commute', leg: 3, action: 'remove_leg' })).structuredContent.status).toBe('invalid_change');
    expect((await call('change_journey', { action: 'replace_leg', journey: 'nothing', leg: 1, by: 'walk' })).structuredContent.status).toBe('not_tracking');
  });
});

describe('merged tools reject fields that belong to another action', () => {
  it('follow_journey and change_journey say what the action needs', async () => {
    const { call } = setup({ [NETWORK_STATUS]: { body: networkLines() } });
    const out = async (tool: string, args: object) => (await call(tool, args)).structuredContent;
    expect(await out('follow_journey', { action: 'start', from: FROM })).toMatchObject({ status: 'rejected', next_action: 'start needs both from and to.' });
    expect((await out('follow_journey', { action: 'check', from: FROM, to: TO })).next_action).toContain('takes only label');
    expect((await out('follow_journey', { action: 'end', exclude_modes: ['bus'] })).status).toBe('rejected');
    expect(await out('follow_journey', { action: 'end' })).toMatchObject({ status: 'not_tracking' });
    expect((await out('change_journey', { action: 'replace_leg', by: 'jubilee' })).next_action).toContain('needs leg');
    expect((await out('change_journey', { action: 'set_legs', from: FROM })).next_action).toBe('set_legs needs from and legs.');
    expect((await out('change_journey', { action: 'set_legs', from: FROM, legs: [{ to: TO, by: 'walk' }], leg: 1 })).status).toBe('rejected');
    expect((await out('change_journey', { action: 'remove_leg', leg: 1, legs: [{ to: TO, by: 'walk' }] })).status).toBe('rejected');
    expect((await call('follow_journey', { action: 'pause' })).isError).toBe(true);
  });
});

describe('get_context', () => {
  it('returns what the user has saved and what is true now, and nothing else', async () => {
    const lines = [...networkLines(), { ...lineWith('central', 'Central', { statusSeverity: 6, statusSeverityDescription: 'Severe Delays', reason: 'Signal failure.' }), modeName: 'tube' }];
    const { call } = setup({ [NETWORK_STATUS]: { body: lines } });
    await call('remember', { action: 'save_place', label: 'home', place: FROM });
    await call('remember', { action: 'set_preferences', avoid_modes: ['bus'] });
    const result = await call('get_context');
    const data = result.structuredContent;
    expect(data.clock).toEqual({ london_time: '2026-11-16T08:30:00+00:00', weekday: 'Monday' });
    expect(data.user).toEqual({ saved_places: [{ label: 'home', place: FROM }], avoid_modes: ['bus'], followed_journeys: [], not_durable: expect.stringContaining('lost when it restarts') });
    expect(data.feeds.tfl).toEqual({ state: 'ok' });
    expect(data.feeds.national_rail_live.state).toBe('not_configured');
    expect(data.network_now.london_lines_disrupted).toEqual([{ id: 'central', name: 'Central', mode: 'tube', status: 'Severe Delays', level: 'severe' }]);
    expect(data.network_now.national_rail_operators_disrupted).toEqual([{ id: 'south-western-railway', status: 'Special Service' }]);
    expect(data.owner_setup_pending.map((item: any) => item.missing)).toEqual(['RTT_TOKEN', 'DATA_DIR on a volume']);
    // No routing or wording advice: the tools describe themselves.
    expect(Object.keys(data).sort()).toEqual(['cache_max_age_seconds', 'checked_at', 'clock', 'feeds', 'network_now', 'owner_setup_pending', 'source', 'timezone', 'user']);
    expect(result.content[0].text.length).toBeLessThan(2600);
  });

  it('uses British Summer Time in the clock', async () => {
    const { call, advance } = setup({ [NETWORK_STATUS]: { body: networkLines() } });
    advance(Date.parse('2027-06-01T07:15:00Z') - Date.parse(AT));
    expect((await call('get_context')).structuredContent.clock.london_time).toBe('2027-06-01T08:15:00+01:00');
  });

  it('still answers when TfL is down, and says so', async () => {
    const { call } = setup({ [NETWORK_STATUS]: { status: 503, body: {} } });
    const result = await call('get_context');
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.feeds.tfl).toMatchObject({ state: 'failing' });
    expect(result.structuredContent).not.toHaveProperty('network_now');
  });

  it('confirms a working rail token', async () => {
    const { call } = railSetup({ '/api/get_access_token': TOKEN_REPLY });
    const data = (await call('get_context')).structuredContent;
    expect(data.feeds.national_rail_live).toMatchObject({ state: 'ok', allowance: { cache_seconds: 60 } });
    expect(data.owner_setup_pending.map((item: any) => item.missing)).toEqual(['DATA_DIR on a volume']);
  });
});

describe('show_journey', () => {
  const routes = { [JOURNEY_PATH]: { body: { journeys: [railRoute] } }, [NETWORK_STATUS]: { body: [
    { ...lineWith('windrush', 'Windrush', { statusSeverity: 9, statusSeverityDescription: 'Minor Delays', reason: 'Late finish of engineering work.' }), modeName: 'overground' },
    { ...lineWith('district', 'District', { statusSeverity: 10, statusSeverityDescription: 'Good Service' }), modeName: 'tube' },
    { ...lineWith('central', 'Central', { statusSeverity: 10, statusSeverityDescription: 'Good Service' }), modeName: 'tube' },
  ] } };

  it('links the tool to the journey card and serves the card as an MCP App resource', async () => {
    const { rpc } = setup(routes);
    const tool = (await rpc('tools/list')).tools.find((item: any) => item.name === 'show_journey');
    expect(tool._meta.ui.resourceUri).toBe('ui://london-transit-mcp/journey.html');
    expect((await rpc('resources/list')).resources).toEqual([expect.objectContaining({ uri: 'ui://london-transit-mcp/journey.html', mimeType: 'text/html;profile=mcp-app' })]);
    const [content] = (await rpc('resources/read', { uri: 'ui://london-transit-mcp/journey.html' })).contents;
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(content.text).toContain('ui/initialize');
    // The card must work inside the host's sandbox: nothing is loaded from elsewhere.
    expect(content.text).not.toMatch(/(src|href)\s*=\s*["']https?:/);
  });

  it('returns the plan with the status of the lines it uses', async () => {
    const { call } = setup(routes);
    const data = (await call('show_journey', { from: FROM, to: TO, at: AT, exclude_modes: ['bus'] })).structuredContent;
    expect(data).toMatchObject({ status: 'ok', mode_filter: { excluded: ['bus'], source: 'request' } });
    expect(data.line_status.map((line: any) => line.id).sort()).toEqual(['district', 'windrush']);
    expect(data.line_status.find((line: any) => line.id === 'windrush')).toMatchObject({ level: 'minor', status: 'Minor Delays' });
  });

  it('still shows the route when line status cannot be read', async () => {
    const { call } = setup({ [JOURNEY_PATH]: routes[JOURNEY_PATH]!, [NETWORK_STATUS]: { status: 503, body: {} } });
    const data = (await call('show_journey', { from: FROM, to: TO, at: AT })).structuredContent;
    expect(data).toMatchObject({ status: 'ok', line_status: [] });
  });
});
