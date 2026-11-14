/**
 * Records live TfL responses for the timetable and station-resolution tests, trimmed to the fields the
 * server reads, so CI replays real data without network calls. Run with: npx tsx scripts/record-fixtures.ts
 * (TFL_APP_KEY is optional; the key is never written to a fixture). Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1.
 */
import { writeFileSync } from 'node:fs';
import { planJourney } from '../src/journeys.js';
import { liveDepartures } from '../src/live.js';
import { TflClient } from '../src/tfl.js';
import { buildTimetable } from '../src/timetable.js';
import { fixtureKey } from '../test/helpers.js';

type Recorded = Record<string, { status: number; body: unknown }>;

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([name]) => name !== '$type').map(([name, inner]) => [name, strip(inner)]));
  }
  return value;
}

const pick = (value: any, fields: string[]) => value && Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));

function trim(path: string, body: any): unknown {
  if (path.startsWith('/Journey/')) {
    // TfL error bodies quote the request URL, key included; keep only what the client reads.
    if (body.exceptionType) return pick(body, ['exceptionType', 'httpStatusCode', 'message']);
    const point = (value: any) => pick(value, ['commonName', 'naptanId', 'platformName', 'icsCode']);
    const ambiguity = (value: any) => value && { disambiguationOptions: (value.disambiguationOptions ?? []).slice(0, 12).map((option: any) => ({ parameterValue: option.parameterValue, place: pick(option.place, ['commonName', 'modes', 'placeType']) })) };
    return {
      ...(body.journeys ? { journeys: body.journeys.map((journey: any) => ({
        ...pick(journey, ['startDateTime', 'arrivalDateTime', 'duration']),
        legs: journey.legs.map((leg: any) => ({
          ...pick(leg, ['duration', 'departureTime', 'arrivalTime', 'isDisrupted']),
          mode: { id: leg.mode.id }, departurePoint: point(leg.departurePoint), arrivalPoint: point(leg.arrivalPoint),
          instruction: { summary: leg.instruction?.summary },
          routeOptions: (leg.routeOptions ?? []).map((option: any) => ({ name: option.name, directions: option.directions, lineIdentifier: pick(option.lineIdentifier, ['id', 'name']) })),
          path: { stopPoints: (leg.path?.stopPoints ?? []).map((stop: any) => pick(stop, ['id', 'name'])) },
          disruptions: [], plannedWorks: [],
        })),
      })) } : {}),
      ...(body.fromLocationDisambiguation ? { fromLocationDisambiguation: ambiguity(body.fromLocationDisambiguation) } : {}),
      ...(body.toLocationDisambiguation ? { toLocationDisambiguation: ambiguity(body.toLocationDisambiguation) } : {}),
    };
  }
  if (path.includes('/Route/Sequence/')) {
    return {
      orderedLineRoutes: (body.orderedLineRoutes ?? []).map((route: any) => pick(route, ['name', 'naptanIds'])),
      stopPointSequences: (body.stopPointSequences ?? []).map((sequence: any) => ({ stopPoint: (sequence.stopPoint ?? []).map((stop: any) => pick(stop, ['id', 'name'])) })),
    };
  }
  if (path.includes('/Timetable/')) {
    return {
      ...pick(body, ['lineId', 'lineName', 'direction', 'message']),
      stops: (body.stops ?? []).map((stop: any) => pick(stop, ['id', 'name'])),
      timetable: body.timetable && { routes: body.timetable.routes.map((route: any) => ({
        stationIntervals: route.stationIntervals.map((interval: any) => ({ id: interval.id, intervals: interval.intervals.map((item: any) => pick(item, ['stopId', 'timeToArrival'])) })),
        schedules: route.schedules.map((schedule: any) => ({ name: schedule.name, knownJourneys: schedule.knownJourneys.map((journey: any) => pick(journey, ['hour', 'minute', 'intervalId'])) })),
      })) },
    };
  }
  if (path.endsWith('/Arrivals')) {
    return (body as any[]).map((item) => pick(item, ['lineId', 'lineName', 'modeName', 'platformName', 'destinationNaptanId', 'destinationName', 'towards', 'timeToStation', 'expectedArrival', 'currentLocation', 'vehicleId']));
  }
  if (path.endsWith('/ArrivalDepartures')) {
    return (body as any[]).map((item) => pick(item, ['platformName', 'destinationNaptanId', 'destinationName', 'scheduledTimeOfDeparture', 'estimatedTimeOfDeparture', 'departureStatus', 'cause']));
  }
  if (path.startsWith('/StopPoint/Search/')) return { matches: (body.matches ?? []).map((match: any) => pick(match, ['id', 'name', 'modes', 'icsId'])) };
  if (path.startsWith('/StopPoint/')) {
    const stop = (value: any): any => ({
      ...pick(value, ['id', 'commonName', 'icsCode', 'stopType', 'modes', 'lineModeGroups']),
      lines: (value.lines ?? []).map((line: any) => pick(line, ['id', 'name'])),
      children: (value.children ?? []).filter((child: any) => !/^(490|9100|9400|9200|HUB)/.test(child.id) || child.children?.length || child.lines?.length).map(stop),
    });
    return stop(body);
  }
  return body;
}

