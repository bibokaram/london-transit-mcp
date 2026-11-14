import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { normaliseName, placeForPlanner, resolveStation, stationFromRecord, stationsFirst } from '../src/stations.js';
import { TflClient } from '../src/tfl.js';
import { buildTimetable, dayLabel, JourneyPlannerSource, type LineRef, LineTimetableSource, scheduleDays, timetableSchema, weekdayOf } from '../src/timetable.js';
import { connectOAuth, fakeTfl, replayTfl } from './helpers.js';

const SECRET = 'test-only-not-a-production-credential';
const NOW = Date.parse('2026-11-11T15:00:00Z');
const LBG_ECR = { from: 'London Bridge', to: 'East Croydon', date: '2026-11-12', start_time: '14:00', end_time: '18:00' };

async function mcp(fetchImpl: typeof fetch) {
  const app = createApp({ fetch: fetchImpl, mcpSecret: SECRET, now: () => NOW });
  const { access_token } = await connectOAuth(app, SECRET);
  return async (name: string, args: unknown) => {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json() as any).result;
  };
}

const minute = (time: string) => Number(time.slice(3));

describe('timetable: London Bridge to East Croydon, Thu 12 Nov 2026, 14:00–18:00 (recorded TfL data)', () => {
  it('lists every direct train in one call, matching the planner pattern plus the trains the planner hides', async () => {
    const tfl = await replayTfl('timetable-lbg-ecr');
    const call = await mcp(tfl.fetch);
    const result = await call('timetable', LBG_ECR);
    const data = result.structuredContent;
    expect(result.isError).not.toBe(true);
    expect(tfl.missing).toEqual([]);
    expect(data).toMatchObject({
      source: 'TfL Unified API', timezone: 'Europe/London', cache_max_age_seconds: 3600, status: 'ok',
      from: { id: 'HUBLBG', name: 'London Bridge', input: 'London Bridge', matched_by: 'name' }, to: { id: 'HUBECY', name: 'East Croydon' },
      count: 56, services_truncated: false, schedule_basis: 'dated',
    });
    expect(data.unverified).toBeUndefined();

    const thameslink = data.services.filter((service: any) => service.operator === 'Thameslink');
    for (const hour of ['14', '15', '16']) {
      expect(thameslink.filter((service: any) => service.departure.startsWith(hour)).map((service: any) => minute(service.departure)))
        .toEqual([0, 5, 15, 21, 30, 35, 45, 51]);
    }
    const southern = (hour: string) => data.services.filter((service: any) => service.operator === 'Southern' && service.departure.startsWith(hour));
    // :07 Uckfield is what the planner returns; :10/:40 Caterham via Norwood Junction and the :01/:31 Tulse Hill loop
    // tie with or trail a faster Thameslink, so a plain planner sweep never shows them.
    expect(southern('15').map((service: any) => [service.departure, service.arrival, service.destination])).toEqual([
      ['15:01', '15:43', 'East Croydon'], ['15:07', '15:21', 'Uckfield'], ['15:10', '15:28', 'Caterham'], ['15:31', '16:13', 'East Croydon'], ['15:40', '15:58', 'Caterham'],
    ]);
    for (const hour of ['14', '15', '16', '17']) {
      expect(southern(hour).map((service: any) => minute(service.departure))).toEqual(expect.arrayContaining([7]));
    }
    for (const hour of ['14', '15', '16']) expect(southern(hour).map((service: any) => minute(service.departure))).toEqual(expect.arrayContaining([10, 40]));
    expect(thameslink.filter((service: any) => ['17:15', '17:35'].includes(service.departure))).toHaveLength(2);
    expect(data.services[0]).toEqual({ departure: '14:00', arrival: '14:15', duration_minutes: 15, stops: 1, operator: 'Thameslink', line: 'thameslink', mode: 'national-rail', destination: 'Horsham', platform: null });
    // The :01/:31 Southern trains end at East Croydon: one train calling at 12 stations via Tulse Hill, not two joined legs.
    expect(data.services.filter((service: any) => service.destination === 'East Croydon').map((service: any) => [service.departure, service.stops]))
      .toEqual([['14:01', 12], ['14:31', 12], ['15:01', 12], ['15:31', 12], ['16:01', 12], ['16:31', 12], ['17:01', 12], ['17:32', 12]]);
    expect(data.services.every((service: any) => service.departure >= '14:00' && service.departure < '18:00')).toBe(true);
    expect(data.per_hour.map((hour: any) => [hour.hour, hour.total, hour.by_operator])).toEqual([
      ['14:00', 13, { Thameslink: 8, Southern: 5 }], ['15:00', 13, { Thameslink: 8, Southern: 5 }],
      ['16:00', 13, { Thameslink: 8, Southern: 5 }], ['17:00', 17, { Thameslink: 10, Southern: 7 }],
    ]);
    expect(data.longest_gap).toEqual({ minutes: 9, after: '14:21', before: '14:30' });
  });

  it('states how the list was produced and what may be missing', async () => {
    const tfl = await replayTfl('timetable-lbg-ecr');
    const data = (await (await mcp(tfl.fetch))('timetable', LBG_ECR)).structuredContent;
    const planner = data.completeness.sources[0];
    expect(data.completeness.complete).toBe(true);
    expect(planner).toMatchObject({ source: 'tfl-journey-planner', modes: ['national-rail'], calls: 36, from_cache: 0, schedule_basis: 'dated' });
    expect(planner.passes.map((pass: any) => [pass.via?.name ?? null, pass.stopped])).toEqual([
      [null, 'window_end'], ['Brockley', 'window_end'], ['New Cross Gate', 'window_end'], ['Norwood Junction', 'window_end'], ['South Bermondsey', 'window_end'],
    ]);
    expect(planner.caveats).toBeUndefined();
    expect(data.completeness.platforms).toContain('platform is null');
  });

  it('filters by operator without dropping hidden trains, and repeats from cache without new requests', async () => {
    const tfl = await replayTfl('timetable-lbg-ecr');
    const call = await mcp(tfl.fetch);
    const data = (await call('timetable', { ...LBG_ECR, operators: ['Southern'] })).structuredContent;
    expect(new Set(data.services.map((service: any) => service.operator))).toEqual(new Set(['Southern']));
    expect(data.count).toBe(22);
    expect(data.per_hour.map((hour: any) => hour.total)).toEqual([5, 5, 5, 7]);
    expect(data.longest_gap).toEqual({ minutes: 21, after: '14:10', before: '14:31' });
    const before = tfl.calls.length;
    const again = (await call('timetable', { ...LBG_ECR, operators: ['Southern'] })).structuredContent;
    expect(tfl.calls.length).toBe(before);
    expect(again.completeness.sources[0].from_cache).toBe(again.completeness.sources[0].calls);
  });

  it('resolves CRS codes on their own lookup and reports that the sweep came from cache', async () => {
    const recorded = await replayTfl('timetable-lbg-ecr');
    // TfL answers a rail station ID with its interchange record, as recorded for the name lookup.
    const hubFor: Record<string, string> = { '/StopPoint/910GLNDNBDC': '/StopPoint/HUBLBG', '/StopPoint/910GECROYDN': '/StopPoint/HUBECY' };
    const lookups: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (hubFor[url.pathname]) { lookups.push(url.pathname); url.pathname = hubFor[url.pathname]!; }
      return recorded.fetch(url, init);
    }) as typeof fetch;
    const call = await mcp(fetchImpl);
    const byName = (await call('timetable', LBG_ECR)).structuredContent;
    expect(byName.completeness.sources[0].from_cache).toBe(0);
    const byCrs = (await call('timetable', { ...LBG_ECR, from: 'LBG', to: 'ECR' })).structuredContent;
    expect(lookups).toEqual(['/StopPoint/910GLNDNBDC', '/StopPoint/910GECROYDN']);
    expect(byCrs).toMatchObject({ count: 56, from: { input: 'LBG', matched_by: 'crs', id: 'HUBLBG' }, to: { input: 'ECR', matched_by: 'crs' } });
    expect(byCrs.completeness.sources[0].from_cache).toBe(36);
  });

  it('lists unknown operators back instead of returning an empty timetable silently', async () => {
    const tfl = await replayTfl('timetable-lbg-ecr');
    const data = (await (await mcp(tfl.fetch))('timetable', { ...LBG_ECR, operators: ['Thameslink', 'Avanti'] })).structuredContent;
    expect(data.unknown_operators).toEqual(['Avanti']);
    expect(data.services.every((service: any) => service.operator === 'Thameslink')).toBe(true);
    const none = (await (await mcp(tfl.fetch))('timetable', { ...LBG_ECR, operators: ['Avanti'] })).structuredContent;
    expect(none).toMatchObject({ status: 'no_direct_line', unknown_operators: ['Avanti'] });
    expect(none.lines_at_both.map((line: any) => line.id)).toEqual(['southeastern', 'southern', 'thameslink']);
  });
});

