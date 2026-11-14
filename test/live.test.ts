import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { liveDepartures } from '../src/live.js';
import { cleanStationName, TflClient } from '../src/tfl.js';
import { fakeTfl, prediction, replayTfl } from './helpers.js';

/** Replays a recorded board at the instant it was recorded, so minutes match what TfL said then. */
async function board(name: string, query: { stop_id: string; line?: string; direction?: string; limit?: number }) {
  const at = Date.parse(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')).recorded_at);
  const replay = await replayTfl(name);
  const data = await liveDepartures(new TflClient(replay.fetch, undefined, () => at), undefined, { limit: 20, ...query }) as any;
  expect(replay.missing).toEqual([]);
  return { data, at, calls: replay.calls.map((url) => `${url.pathname}${url.search}`) };
}

describe('live_departures from recorded TfL boards (12 Nov 2026)', () => {
  it('adds Thameslink at London Bridge to the Tube board and names the operators still missing', async () => {
    const { data, calls } = await board('live-hub-lbg', { stop_id: 'HUBLBG' });
    const lines = new Set(data.arrivals.map((arrival: any) => arrival.line));
    expect([...lines].sort()).toEqual(['jubilee', 'northern', 'thameslink']);
    expect(data.arrivals.find((arrival: any) => arrival.destination === 'Horsham')).toMatchObject({
      line: 'thameslink', lineName: 'Thameslink', mode: 'national-rail', platform: 'Platform 4', minutes: 2, status: 'Delayed', scheduled: '2026-11-12T09:30:00Z',
    });
    expect(data.arrivals.every((arrival: any) => ['tube', 'national-rail'].includes(arrival.mode))).toBe(true);
    expect(data.coverage_note).toMatch(/^Trains of Southeastern, Southern are not included/);
    expect(data.coverage_note).not.toContain('Thameslink,');
    // Only Thameslink is asked for: TfL rejects Southern and Southeastern line IDs with 400.
    expect(calls.filter((call) => call.includes('/ArrivalDepartures'))).toEqual(['/StopPoint/910GLNDNBDC/ArrivalDepartures?lineIds=thameslink']);
  });

  it('reads Thameslink at a station ID inside a hub, without the Elizabeth line guesses /Arrivals returns there', async () => {
    const { data, calls } = await board('live-farringdon-thameslink', { stop_id: '910GFRNDNLT' });
    expect(calls).toContain('/StopPoint/910GFRNDNLT/Arrivals');
    expect(new Set(data.arrivals.map((arrival: any) => arrival.line))).toEqual(new Set(['thameslink']));
    // Cancelled trains still ahead keep their scheduled place; the 09:26 to Cambridge, already overdue, sorts last
    // and falls past the limit, which the note says.
    expect(data.arrivals.filter((arrival: any) => arrival.status === 'Cancelled').map((arrival: any) => [arrival.destination, arrival.scheduled, arrival.expected, arrival.minutes]))
      .toEqual([['Bedford', '2026-11-12T09:31:00Z', null, null], ['Brighton', '2026-11-12T09:34:00Z', null, null]]);
    expect(data.arrivals.slice(0, 2).map((arrival: any) => arrival.destination)).toEqual(['St Albans City', 'Bedford']);
    // Farringdon has no other National Rail operator, so only the hidden trains are worth a note.
    expect(data.coverage_note).toBe('2 trains past their scheduled time with no estimate (1 cancelled) are listed last and fell past limit; filter by line or raise limit to see them.');
  });

  it('keeps overdue trains with no estimate from crowding a disrupted board', async () => {
    // At 09:29:37 TfL still listed the 09:15 Brighton and 09:18 Rainham, Delayed with no estimate. They used to
    // head the board as if leaving now; they now sort after every train with a time.
    const { data, at } = await board('live-hub-lbg', { stop_id: 'HUBLBG', limit: 8 });
    expect(data.arrivals).toHaveLength(8);
    expect(data.arrivals.every((arrival: any) => arrival.expected !== null)).toBe(true);
    expect(data.coverage_note).toContain('2 trains past their scheduled time with no estimate are listed last');
    const thameslink = (await board('live-hub-lbg', { stop_id: 'HUBLBG', line: 'thameslink', limit: 20 })).data.arrivals;
    // A train with no estimate still ahead of its scheduled time is listed there, with expected null.
    expect(thameslink.slice(0, 4).map((arrival: any) => [arrival.destination, arrival.status, arrival.expected])).toEqual([
      ['Horsham', 'Delayed', '2026-11-12T09:32:01.599Z'], ['Brighton', 'Delayed', '2026-11-12T09:37:00Z'], ['Brighton', 'Cancelled', null], ['Cambridge', 'Delayed', null],
    ]);
    expect(thameslink.every((arrival: any) => arrival.expected !== null || Date.parse(arrival.scheduled) >= at)).toBe(true);
  });

  it('works out minutes from expected against the clock and drops trains that have gone', async () => {
    const { data, at } = await board('live-hub-lbg', { stop_id: 'HUBLBG' });
    // TfL's timeToStation said 1 minute for the 09:27:59 Edgware train, 98 seconds before the board was read.
    expect(data.arrivals.map((arrival: any) => arrival.expected)).not.toContain('2026-11-12T09:27:59Z');
    expect(data.arrivals[0]).toMatchObject({ line: 'northern', destination: 'Edgware', expected: '2026-11-12T09:28:52Z', minutes: 0, mode: 'tube' });
    for (const arrival of data.arrivals.filter((item: any) => item.expected)) {
      expect(arrival.minutes).toBe(Math.max(0, Math.round((Date.parse(arrival.expected) - at) / 60_000)));
    }
    const times = data.arrivals.map((arrival: any) => Date.parse(arrival.expected));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('finds Thameslink at Wimbledon, nested inside the South Western Railway station in TfL\'s hub record', async () => {
    const { data, calls } = await board('live-hub-wim', { stop_id: 'HUBWIM' });
    expect(new Set(data.arrivals.map((arrival: any) => arrival.mode))).toEqual(new Set(['tube', 'tram', 'national-rail']));
    expect(calls).toContain('/StopPoint/910GWIMBLDN/ArrivalDepartures?lineIds=thameslink');
    // South Western Railway has no live data and is never asked for.
    expect(calls.filter((call) => call.includes('/ArrivalDepartures'))).toHaveLength(1);
    expect(data.coverage_note).toMatch(/^Trains of South Western Railway are not included/);
    const thameslink = (await board('live-hub-wim', { stop_id: 'HUBWIM', line: 'thameslink' })).data;
    expect(thameslink.arrivals).toHaveLength(8);
    expect(thameslink.arrivals[0]).toMatchObject({ line: 'thameslink', mode: 'national-rail', destination: 'St Albans City', platform: 'Platform 9', minutes: 10, status: 'OnTime' });
  });

  it('says a bus route missing from TfL\'s hub record is not listed there, instead of the rail advice', async () => {
    const { data } = await board('live-hub-vic-route-11', { stop_id: 'HUBVIC', line: '11' });
    expect(data.arrivals).toEqual([]);
    expect(data.next_action).toMatch(/^11 is not listed at this interchange in TfL's data/);
    expect(data.next_action).toContain('by its own name');
    expect(data.coverage_note).toBeUndefined();
  });

  it('points a National Rail line with no live data to timetable and line_status without reading any board', async () => {
    const { data, calls } = await board('live-hub-lbg', { stop_id: 'HUBLBG', line: 'southern' });
    expect(calls).toEqual(['/StopPoint/HUBLBG']);
    expect(data.arrivals).toEqual([]);
    expect(data.next_action).toBe('TfL publishes no live departures for Southern. Use timetable or plan_journey for its timetabled trains and line_status with southern for disruption.');
  });

  it('applies direction to Tube platforms only and says so, rather than emptying a bus board', async () => {
    const { data } = await board('live-bus-cluster', { stop_id: '490G000275', direction: 'Northbound' });
    expect(data.arrivals).toHaveLength(14);
    expect(data.coverage_note).toBe('direction applies only to Tube platforms; bus entries are not filtered by it, so read each destination.');
    expect(data.next_action).toBeUndefined();
    const tube = (await board('live-hub-lbg', { stop_id: 'HUBLBG', direction: 'Southbound' })).data;
    expect(new Set(tube.arrivals.filter((arrival: any) => arrival.mode === 'tube').map((arrival: any) => arrival.bound))).toEqual(new Set(['Southbound']));
    expect(tube.coverage_note).toContain('direction applies only to Tube platforms; Thameslink entries are not filtered by it');
  });

  it('expands a bus stop cluster into its lettered stops', async () => {
    const { data, calls } = await board('live-bus-cluster', { stop_id: '490G000275' });
    expect(calls).toEqual(['/StopPoint/490G000275', '/StopPoint/490000254W/Arrivals']);
    expect(data.arrivals).toHaveLength(14);
    expect(data.arrivals[0]).toEqual({
      line: '11', lineName: '11', mode: 'bus', bound: null, platform: 'W', destination: 'Fulham Broadway',
      towards: 'Vauxhall Or Victoria', minutes: 1, expected: '2026-11-12T09:30:20Z', location: null,
    });
    expect(data.coverage_note).toBeUndefined();
  });

  it('adds a named bus route\'s stops to a hub board, each bus once, and skips the rail boards', async () => {
    const { data, calls } = await board('live-hub-bus-route', { stop_id: 'HUBWAT', line: '11' });
    expect(calls.sort()).toEqual(['/StopPoint/490000254A/Arrivals', '/StopPoint/490000254C/Arrivals', '/StopPoint/490000254W/Arrivals', '/StopPoint/HUBWAT']);
    // TfL predicts each bus at stop A and again at W a minute later; the board keeps stop A only.
    expect(data.arrivals.map((arrival: any) => [arrival.platform, arrival.destination, arrival.minutes])).toEqual([
      ['A', 'Fulham Broadway', 0], ['C', 'Waterloo Station', 7], ['A', 'Fulham Broadway', 9],
      ['C', 'Waterloo Station', 10], ['A', 'Fulham Broadway', 19], ['C', 'Waterloo Station', 25],
    ]);
    // TfL sends towards as the string "null" for buses ending here.
    expect(data.arrivals[1].towards).toBeNull();
    // TfL's hub records can leave out a route's stop (HUBKGX lists route 73's stop X but not 490000129E).
    expect(data.coverage_note).toContain('may not list every stop route 11 uses');
  });

  it('reads river buses at a pier', async () => {
    const { data } = await board('live-pier', { stop_id: '930GEMB' });
    expect(data.arrivals.map((arrival: any) => [arrival.line, arrival.destination, arrival.minutes])).toEqual([
      ['rb1', 'Barking Riverside Pier', 5], ['rb6', 'Putney Pier', 16], ['rb1', 'Westminster Pier', 25], ['rb6', 'North Greenwich Pier', 35],
      ['rb1', 'North Greenwich Pier', 38], ['rb6', 'Putney Pier', 42], ['rb1', 'Westminster Pier', 55],
    ]);
    expect(data.arrivals[0]).toMatchObject({ mode: 'river-bus', platform: '', bound: null });
  });

  it('says the cable car has no live departures and points to timetable', async () => {
    const { data } = await board('live-cable-car', { stop_id: '940GZZALRDK' });
    expect(data.arrivals).toEqual([]);
    expect(data.coverage_note).toContain('cable car has no live departures');
    expect(data.coverage_note).toContain('timetable');
    // TfL answers with the Royal Victoria hub (DLR and cable car), but the stop asked for is the cable car's own.
    expect(data.next_action).toContain('cable car has no live departures');
  });
});

describe('live_departures routing', () => {
  const client = (routes: Parameters<typeof fakeTfl>[0]) => {
    const tfl = fakeTfl(routes);
    return { tfl, client: new TflClient(tfl.fetch, undefined, () => Date.parse('2026-11-12T09:00:00Z')) };
  };

  it('leaves a hub board rail-only unless a bus route is named', async () => {
    const hub = { id: 'HUBX', modes: ['bus', 'tube'], lineModeGroups: [{ modeName: 'tube', lineIdentifier: ['victoria'] }, { modeName: 'bus', lineIdentifier: ['11'] }],
      children: [{ id: '940GZZLUX', modes: ['tube'] }, { id: '490G1', modes: ['bus'], children: [{ id: '4901A', stopType: 'NaptanPublicBusCoachTram', modes: ['bus'], lines: [{ id: '11', name: '11' }] }] }] };
    const { tfl, client: tflClient } = client({
      '/StopPoint/HUBX': { body: hub },
      '/StopPoint/940GZZLUX/Arrivals': { body: [prediction({ timeToStation: 120, expectedArrival: '2026-11-12T09:02:00Z', modeName: 'tube' })] },
      '/StopPoint/4901A/Arrivals': { body: [prediction({ lineId: '11', lineName: '11', modeName: 'bus', platformName: 'A', timeToStation: 60, expectedArrival: '2026-11-12T09:01:00Z', vehicleId: 'BUS1' })] },
    });
    const rail = await liveDepartures(tflClient, undefined, { stop_id: 'HUBX', limit: 8 }) as any;
    expect(rail.arrivals.map((arrival: any) => arrival.line)).toEqual(['victoria']);
    expect(tfl.calls.map((url) => url.pathname)).not.toContain('/StopPoint/4901A/Arrivals');
    const bus = await liveDepartures(tflClient, undefined, { stop_id: 'HUBX', line: '11', limit: 8 }) as any;
    expect(bus.arrivals.map((arrival: any) => [arrival.line, arrival.mode, arrival.platform])).toEqual([['11', 'bus', 'A']]);
  });

  it('reads a bare bus stop even when TfL cannot return its record', async () => {
    const { client: tflClient } = client({
      '/StopPoint/490000254W': { status: 500 },
      '/StopPoint/490000254W/Arrivals': { body: [prediction({ lineId: '76', lineName: '76', modeName: 'bus', platformName: 'W', timeToStation: 300, expectedArrival: '2026-11-12T09:05:00Z', vehicleId: 'B' })] },
    });
    const data = await liveDepartures(tflClient, undefined, { stop_id: '490000254W', limit: 8 }) as any;
    expect(data.arrivals).toEqual([expect.objectContaining({ line: '76', mode: 'bus', minutes: 5 })]);
  });

  it('explains an empty bus board without the rail wording', async () => {
    const { client: tflClient } = client({ '/StopPoint/930GEMB': { body: { id: '930GEMB', modes: ['river-bus'] } }, '/StopPoint/930GEMB/Arrivals': { body: [] } });
    const data = await liveDepartures(tflClient, undefined, { stop_id: '930GEMB', limit: 8 }) as any;
    expect(data.next_action).toContain('No buses or boats');
  });

  it('reads every rail and metro station nested in a hub, never entrances', async () => {
    const thameslink = { id: '910GIN', stopType: 'NaptanRailStation', modes: ['national-rail'], lines: [{ id: 'thameslink', name: 'Thameslink' }],
      children: [{ id: '4900IN1', stopType: 'NaptanRailEntrance', modes: ['national-rail'] }, { id: '910GINWAY', stopType: 'NaptanRailEntrance', modes: ['national-rail'] }] };
    const hub = { id: 'HUBY', modes: ['national-rail'], lines: [{ id: 'thameslink', name: 'Thameslink' }], lineModeGroups: [{ modeName: 'national-rail', lineIdentifier: ['thameslink'] }],
      children: [{ id: '910GOUT', stopType: 'NaptanRailStation', modes: ['national-rail'], lines: [{ id: 'southern', name: 'Southern' }],
        children: [thameslink, { id: '9100OUT1', stopType: 'NaptanRailAccessArea', modes: ['national-rail'] }] }] };
    const { tfl, client: tflClient } = client({
      '/StopPoint/HUBY': { body: hub }, '/StopPoint/910GOUT': { body: hub }, '/StopPoint/910GIN': { body: hub },
      '/StopPoint/910GIN/ArrivalDepartures': { body: [{ platformName: 'Platform 9', destinationName: 'Luton', scheduledTimeOfDeparture: '2026-11-12T09:10:00Z', estimatedTimeOfDeparture: '2026-11-12T09:10:00Z', departureStatus: 'OnTime' }] },
    });
    const data = await liveDepartures(tflClient, undefined, { stop_id: 'HUBY', limit: 8 }) as any;
    expect(data.arrivals).toEqual([expect.objectContaining({ line: 'thameslink', mode: 'national-rail', destination: 'Luton', minutes: 10 })]);
    expect(tfl.calls.map((url) => url.pathname).filter((path) => /4900IN1|910GINWAY|9100OUT1/.test(path))).toEqual([]);
  });

  it('orders trains with no estimate by scheduled time, overdue ones last, and drops them 20 minutes late', async () => {
    const train = (scheduled: string, status: string, destinationName: string, estimate?: string) => ({
      platformName: 'Platform A', destinationNaptanId: destinationName, destinationName, scheduledTimeOfDeparture: scheduled, departureStatus: status,
      ...(estimate ? { estimatedTimeOfDeparture: estimate } : {}),
    });
    const { client: tflClient } = client({
      '/StopPoint/910GZ': { body: { id: '910GZ', modes: ['elizabeth-line'], lines: [{ id: 'elizabeth', name: 'Elizabeth line' }], lineModeGroups: [{ modeName: 'elizabeth-line', lineIdentifier: ['elizabeth'] }] } },
      '/StopPoint/910GZ/ArrivalDepartures': { body: [
        train('2026-11-12T08:35:00Z', 'Delayed', 'Gone'), train('2026-11-12T08:50:00Z', 'Cancelled', 'Overdue'),
        train('2026-11-12T09:03:00Z', 'Cancelled', 'Ahead'), train('2026-11-12T09:01:00Z', 'Delayed', 'Running', '2026-11-12T09:05:00Z'),
      ] },
    });
    const data = await liveDepartures(tflClient, undefined, { stop_id: '910GZ', limit: 8 }) as any;
    expect(data.arrivals.map((arrival: any) => [arrival.destination, arrival.mode, arrival.expected, arrival.minutes])).toEqual([
      ['Ahead', 'elizabeth-line', null, null], ['Running', 'elizabeth-line', '2026-11-12T09:05:00Z', 5], ['Overdue', 'elizabeth-line', null, null],
    ]);
    const short = await liveDepartures(tflClient, undefined, { stop_id: '910GZ', limit: 2 }) as any;
    expect(short.coverage_note).toBe('1 train past its scheduled time with no estimate (1 cancelled) is listed last and fell past limit; filter by line or raise limit to see it.');
  });

  it('collapses runs of whitespace in TfL names', () => {
    expect(cleanStationName('Waterloo Station   / York Road')).toBe('Waterloo Station / York Road');
  });

  it('names the operators at a National Rail-only station and asks TfL for none of them', async () => {
    const { tfl, client: tflClient } = client({
      '/StopPoint/910GSURBITN': { body: { id: '910GSURBITN', modes: ['national-rail'], lines: [{ id: 'south-western-railway', name: 'South Western Railway' }],
        lineModeGroups: [{ modeName: 'national-rail', lineIdentifier: ['south-western-railway'] }] } },
    });
    const data = await liveDepartures(tflClient, undefined, { stop_id: '910GSURBITN', limit: 8 }) as any;
    expect(data.next_action).toContain('only by National Rail operators without live TfL departures');
    expect(data.coverage_note).toMatch(/^Trains of South Western Railway are not included/);
    expect(tfl.calls.map((url) => url.pathname)).toEqual(['/StopPoint/910GSURBITN']);
  });
});