async function record(name: string, scenario: (tfl: TflClient) => Promise<unknown>) {
  const recorded: Recorded = {};
  // Live boards are replayed at this instant, so it is taken before the first request.
  const recordedAt = new Date().toISOString();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    let response = await fetch(url, init);
    // Keyless TfL allows few requests a minute; wait out a 429 here so fixtures hold only real answers.
    for (let attempt = 0; response.status === 429 && attempt < 8; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      // The client's own 10-second timeout has expired by now, so retry without its signal.
      response = await fetch(url);
    }
    const text = await response.text();
    let body: unknown = text;
    try { body = trim(url.pathname, strip(JSON.parse(text))); } catch { /* non-JSON error body */ }
    recorded[fixtureKey(url)] = { status: response.status, body };
    return new Response(text, { status: response.status });
  }) as typeof fetch;
  const result = await scenario(new TflClient(fetchImpl, process.env.TFL_APP_KEY, Date.now));
  writeFileSync(`test/fixtures/${name}.json`, `${JSON.stringify({ recorded_at: recordedAt, responses: recorded })}\n`);
  console.log(`${name}: ${Object.keys(recorded).length} responses`);
  return result;
}

const scenarios: Record<string, (tfl: TflClient) => Promise<unknown>> = {
  'timetable-lbg-ecr': (tfl) => buildTimetable(tfl, { from: 'London Bridge', to: 'East Croydon', date: '2026-11-12', start_time: '14:00', end_time: '18:00' }),
  'timetable-victoria-line': (tfl) => buildTimetable(tfl, { from: 'Brixton', to: 'VIC', date: '2026-11-12', start_time: '08:00', end_time: '09:00', operators: ['victoria'] }),
  'timetable-lbg-gatwick': (tfl) => buildTimetable(tfl, { from: 'London Bridge', to: 'Gatwick Airport', date: '2026-11-12', start_time: '14:00', end_time: '16:00' }),
  'timetable-waterloo-city': (tfl) => buildTimetable(tfl, { from: 'Waterloo', to: 'Bank', date: '2026-11-12', start_time: '08:00', end_time: '09:00', operators: ['waterloo-city'] }),
  'timetable-ecr-lbg-sunday': (tfl) => buildTimetable(tfl, { from: 'ECR', to: 'LBG', date: '2026-11-15', start_time: '10:00', end_time: '12:00' }),
  'plan-lbg-ecr': (tfl) => planJourney(tfl, { from: 'London Bridge', to: 'East Croydon', at: '2026-11-12T14:00:00Z', time_is: 'departing', max_routes: 3 }),
  'live-hub-lbg': (tfl) => liveDepartures(tfl, { stop_id: 'HUBLBG', limit: 20 }),
  'live-farringdon-thameslink': (tfl) => liveDepartures(tfl, { stop_id: '910GFRNDNLT', limit: 20 }),
  'live-bus-cluster': (tfl) => liveDepartures(tfl, { stop_id: '490G000275', limit: 20 }),
  'live-hub-bus-route': (tfl) => liveDepartures(tfl, { stop_id: 'HUBWAT', line: '11', limit: 20 }),
  'live-pier': (tfl) => liveDepartures(tfl, { stop_id: '930GEMB', limit: 20 }),
  'live-cable-car': (tfl) => liveDepartures(tfl, { stop_id: '940GZZALRDK', limit: 20 }),
  // live_departures fixes (12 Nov 2026 QA)
  'live-hub-wim': (tfl) => liveDepartures(tfl, { stop_id: 'HUBWIM', limit: 20 }),
  'live-hub-vic-route-11': (tfl) => liveDepartures(tfl, { stop_id: 'HUBVIC', line: '11', limit: 20 }),
  'plan-hub-ids': (tfl) => planJourney(tfl, { from: 'HUBLBG', to: 'HUBECY', at: '2026-11-12T14:00:00Z', time_is: 'departing', max_routes: 3 }),
  // plan_journey and line_status fixes (12 Nov 2026 QA).
  'plan-far-future': (tfl) => planJourney(tfl, { from: 'Bank', to: 'Paddington', at: '2027-03-01T09:00:00Z', time_is: 'departing', max_routes: 3 }).catch((error) => ({ error: String(error) })),
  'plan-bridge-victoria': (tfl) => planJourney(tfl, { from: 'Bridge', to: 'Victoria', at: '2026-11-12T14:00:00Z', time_is: 'departing', max_routes: 3 }),
  // timetable fixes (QA 12 Nov 2026)
  'tt-pad-lst': async (tfl) => [
    await buildTimetable(tfl, { from: 'Paddington', to: 'Liverpool Street', date: '2026-11-19', start_time: '08:00', end_time: '09:00' }),
    await buildTimetable(tfl, { from: 'Paddington', to: '910GLIVSTLL', date: '2026-11-19', start_time: '08:00', end_time: '09:00', operators: ['elizabeth'] }),
  ],
  'tt-wimbledon-tooting': (tfl) => buildTimetable(tfl, { from: 'Wimbledon', to: 'Tooting', date: '2026-11-19', start_time: '08:00', end_time: '09:00' }),
  'tt-ecr-lbg-saturday': (tfl) => buildTimetable(tfl, { from: 'East Croydon', to: 'London Bridge', date: '2026-11-14', start_time: '10:00', end_time: '12:00' }),
  'tt-cable-car': (tfl) => buildTimetable(tfl, { from: 'Royal Docks', to: 'Greenwich Peninsula', date: '2026-11-19', start_time: '10:00', end_time: '11:00' }),
  'tt-bridge': (tfl) => buildTimetable(tfl, { from: 'Bridge', to: 'East Croydon', date: '2026-11-19', start_time: '08:00', end_time: '09:00' }),
};
// Pass fixture names to re-record only those; with none, every fixture is re-recorded.
const wanted = process.argv.slice(2);
for (const [name, scenario] of Object.entries(scenarios)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const result = await record(name, scenario);
  if (process.env.SHOW) console.log(JSON.stringify(result, null, 1));
}