describe('timetable: Line Timetable modes (recorded TfL data)', () => {
  it('reads the Tube from TfL Line Timetable for the right day type, with a CRS destination', async () => {
    const tfl = await replayTfl('timetable-victoria-line');
    const data = (await (await mcp(tfl.fetch))('timetable', { from: 'Brixton', to: 'VIC', date: '2026-11-12', start_time: '08:00', end_time: '09:00', operators: ['victoria'] })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data).toMatchObject({ status: 'ok', count: 36, to: { name: 'Victoria', matched_by: 'crs' }, schedule_basis: 'standard_weekly' });
    expect(data.services[0]).toEqual({ departure: '08:00', arrival: '08:07', duration_minutes: 7, stops: 4, operator: 'Victoria', line: 'victoria', mode: 'tube', destination: 'Walthamstow Central', platform: null });
    expect(data.completeness.sources).toEqual([expect.objectContaining({ source: 'tfl-line-timetable', schedule_basis: 'standard_weekly', schedule: 'Mon–Thu', tfl_schedule_name: 'Monday - Thursday', complete: true })]);
    expect(tfl.calls.some((url) => url.pathname.startsWith('/Journey/'))).toBe(false);
  });

  it('labels the Waterloo & City the same way and says it is the standard weekly timetable', async () => {
    const tfl = await replayTfl('timetable-waterloo-city');
    const data = (await (await mcp(tfl.fetch))('timetable', { from: 'Waterloo', to: 'Bank', date: '2026-11-12', start_time: '08:00', end_time: '09:00', operators: ['waterloo-city'] })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data).toMatchObject({ status: 'ok', count: 18, schedule_basis: 'standard_weekly' });
    expect(data.services[0]).toMatchObject({ operator: 'Waterloo & City', destination: 'Bank', duration_minutes: 4, stops: 1 });
    expect(data.completeness.sources[0]).toMatchObject({ schedule: 'Mon–Fri', tfl_schedule_name: 'Monday - Friday', schedule_basis: 'standard_weekly' });
    expect(data.completeness.sources[0].note).toContain('not this date');
  });

  it('matches TfL schedule names to weekdays and labels them consistently', () => {
    expect(dayLabel(scheduleDays('Monday - Thursday'))).toBe('Mon–Thu');
    expect(dayLabel(scheduleDays('Monday to Friday'))).toBe('Mon–Fri');
    expect(dayLabel(scheduleDays('Saturdays and Public Holidays'))).toBe('Sat');
    expect(dayLabel(scheduleDays('Saturday and Sunday'))).toBe('Sat–Sun');
    expect(dayLabel(new Set([0, 2]))).toBe('Mon, Wed');
    expect([...scheduleDays('Monday - Thursday')]).toEqual([0, 1, 2, 3]);
    expect([...scheduleDays('Monday to Friday')]).toEqual([0, 1, 2, 3, 4]);
    expect([...scheduleDays('Saturday (also Good Friday)')]).toEqual([5]);
    expect([...scheduleDays('Saturdays and Public Holidays')]).toEqual([5]);
    expect([...scheduleDays('Saturday and Sunday')]).toEqual([5, 6]);
    expect([...scheduleDays('Sunday and other Public Holidays')]).toEqual([6]);
    expect(weekdayOf('2026-11-12')).toBe(3);
    expect(weekdayOf('2026-11-15')).toBe(6);
  });

  it('hands a line with no Line Timetable to the journey planner', async () => {
    const line: LineRef = { id: 'victoria', name: 'Victoria', mode: 'tube', fromStop: 'A', toStop: 'B' };
    const tfl = new TflClient(fakeTfl({ '/Line/victoria/Timetable/A/to/B': { status: 404, body: { message: 'No timetable found.' } } }).fetch, undefined, () => NOW);
    const result = await new LineTimetableSource(tfl).collect({ from: { id: 'A', name: 'A', icsCode: null, stops: [] }, to: { id: 'B', name: 'B', icsCode: null, stops: [] }, lines: [line], date: '2026-11-12', start: 480, end: 540 });
    expect(result.unserved).toEqual([line]);
    expect(result.reports[0]).toMatchObject({ complete: false, outcome: 'no_timetable' });
  });
});

describe('timetable: journey planner sweep', () => {
  const leg = (time: string, operator = 'Thameslink', over: Record<string, unknown> = {}) => ({
    duration: 15, departureTime: `2026-11-12T${time}:00`, arrivalTime: `2026-11-12T${time.slice(0, 3)}${String(Number(time.slice(3)) + 15).padStart(2, '0')}:00`,
    mode: { id: 'national-rail' }, routeOptions: [{ name: operator, directions: ['Brighton Rail Station'], lineIdentifier: { id: operator.toLowerCase() } }],
    path: { stopPoints: [{ id: 'M', name: 'Middle' }, { id: 'Y', name: 'Y' }] },
    ...over,
  });
  const journeys = (...times: string[]) => ({ journeys: times.map((time) => ({ startDateTime: `2026-11-12T${time}:00`, legs: [leg(time)] })) });
  const station = (id: string) => ({ id, name: id, icsCode: id, stops: [] });
  const line: LineRef = { id: 'thameslink', name: 'Thameslink', mode: 'national-rail', fromStop: 'X', toStop: 'Y' };

  it('advances from just after the last departure and keeps only single-train journeys', async () => {
    const responses: Record<string, unknown> = {
      '1400': journeys('14:00', '14:05', '14:15'),
      '1416': { journeys: [{ startDateTime: '2026-11-12T14:20:00', legs: [leg('14:20'), leg('14:40')] }, ...journeys('14:30', '14:45').journeys] },
      '1446': journeys('14:50', '15:00', '15:10'),
    };
    const fake = fakeTfl({ '/Journey/JourneyResults/X/to/Y': () => ({ body: responses[new URL(fake.calls.at(-1)!).searchParams.get('time')!] ?? { journeys: [] } }) });
    const tfl = new TflClient(fake.fetch, undefined, () => NOW);
    const result = await new JourneyPlannerSource(tfl, 0).collect({ from: station('X'), to: station('Y'), lines: [line], date: '2026-11-12', start: 840, end: 900 });
    expect(result.services.map((service) => service.departure).sort()).toEqual(['14:00', '14:05', '14:15', '14:30', '14:45', '14:50']);
    expect(fake.calls.filter((url) => url.pathname.startsWith('/Journey/')).map((url) => url.searchParams.get('time'))).toEqual(['1400', '1416', '1446']);
    expect(result.reports[0]).toMatchObject({ complete: true, calls: 3 });
  });

  it('waits and retries once on a rate limit, and reports an incomplete list if TfL keeps refusing', async () => {
    let count = 0;
    const flaky = fakeTfl({ '/Journey/JourneyResults/X/to/Y': () => (++count === 1 ? { status: 429 } : { body: journeys('14:00', '14:20', '14:40') }) });
    const ok = await new JourneyPlannerSource(new TflClient(flaky.fetch, undefined, () => NOW), 0)
      .collect({ from: station('X'), to: station('Y'), lines: [line], date: '2026-11-12', start: 840, end: 900 });
    expect(ok.services).toHaveLength(3);
    expect(ok.reports[0]!.complete).toBe(true);

    const refusing = fakeTfl({ '/Journey/JourneyResults/X/to/Y': { status: 429 } });
    const failed = await new JourneyPlannerSource(new TflClient(refusing.fetch, undefined, () => NOW), 0)
      .collect({ from: station('X'), to: station('Y'), lines: [line], date: '2026-11-12', start: 840, end: 900 });
    expect(failed.reports[0]).toMatchObject({ complete: false, caveats: [expect.stringContaining('rate limited')] });
  });

  it('keeps a train only if it is one train with a named terminus whose calling points reach the arrival station', async () => {
    const body = { journeys: [
      { startDateTime: '2026-11-12T14:00:00', legs: [leg('14:00')] },
      { startDateTime: '2026-11-12T14:10:00', legs: [leg('14:10', 'Southern', { routeOptions: [{ name: 'Southern', directions: [], lineIdentifier: { id: 'southern' } }] })] },
      { startDateTime: '2026-11-12T14:20:00', legs: [leg('14:20', 'Southern', { path: { stopPoints: [{ id: 'M' }, { id: 'Z' }] } })] },
    ] };
    const fake = fakeTfl({ '/Journey/JourneyResults/X/to/Y': { body } });
    const result = await new JourneyPlannerSource(new TflClient(fake.fetch, undefined, () => NOW), 0)
      .collect({ from: station('X'), to: station('Y'), lines: [line], date: '2026-11-12', start: 840, end: 900 });
    expect(result.services.map((service) => [service.departure, service.destination, service.stops])).toEqual([['14:00', 'Brighton', 2]]);
    expect(result.unverified).toEqual([
      { departure: '14:10', operator: 'Southern', line: 'southern', reason: 'TfL gives no terminus for this train' },
      { departure: '14:20', operator: 'Southern', line: 'southern', reason: 'its calling points do not end at the arrival station' },
    ]);
  });

  it('marks the list incomplete when a pass stops before the window ends or a route sequence cannot be read', async () => {
    let minute = 840;
    const creeping = fakeTfl({ '/Journey/JourneyResults/X/to/Y': () => ({ body: journeys(clockOf(minute++)) }) });
    const capped = await new JourneyPlannerSource(new TflClient(creeping.fetch, undefined, () => NOW), 0)
      .collect({ from: station('X'), to: station('Y'), lines: [line], date: '2026-11-12', start: 840, end: 900 });
    expect(capped.reports[0]).toMatchObject({ complete: false, passes: [{ stopped: 'call_cap', searched_to: '14:39' }], caveats: [expect.stringContaining('stopped at 14:39, before 15:00')] });

    const noSequence = fakeTfl({ '/Journey/JourneyResults/X/to/Y': { body: journeys('14:00', '14:30', '15:00') }, '/Line/thameslink/Route/Sequence/outbound': { status: 500 } });
    const blind = await new JourneyPlannerSource(new TflClient(noSequence.fetch, undefined, () => NOW), 0)
      .collect({ from: station('X'), to: station('Y'), lines: [line], date: '2026-11-12', start: 840, end: 900 });
    expect(blind.reports[0]).toMatchObject({ complete: false, caveats: [expect.stringContaining('Thameslink outbound route sequence could not be read')] });
  });
});

const clockOf = (total: number) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

describe('timetable: other recorded routes', () => {
  it('resolves Gatwick Airport to its rail station, so via passes run and Horsham trains appear beside Brighton ones', async () => {
    const tfl = await replayTfl('timetable-lbg-gatwick');
    const data = (await (await mcp(tfl.fetch))('timetable', { from: 'London Bridge', to: 'Gatwick Airport', date: '2026-11-12', start_time: '14:00', end_time: '16:00' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data.to).toEqual({ id: '910GGTWK', name: 'London Gatwick Airport', input: 'Gatwick Airport', matched_by: 'name' });
    const at = (destination: string) => data.services.filter((service: any) => service.destination === destination).map((service: any) => service.departure);
    expect(at('Brighton')).toEqual(['14:05', '14:15', '14:35', '14:45', '15:05', '15:15', '15:35', '15:45']);
    expect(at('Horsham')).toEqual(['14:00', '14:30', '15:00', '15:30']);
    expect(at('Three Bridges')).toEqual(['14:21', '14:51', '15:21', '15:51']);
    expect(data.completeness.sources[0].passes.map((pass: any) => pass.via?.name ?? null)).toEqual([null, 'Coulsdon South', 'New Cross Gate', 'Norwood Junction']);
    expect(data.completeness.complete).toBe(true);
  });

  it('lists Sunday 15 Nov East Croydon to London Bridge as the four trains TfL plans that day, each one train via Tulse Hill', async () => {
    const tfl = await replayTfl('timetable-ecr-lbg-sunday');
    const data = (await (await mcp(tfl.fetch))('timetable', { from: 'ECR', to: 'LBG', date: '2026-11-15', start_time: '10:00', end_time: '12:00' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data.services.map((service: any) => [service.departure, service.duration_minutes, service.stops, service.destination])).toEqual([
      ['10:18', 44, 12, 'London Bridge'], ['10:48', 44, 12, 'London Bridge'], ['11:18', 45, 12, 'London Bridge'], ['11:48', 44, 12, 'London Bridge'],
    ]);
    // The Norwood Junction pass ran to the end of the window and found no through train: the fast line is closed that day.
    expect(data.completeness.sources[0].passes.find((pass: any) => pass.via?.name === 'Norwood Junction')).toMatchObject({ services_found: 0, stopped: 'window_end' });
    expect(data.completeness.complete).toBe(true);
  });
});

describe('timetable: QA fixes, 12 Nov 2026 (recorded TfL data)', () => {
  const PAD_LST = { from: 'Paddington', to: 'Liverpool Street', date: '2026-11-19', start_time: '08:00', end_time: '09:00' };

  it('verifies Elizabeth line trains whose last calling point has no ID by the leg\'s arrival ICS code', async () => {
    // TfL leaves the ID off Liverpool Street (910GLIVSTLL) in path.stopPoints; arrivalPoint still carries ICS 1000138.
    const tfl = await replayTfl('tt-pad-lst');
    const call = await mcp(tfl.fetch);
    const data = (await call('timetable', PAD_LST)).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data.unverified).toBeUndefined();
    const elizabeth = data.services.filter((service: any) => service.line === 'elizabeth');
    expect(elizabeth).toHaveLength(24);
    expect(elizabeth[0]).toEqual({ departure: '08:01', arrival: '08:12', duration_minutes: 11, stops: 4, operator: 'Elizabeth line', line: 'elizabeth', mode: 'elizabeth-line', destination: 'Shenfield', platform: null });
    expect(new Set(data.services.map((service: any) => service.line))).toEqual(new Set(['elizabeth', 'circle', 'hammersmith-city']));
    expect(data.completeness.complete).toBe(true);

    const byId = (await call('timetable', { ...PAD_LST, to: '910GLIVSTLL', operators: ['elizabeth'] })).structuredContent;
    expect(byId).toMatchObject({ status: 'ok', count: 24, to: { id: 'HUBLST', matched_by: 'stop_id' } });
    expect(byId.completeness.complete).toBe(true);
  });

  it('marks the list incomplete when trains are unverified, and filters them by line ID like services', async () => {
    const tfl = await replayTfl('tt-pad-lst');
    const client = new TflClient(tfl.fetch, undefined, () => NOW);
    const source = {
      id: 'stub', handles: () => true,
      collect: async () => ({
        services: [], unserved: [], reports: [{ source: 'stub', lines: ['elizabeth'], complete: true, schedule_basis: 'dated' }],
        unverified: [{ departure: '08:01', operator: 'Elizabeth line', line: 'elizabeth', reason: 'its calling points do not end at the arrival station' }],
      }),
    };
    const data: any = await buildTimetable(client, { ...PAD_LST, operators: ['elizabeth'] }, [source]);
    expect(data.unverified).toEqual([expect.objectContaining({ departure: '08:01', line: 'elizabeth' })]);
    expect(data.completeness).toMatchObject({ complete: false, unverified_trains: 1 });
    expect(data.unverified_note).toContain('may be real');
    // No dated services listed, so no platform note.
    expect(data.completeness.platforms).toBeUndefined();
    const circle: any = await buildTimetable(client, { ...PAD_LST, operators: ['circle'] }, [source]);
    expect(circle.unverified).toBeUndefined();
    expect(circle.completeness.complete).toBe(true);
  });

  it('includes stations nested inside another station of a hub: Thameslink at Wimbledon', async () => {
    const tfl = await replayTfl('tt-wimbledon-tooting');
    const resolved = await resolveStation(new TflClient(tfl.fetch, undefined, () => NOW), 'Wimbledon');
    expect(resolved.status === 'ok' && resolved.station.stops.map((stop) => stop.id)).toEqual(expect.arrayContaining(['910GWDON', '910GWIMBLDN']));
    const data = (await (await mcp(tfl.fetch))('timetable', { from: 'Wimbledon', to: 'Tooting', date: '2026-11-19', start_time: '08:00', end_time: '09:00' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data).toMatchObject({ status: 'ok', from: { id: 'HUBWIM' }, count: 2 });
    expect(data.services.map((service: any) => [service.departure, service.operator, service.stops])).toEqual([['08:07', 'Thameslink', 2], ['08:37', 'Thameslink', 2]]);
  });

  it('retries a via pass the planner split, and finds Saturday\'s Southern trains via Tulse Hill', async () => {
    // Via Selhurst, the planner ends the 10:20 to London Bridge at Selhurst and changes to a faster route from there.
    const tfl = await replayTfl('tt-ecr-lbg-saturday');
    const data = (await (await mcp(tfl.fetch))('timetable', { from: 'East Croydon', to: 'London Bridge', date: '2026-11-14', start_time: '10:00', end_time: '12:00' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data.services.filter((service: any) => service.stops === 12).map((service: any) => [service.departure, service.operator, service.destination]))
      .toEqual([['10:20', 'Southern', 'London Bridge'], ['10:52', 'Southern', 'London Bridge'], ['11:20', 'Southern', 'London Bridge'], ['11:52', 'Southern', 'London Bridge']]);
    const passes = data.completeness.sources[0].passes;
    expect(passes.map((pass: any) => [pass.via?.name ?? null, pass.retry_of ?? null, pass.services_found, pass.split_at_via ?? null])).toEqual([
      [null, null, 22, null], ['New Cross Gate', null, 0, 0], ['Norwood Junction', null, 8, 0], ['Selhurst', null, 0, 4], ['Anerley', null, 0, 0], ['Tulse Hill', 'Selhurst', 4, 0],
    ]);
    expect(data.count).toBe(26);
    expect(data.completeness.complete).toBe(true);
  });

  it('shows the station typed inside a hub, and leaves out the platform note for timetable-only results', async () => {
    const tfl = await replayTfl('tt-cable-car');
    const data = (await (await mcp(tfl.fetch))('timetable', { from: 'Royal Docks', to: 'Greenwich Peninsula', date: '2026-11-19', start_time: '10:00', end_time: '11:00' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data.from).toEqual({ id: 'HUBRVC', name: 'Royal Docks', input: 'Royal Docks', matched_by: 'name' });
    expect(data.to).toMatchObject({ id: 'HUBNGW', name: 'Greenwich Peninsula' });
    expect(data).toMatchObject({ status: 'ok', count: 6, schedule_basis: 'standard_weekly' });
    expect(data.completeness.platforms).toBeUndefined();
  });

  it('flags truncated candidates for an unclear name', async () => {
    const tfl = await replayTfl('tt-bridge');
    const data = (await (await mcp(tfl.fetch))('timetable', { from: 'Bridge', to: 'East Croydon', date: '2026-11-19', start_time: '08:00', end_time: '09:00' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data.status).toBe('needs_disambiguation');
    expect(data.from).toMatchObject({ status: 'ambiguous', truncated: true });
    expect(data.from.candidates).toHaveLength(8);
  });

  it('tells a line that serves only one station apart from a name that matches no line there', async () => {
    const tfl = await replayTfl('timetable-lbg-ecr');
    const data = (await (await mcp(tfl.fetch))('timetable', { ...LBG_ECR, operators: ['Jubilee', 'Avanti'] })).structuredContent;
    expect(data).toMatchObject({
      status: 'no_direct_line', unknown_operators: ['Avanti'],
      operators_not_serving_both: [{ operator: 'Jubilee', line: 'jubilee', name: 'Jubilee', serves_only: 'London Bridge' }],
    });
    expect(data.operators_note).toContain('call at only one');
  });

  it('collapses runs of whitespace in station names', () => {
    const station = stationFromRecord({ id: 'HUBWAT', commonName: 'Waterloo Station   / York Road', children: [
      { id: '940GZZLUWLO', modes: ['tube'], lines: [{ id: 'jubilee', name: 'Jubilee' }] },
    ] });
    expect(station.name).toBe('Waterloo Station / York Road');
  });
});

describe('timetable: via pass split by the planner', () => {
  const ride = (time: string, lastStop: string, terminus: string) => ({
    duration: 20, departureTime: `2026-11-12T${time}:00`, arrivalTime: `2026-11-12T${time.slice(0, 3)}${String(Number(time.slice(3)) + 20).padStart(2, '0')}:00`,
    mode: { id: 'national-rail' }, routeOptions: [{ name: 'Southern', directions: [terminus], lineIdentifier: { id: 'southern' } }],
    path: { stopPoints: [{ id: lastStop, name: lastStop }] },
  });
  const station = (id: string) => ({ id, name: id, icsCode: id, stops: [] });
  const line: LineRef = { id: 'southern', name: 'Southern', mode: 'national-rail', fromStop: 'X', toStop: 'Y' };
  const sequence = { body: {
    orderedLineRoutes: [{ naptanIds: ['X', 'A1', 'A2', 'A3', 'Y'] }],
    stopPointSequences: [{ stopPoint: ['X', 'A1', 'A2', 'A3'].map((id) => ({ id, name: `${id} Rail Station` })).concat({ id: 'Y', name: 'Y Rail Station' }) }],
  } };
  const run = (viaA2: unknown) => {
    const fake = fakeTfl({
      '/Line/southern/Route/Sequence/outbound': sequence,
      '/Journey/JourneyResults/X/to/Y': () => {
        const params = fake.calls.at(-1)!.searchParams;
        if (params.get('time') !== '1400') return { body: { journeys: [] } };
        if (params.get('via') === 'A1') return { body: { journeys: [{ startDateTime: '2026-11-12T14:20:00', legs: [ride('14:20', 'A1', 'Y Rail Station'), ride('14:30', 'Y', 'Z Rail Station')] }] } };
        if (params.get('via') === 'A2') return { body: viaA2 };
        return { body: { journeys: [] } };
      },
    });
    return new JourneyPlannerSource(new TflClient(fake.fetch, undefined, () => NOW), 0)
      .collect({ from: station('X'), to: station('Y'), lines: [line], date: '2026-11-12', start: 840, end: 900 });
  };

  it('retries through a stop nearer the corridor middle, and reports incomplete if that pass finds nothing either', async () => {
    const missed = await run({ journeys: [] });
    expect((missed.reports[0]!.passes as any[]).map((pass) => [pass.via?.id ?? null, pass.retry_of ?? null, pass.split_at_via ?? null])).toEqual([
      [null, null, null], ['A1', null, 1], ['A2', 'A1', 0],
    ]);
    expect(missed.reports[0]).toMatchObject({ complete: false, caveats: [expect.stringContaining('split them there and again at A2')] });

    const found = await run({ journeys: [{ startDateTime: '2026-11-12T14:20:00', legs: [{ ...ride('14:20', 'Y', 'Y Rail Station'), path: { stopPoints: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }, { id: 'Y' }] } }] }] });
    expect(found.services.map((service) => [service.departure, service.stops, service.destination])).toEqual([['14:20', 4, 'Y']]);
    expect(found.reports[0]).toMatchObject({ complete: true });
    expect(found.reports[0]!.caveats).toBeUndefined();
  });
});

describe('timetable: inputs and station resolution', () => {
  it.each([
    { ...LBG_ECR, end_time: '20:01' },
    { ...LBG_ECR, end_time: '13:00' },
    { ...LBG_ECR, date: '12/11/2026' },
    { ...LBG_ECR, start_time: '2pm' },
    { ...LBG_ECR, operators: [] },
    { ...LBG_ECR, extra: true },
  ])('rejects %j before any TfL request', async (args) => {
    const tfl = fakeTfl({});
    const result = await (await mcp(tfl.fetch))('timetable', args);
    expect(result.isError).toBe(true);
    expect(timetableSchema.safeParse(args).success).toBe(false);
    expect(tfl.calls).toHaveLength(0);
  });

  it('resolves names among stations only, CRS codes through the NaPTAN table, and asks when a name is unclear', async () => {
    const hub = { id: 'HUBLBG', commonName: 'London Bridge', icsCode: '1000139', modes: ['bus', 'national-rail', 'tube'],
      lineModeGroups: [{ modeName: 'national-rail', lineIdentifier: ['southern'] }, { modeName: 'tube', lineIdentifier: ['jubilee'] }, { modeName: 'bus', lineIdentifier: ['43'] }],
      children: [
        { id: '490G000970', modes: ['bus'], lines: [{ id: '43', name: '43' }] },
        { id: '910GLNDNBDC', modes: ['national-rail'], lines: [{ id: 'southern', name: 'Southern' }] },
        { id: '940GZZLULNB', modes: ['tube'], lines: [{ id: 'jubilee', name: 'Jubilee' }] },
      ] };
    const tfl = fakeTfl({
      '/StopPoint/910GLNDNBDC': { body: hub },
      '/StopPoint/HUBLBG': { body: hub },
      '/StopPoint/Search/london%20bridge': { body: { matches: [{ id: 'HUBLBG', name: 'London Bridge', modes: ['national-rail', 'tube'], icsId: '1000139' }] } },
      '/StopPoint/Search/croydon': { body: { matches: [{ id: 'HUBECY', name: 'East Croydon', modes: ['national-rail'] }, { id: 'HUBWCY', name: 'West Croydon', modes: ['overground'] }] } },
    });
    const client = new TflClient(tfl.fetch, undefined, () => NOW);
    const byCrs = await resolveStation(client, 'LBG');
    expect(byCrs).toMatchObject({ status: 'ok', matched_by: 'crs', station: { id: 'HUBLBG', icsCode: '1000139' } });
    expect(byCrs.status === 'ok' && byCrs.station.stops.map((stop) => stop.id)).toEqual(['910GLNDNBDC', '940GZZLULNB']);
    expect(await resolveStation(client, 'London Bridge')).toMatchObject({ status: 'ok', matched_by: 'name' });
    expect(tfl.calls.find((url) => url.pathname.startsWith('/StopPoint/Search/'))!.searchParams.get('modes'))
      .toBe('tube,elizabeth-line,overground,dlr,tram,national-rail,river-bus,cable-car');
    expect(await resolveStation(client, 'Croydon')).toEqual({ status: 'ambiguous', candidates: [
      { id: 'HUBECY', name: 'East Croydon', modes: ['national-rail'] }, { id: 'HUBWCY', name: 'West Croydon', modes: ['overground'] },
    ], truncated: false });
    const data = await buildTimetable(client, { ...LBG_ECR, to: 'Croydon' });
    expect(data).toMatchObject({ status: 'needs_disambiguation', to: { status: 'ambiguous' } });
    expect(tfl.calls.some((url) => url.pathname.startsWith('/Journey/'))).toBe(false);
  });

  it('normalises station names for exact matching', () => {
    expect(normaliseName("King's Cross St. Pancras Underground Station")).toBe('kings cross st pancras');
    expect(normaliseName('East Croydon Tram Stop')).toBe('east croydon');
    expect(normaliseName('Elephant & Castle')).toBe('elephant and castle');
  });
});

describe('plan_journey station resolution (recorded TfL data)', () => {
  it('plans "London Bridge" to "East Croydon" from the stations, without disambiguation', async () => {
    const tfl = await replayTfl('plan-lbg-ecr');
    const data = (await (await mcp(tfl.fetch))('plan_journey', { from: 'London Bridge', to: 'East Croydon', at: '2026-11-12T14:00:00Z' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data.status).toBe('ok');
    expect(data.resolved).toEqual({
      from: { input: 'London Bridge', used: '1000139', name: 'London Bridge', resolved_by: 'station_name' },
      to: { input: 'East Croydon', used: '1001089', name: 'East Croydon', resolved_by: 'station_name' },
    });
    expect(data.routes.map((route: any) => [route.departure, route.legs.at(-1).lines[0]])).toEqual([
      ['2026-11-12T14:00:00+00:00', 'Thameslink'], ['2026-11-12T14:05:00+00:00', 'Thameslink'], ['2026-11-12T14:07:00+00:00', 'Southern'],
    ]);
  });

  it('accepts HUB IDs instead of reading them as street names', async () => {
    const tfl = await replayTfl('plan-hub-ids');
    const data = (await (await mcp(tfl.fetch))('plan_journey', { from: 'HUBLBG', to: 'HUBECY', at: '2026-11-12T14:00:00Z' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(data.status).toBe('ok');
    expect(data.resolved.from).toEqual({ input: 'HUBLBG', used: '1000139', name: 'London Bridge', resolved_by: 'hub_id' });
    expect(tfl.calls.find((url) => url.pathname.startsWith('/Journey/'))!.pathname).toBe('/Journey/JourneyResults/1000139/to/1001089');
  });

  it('passes postcodes, coordinates, IDs and unmatched places through unchanged', async () => {
    const tfl = fakeTfl({ '/StopPoint/Search/hyde%20park': { body: { matches: [{ id: 'HUBHPC', name: 'Hyde Park Corner', modes: ['tube'], icsId: '1000115' }] } } });
    const client = new TflClient(tfl.fetch, undefined, () => NOW);
    for (const place of ['SW1A 1AA', '51.5,-0.12', '910GLNDNBDC', '1000139']) {
      expect(await placeForPlanner(client, place)).toEqual({ input: place, value: place });
    }
    // A partial match is not chosen, but kept to offer if TfL asks which place was meant.
    expect(await placeForPlanner(client, 'Hyde Park')).toEqual({ input: 'Hyde Park', value: 'Hyde Park', stations: [{ value: '1000115', name: 'Hyde Park Corner', modes: ['tube'] }] });
    expect(tfl.calls.map((url) => url.pathname)).toEqual(['/StopPoint/Search/hyde%20park']);
  });

  it('offers the stations "Bridge" matches ahead of the streets TfL suggests, from the same three requests', async () => {
    const tfl = await replayTfl('plan-bridge-victoria');
    const data = (await (await mcp(tfl.fetch))('plan_journey', { from: 'Bridge', to: 'Victoria', at: '2026-11-12T14:00:00Z' })).structuredContent;
    expect(tfl.missing).toEqual([]);
    expect(tfl.calls).toHaveLength(3);
    expect(data.status).toBe('needs_disambiguation');
    expect(data.resolved).toEqual({ from: { input: 'Bridge', used: 'Bridge' }, to: { input: 'Victoria', used: '1000248', name: 'Victoria', resolved_by: 'station_name' } });
    expect(data).not.toHaveProperty('to');
    expect(data.from.options.slice(0, 5).map((option: any) => [option.value, option.name])).toEqual([
      ['1000224', 'Stonebridge Park'], ['1000139', 'London Bridge'], ['1000130', 'Knightsbridge'], ['1001044', 'Cambridge Heath (London)'], ['1001349', 'Lea Bridge'],
    ]);
    expect(data.from.options[5]).toMatchObject({ name: 'Datchet, Bridges', modes: [] });
    expect(data.from.truncated).toBe(true);
  });

  it('says a date past the planner\'s range is the problem, not TfL being down', async () => {
    const tfl = await replayTfl('plan-far-future');
    const response = await (await mcp(tfl.fetch))('plan_journey', { from: 'Bank', to: 'Paddington', at: '2027-03-01T09:00:00Z' });
    expect(tfl.missing).toEqual([]);
    expect(response.isError).toBe(true);
    expect(response.structuredContent.error).toMatchObject({ code: 'invalid_travel_time', retryable: false });
    expect(response.structuredContent.error.message).toContain('outside TfL\'s planning range');
  });

  it('lists station candidates ahead of streets and businesses when TfL asks which place was meant', () => {
    const options = [
      { name: 'City of London, London Bridge', modes: ['bus'] },
      { name: 'London Bridge Hotel', modes: [] },
      { name: 'London Bridge Station', modes: ['national-rail', 'tube', 'bus'] },
    ];
    expect(stationsFirst(options).map((option) => option.name)).toEqual(['London Bridge Station', 'City of London, London Bridge', 'London Bridge Hotel']);
  });
});
