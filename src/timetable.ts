import { z } from 'zod';
import { mapConcurrent } from './journeys.js';
import { type Candidate, displayName, normaliseName, resolveStation, type Station } from './stations.js';
import { TIMETABLE_TTL_MS, TflClient, TflError } from './tfl.js';

export const MAX_WINDOW_MINUTES = 360;
const MAX_SERVICES = 300;
const MAX_VIA_PASSES = 4;
const MAIN_PASS_CALLS = 40;
const VIA_PASS_CALLS = 12;

const clock = /^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$/;
export const timetableSchema = z.object({
  from: z.string().trim().min(1).max(100)
    .describe('Departure station: a station name (e.g. "London Bridge"), a National Rail CRS code (e.g. "LBG", uppercase) or a TfL stop/hub ID (e.g. "910GLNDNBDC", "HUBLBG"). Names resolve only to stations, never to streets or bus stops.'),
  to: z.string().trim().min(1).max(100)
    .describe('Arrival station, in the same forms as from. Only trains that run from one to the other without a change are listed.'),
  date: z.iso.date().describe('Travel date in Europe/London, YYYY-MM-DD. Resolve "tomorrow" or weekdays to a date before calling.'),
  start_time: z.string().regex(clock).describe('Window start, HH:MM London time. Departures at or after this time are included.'),
  end_time: z.string().regex(clock).describe(`Window end, HH:MM London time (24:00 allowed). Departures before this time are included. At most ${MAX_WINDOW_MINUTES / 60} hours after start_time; split longer periods into several calls.`),
  operators: z.array(z.string().trim().min(1).max(60)).min(1).max(10).optional()
    .describe('Optional operator or line filter by name or TfL line ID, e.g. ["Thameslink"], ["southern", "thameslink"], ["victoria"]. Omit to list every operator.'),
}).strict()
  .refine((value) => minutes(value.end_time) > minutes(value.start_time), { message: 'end_time must be after start_time on the same day.', path: ['end_time'] })
  .refine((value) => minutes(value.end_time) - minutes(value.start_time) <= MAX_WINDOW_MINUTES, { message: `The window is limited to ${MAX_WINDOW_MINUTES / 60} hours; split longer periods into several calls.`, path: ['end_time'] });

export type TimetableQuery = z.infer<typeof timetableSchema>;

/** A line that calls at both stations, with the stop ID it uses at each. */
export type LineRef = { id: string; name: string; mode: string; fromStop: string; toStop: string };
/** stops: calling points after departure up to and including the arrival station. */
export type Service = {
  departure: string; arrival: string; duration_minutes: number; stops: number;
  operator: string; line: string; mode: string; destination: string; platform: string | null;
};
/** A train the source returned but that could not be shown to be one train calling at both stations. */
export type Unverified = { departure: string; operator: string; line: string; reason: string };
export type SourceRequest = { from: Station; to: Station; lines: LineRef[]; date: string; start: number; end: number };
export type SourceReport = Record<string, unknown> & { source: string; lines: string[]; complete: boolean };
export type SourceResult = { services: Service[]; reports: SourceReport[]; unserved: LineRef[]; unverified?: Unverified[] };
/**
 * A source of scheduled services between two stations. Sources are tried in order; each takes the lines whose
 * mode it handles, and hands back any it could not serve so a later source can try. A new data feed (for example
 * a National Rail timetable) is added by putting another implementation ahead of the planner.
 */
export interface TimetableSource {
  readonly id: string;
  handles(line: LineRef): boolean;
  collect(request: SourceRequest): Promise<SourceResult>;
}

/** "Beckenham Junction Tram Stop", "Abbey Wood Station", "Horsham Rail Station" -> the place name. */
const placeName = (name: string) => displayName(name).replace(/\s+(Tram Stop|Station|Pier)\.?$/, '');

export function minutes(time: string) {
  const [hours, mins] = time.split(':').map(Number) as [number, number];
  return hours * 60 + mins;
}
export function clockTime(total: number) {
  const hours = Math.floor(total / 60) % 24;
  return `${String(hours).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY = '(mon|tue|wed|thu|fri|sat|sun)[a-z]*';
/** The weekdays (Monday = 0) a TfL schedule name covers: "Monday - Thursday", "Saturdays and Public Holidays". */
export function scheduleDays(name: string) {
  let text = name.toLowerCase().replace(/\([^)]*\)/g, ' ');
  const days = new Set<number>();
  text = text.replace(new RegExp(`${DAY}\\s*(?:-|–|to)\\s*${DAY}`, 'g'), (_match, first: string, last: string) => {
    for (let day = DAY_NAMES.indexOf(first); ; day = (day + 1) % 7) {
      days.add(day);
      if (day === DAY_NAMES.indexOf(last)) break;
    }
    return ' ';
  });
  for (const match of text.matchAll(new RegExp(DAY, 'g'))) days.add(DAY_NAMES.indexOf(match[1]!));
  return days;
}
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** One label style for TfL's schedule names: {Mon..Thu} -> "Mon–Thu", {Sat, Sun} -> "Sat–Sun", {Mon, Wed} -> "Mon, Wed". */
export function dayLabel(days: Set<number>) {
  const sorted = [...days].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const day of sorted) {
    const run = runs.at(-1);
    if (run && run.at(-1) === day - 1) run.push(day);
    else runs.push([day]);
  }
  return runs.map((run) => (run.length > 1 ? `${SHORT_DAYS[run[0]!]}–${SHORT_DAYS[run.at(-1)!]}` : SHORT_DAYS[run[0]!])).join(', ');
}
export function weekdayOf(date: string) {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

const lineTimetable = z.object({
  lineName: z.string().optional(),
  stops: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
  timetable: z.object({
    routes: z.array(z.object({
      stationIntervals: z.array(z.object({
        id: z.coerce.string(),
        intervals: z.array(z.object({ stopId: z.string(), timeToArrival: z.number() })).default([]),
      })).default([]),
      schedules: z.array(z.object({
        name: z.string(),
        knownJourneys: z.array(z.object({ hour: z.coerce.number(), minute: z.coerce.number(), intervalId: z.coerce.string() })).default([]),
      })).default([]),
    })).default([]),
  }).nullish(),
});

/** TfL's published Line Timetable: Tube, DLR, tram, bus, river bus and cable car. Not National Rail, Elizabeth line or Overground. */
export class LineTimetableSource implements TimetableSource {
  readonly id = 'tfl-line-timetable';
  static readonly MODES = ['tube', 'dlr', 'tram', 'bus', 'river-bus', 'cable-car'];
  constructor(private tfl: TflClient) {}

  handles(line: LineRef) {
    return LineTimetableSource.MODES.includes(line.mode);
  }

  async collect({ lines, date, start, end }: SourceRequest): Promise<SourceResult> {
    const result: SourceResult = { services: [], reports: [], unserved: [] };
    const weekday = weekdayOf(date);
    for (const line of lines) {
      let parsed: z.infer<typeof lineTimetable>;
      try {
        const raw = lineTimetable.safeParse(await this.tfl.lineTimetable(line.id, line.fromStop, line.toStop));
        if (!raw.success || !raw.data.timetable?.routes.length) throw new TflError(404);
        parsed = raw.data;
      } catch (error) {
        if (!(error instanceof TflError) || error.status === 429) throw error;
        result.unserved.push(line);
        result.reports.push({ source: this.id, lines: [line.id], complete: false, outcome: 'no_timetable', note: `TfL has no Line Timetable for ${line.name} between these stops; handed to the next source.` });
        continue;
      }
      const names = new Map(parsed.stops.map((stop) => [stop.id, stop.name ?? stop.id]));
      const schedules = new Map<string, string>();
      const seen = new Set<string>();
      for (const route of parsed.timetable!.routes) {
        const chosen = route.schedules
          .map((item) => ({ item, days: scheduleDays(item.name) }))
          .filter(({ days }) => days.has(weekday))
          .sort((a, b) => a.days.size - b.days.size)[0];
        if (!chosen) continue;
        const schedule = chosen.item;
        schedules.set(dayLabel(chosen.days), schedule.name);
        const intervals = new Map(route.stationIntervals.map((interval) => [interval.id, interval.intervals]));
        for (const journey of schedule.knownJourneys) {
          const departure = journey.hour * 60 + journey.minute;
          const stops = intervals.get(journey.intervalId) ?? [];
          const arrivalIndex = stops.findIndex((stop) => stop.stopId === line.toStop);
          const arrivalAt = stops[arrivalIndex];
          if (departure < start || departure >= end || !arrivalAt) continue;
          const key = `${departure}|${journey.intervalId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const duration = Math.round(arrivalAt.timeToArrival);
          const terminus = stops[stops.length - 1]!.stopId;
          result.services.push({
            departure: clockTime(departure), arrival: clockTime(departure + duration), duration_minutes: duration, stops: arrivalIndex + 1,
            operator: parsed.lineName ?? line.name, line: line.id, mode: line.mode,
            destination: placeName(names.get(terminus) ?? terminus), platform: null,
          });
        }
      }
      if (!schedules.size) {
        result.unserved.push(line);
        result.reports.push({ source: this.id, lines: [line.id], complete: false, outcome: 'no_schedule_for_day', note: `TfL's ${line.name} timetable has no schedule for this weekday; handed to the next source.` });
        continue;
      }
      result.reports.push({
        source: this.id, lines: [line.id], complete: true, outcome: 'ok', schedule_basis: 'standard_weekly',
        schedule: [...schedules.keys()].join('; '), tfl_schedule_name: [...schedules.values()].join('; '),
        note: 'TfL\'s standard weekly timetable for this day of the week, not this date: planned engineering works, bank holiday timetables and live changes are not applied. Check line_status.',
      });
    }
    return result;
  }
}

const plannerLeg = z.object({
  duration: z.number(), departureTime: z.string(), arrivalTime: z.string(), mode: z.object({ id: z.string() }),
  departurePoint: z.object({ platformName: z.string().optional() }).optional(),
  arrivalPoint: z.object({ naptanId: z.string().optional(), icsCode: z.string().optional() }).optional(),
  path: z.object({ stopPoints: z.array(z.object({ id: z.string().optional(), name: z.string().optional() })).default([]) }).optional(),
  routeOptions: z.array(z.object({
    name: z.string().optional(), directions: z.array(z.string()).optional(),
    lineIdentifier: z.object({ id: z.string(), name: z.string().optional() }).nullish(),
  })).default([]),
});
const plannerResult = z.object({ journeys: z.array(z.object({ startDateTime: z.string(), legs: z.array(plannerLeg) })).default([]) });

type Via = { id: string; name: string };
/**
 * A via stop for one corridor, the stop to retry with if the planner splits that corridor's trains at it, and the
 * normalised names of the termini of routes that run through the corridor to the arrival station.
 */
type ViaPlan = { stop: Via; fallback: Via | null; termini: Set<string> };
/**
 * services_found: direct trains this pass found itself, before merging passes and before any operator filter, so
 * passes overlap. split_at_via: trains that left within the window and run on past the via stop, but which the
 * planner cut there and continued by another route.
 */
type Pass = {
  via: Via | null; retry_of?: string; calls: number; from_cache: number; services_found: number; split_at_via?: number;
  searched_to: string | null; stopped: string;
};
/** Ways a pass can end. Only the first two mean it covered the window. */
const PASS_COVERED = ['window_end', 'no_more_journeys'];

/**
 * TfL's Journey Planner, queried repeatedly. It returns at most three journeys after a time, so a pass asks again
 * from just after the last departure until the window ends. It also leaves out a train that a later train
 * beats or ties (London Bridge 14:10 to East Croydon 14:28 via Norwood Junction, behind the 14:15 that also
 * arrives 14:28), so extra passes force the route through one stop of each other corridor TfL's route sequences
 * list between the two stations. Only journeys with a single train and no change count.
 */
export class JourneyPlannerSource implements TimetableSource {
  readonly id = 'tfl-journey-planner';
  /** retryDelayMs: how long to wait before the one retry after TfL's rate limit (429). */
  constructor(private tfl: TflClient, private retryDelayMs = 2_000) {}

  handles() {
    return true;
  }

  async collect({ from, to, lines, date, start, end }: SourceRequest): Promise<SourceResult> {
    const modes = [...new Set(lines.map((line) => line.mode))];
    const fromPlace = from.icsCode ?? lines[0]!.fromStop;
    const toPlace = to.icsCode ?? lines[0]!.toStop;
    const { vias, failed } = await this.viaStops(lines);
    const found = new Map<string, Service>();
    const unverified = new Map<string, Unverified>();
    const arrival = { ids: new Set([to.id, ...to.stops.map((stop) => stop.id)]), icsCodes: new Set([...(to.icsCodes ?? []), ...(to.icsCode ? [to.icsCode] : [])]) };
    const run = (via: Via | null, termini = new Set<string>()) => this.pass({ fromPlace, toPlace, via, termini, modes, date, start, end, found, unverified, arrival });
    const passes = await mapConcurrent<ViaPlan | null, Pass>([null, ...vias], 2, (plan) => run(plan?.stop ?? null, plan?.termini));
    // The planner ends a journey's first train at the via stop and plans on from there, so a stop near the origin
    // can lose a slow through train to a faster onward route (Saturday East Croydon via Selhurst). Retry such a
    // corridor through a stop nearer its middle, where staying on the train is the planner's best choice both ways.
    const split = vias.map((plan, index) => ({ plan, pass: passes[index + 1]! }))
      .filter(({ pass }) => pass.services_found === 0 && (pass.split_at_via ?? 0) > 0);
    const retries = await mapConcurrent(split.filter(({ plan }) => plan.fallback), 2, async ({ plan }) =>
      ({ ...await run(plan.fallback, plan.termini), retry_of: plan.stop.name }));
    passes.push(...retries);
    const unresolved = split.filter(({ plan }) => !retries.some((pass) => pass.retry_of === plan.stop.name && pass.services_found > 0));
    const complete = passes.every((pass) => PASS_COVERED.includes(pass.stopped)) && failed.length === 0 && unresolved.length === 0;
    const caveats = [
      ...failed.map((sequence) => `TfL's ${sequence} route sequence could not be read, so via passes for that line's other routes did not run; slower trains on them may be missing. Retry later.`),
      ...unresolved.map(({ plan }) => `The pass via ${plan.stop.name} saw trains run on past ${plan.stop.name} towards the arrival station, but TfL's planner split them there${plan.fallback ? ` and again at ${plan.fallback.name}` : ''}; direct trains on that route may be missing. Check one with plan_journey.`),
      ...passes.flatMap((pass) => {
      const where = pass.via ? `The pass via ${pass.via.name}` : 'The main pass';
      if (pass.stopped === 'call_cap') return [`${where} stopped at ${pass.searched_to}, before ${clockTime(end)}, on its ${pass.via ? VIA_PASS_CALLS : MAIN_PASS_CALLS}-call limit; trains after that on its route may be missing. Query a shorter window.`];
      if (pass.stopped === 'rate_limited' || pass.stopped === 'error') return [`${where} stopped at ${pass.searched_to ?? 'the start'} because TfL ${pass.stopped === 'rate_limited' ? 'rate limited the request' : 'failed'}; trains after that may be missing. Retry later.`];
      return [];
      }),
    ];
    const report: SourceReport = {
      source: this.id, lines: lines.map((line) => line.id), complete, modes, schedule_basis: 'dated',
      calls: passes.reduce((sum, pass) => sum + pass.calls, 0), from_cache: passes.reduce((sum, pass) => sum + pass.from_cache, 0),
      passes, ...(caveats.length ? { caveats } : {}),
      note: 'Timetabled trains for this date from TfL\'s Journey Planner, including planned engineering works but not live delays. Each pass asks for departures after the last one returned; via passes catch slower trains the planner otherwise hides behind a faster one, and a pass with retry_of repeats a via pass whose trains the planner split at the via stop. A service counts only if one train, with a named terminus, calls at both stations. services_found counts the direct trains a pass found itself, before merging passes and before any operator filter, so passes overlap and their sum can exceed count. from_cache counts calls answered from the one-hour cache without asking TfL.',
    };
    return { services: [...found.values()], reports: [report], unserved: [], unverified: [...unverified.values()] };
  }

  /**
   * One distinctive intermediate stop per distinct corridor between the stations, from TfL route sequences, and
   * another distinctive stop on that corridor, nearest its middle, to retry with.
   */
  private async viaStops(lines: LineRef[]) {
    const corridors = new Map<string, { stops: string[]; termini: Set<string> }>();
    const names = new Map<string, string>();
    const failed: string[] = [];
    for (const line of lines) {
      for (const direction of ['outbound', 'inbound'] as const) {
        let sequence: Awaited<ReturnType<TflClient['routeSequence']>>;
        try {
          sequence = await this.tfl.routeSequence(line.id, direction);
        } catch (error) {
          if (!(error instanceof TflError)) throw error;
          // A line with no route data in one direction is normal (404); anything else means unknown corridors.
          if (error.status !== 404) failed.push(`${line.name} ${direction}`);
          continue;
        }
        for (const stop of sequence.stopPointSequences?.flatMap((item) => item.stopPoint ?? []) ?? []) names.set(stop.id, displayName(stop.name ?? stop.id));
        for (const route of sequence.orderedLineRoutes ?? []) {
          const ids = route.naptanIds ?? [];
          const a = ids.indexOf(line.fromStop);
          const b = ids.indexOf(line.toStop);
          if (a < 0 || b <= a + 1) continue;
          const corridor = corridors.get(ids.slice(a + 1, b).join(',')) ?? { stops: ids.slice(a + 1, b), termini: new Set<string>() };
          corridor.termini.add(ids.at(-1)!);
          corridors.set(corridor.stops.join(','), corridor);
        }
      }
    }
    const counts = new Map<string, number>();
    for (const { stops } of corridors.values()) for (const stop of new Set(stops)) counts.set(stop, (counts.get(stop) ?? 0) + 1);
    const picks = new Map<string, { stops: string[]; termini: Set<string> }>();
    for (const corridor of corridors.values()) {
      const pick = [...corridor.stops].sort((a, b) => counts.get(a)! - counts.get(b)!)[0]!;
      const known = picks.get(pick);
      if (known) for (const terminus of corridor.termini) known.termini.add(terminus);
      else picks.set(pick, { stops: corridor.stops, termini: new Set(corridor.termini) });
    }
    const via = (id: string): Via => ({ id, name: names.get(id) ?? id });
    const vias: ViaPlan[] = [...picks].slice(0, MAX_VIA_PASSES).map(([pick, { stops, termini }]) => {
      const middle = (stops.length - 1) / 2;
      const fallback = stops.map((id, index) => ({ id, index }))
        .filter(({ id }) => counts.get(id) === counts.get(pick) && !picks.has(id))
        .sort((a, b) => Math.abs(a.index - middle) - Math.abs(b.index - middle))[0];
      return { stop: via(pick), fallback: fallback ? via(fallback.id) : null, termini: new Set([...termini].map((id) => normaliseName(names.get(id) ?? id))) };
    });
    return { vias, failed };
  }

  private async pass(args: {
    fromPlace: string; toPlace: string; via: Via | null; termini: Set<string>; modes: string[]; date: string; start: number; end: number;
    found: Map<string, Service>; unverified: Map<string, Unverified>; arrival: { ids: Set<string>; icsCodes: Set<string> };
  }): Promise<Pass> {
    const { fromPlace, toPlace, via, termini, modes, date, start, end, found, unverified, arrival } = args;
    const pass: Pass = { via, calls: 0, from_cache: 0, services_found: 0, ...(via ? { split_at_via: 0 } : {}), searched_to: null, stopped: 'window_end' };
    const mine = new Set<string>();
    const split = new Set<string>();
    const cap = via ? VIA_PASS_CALLS : MAIN_PASS_CALLS;
    let time = start;
    while (time < end) {
      if (pass.calls >= cap) { pass.stopped = 'call_cap'; break; }
      pass.calls++;
      const params = {
        date: date.replaceAll('-', ''), time: clockTime(time).replace(':', ''), timeIs: 'Departing',
        mode: modes.join(','), nationalSearch: 'true', calcOneDirection: 'true', applyHtmlMarkup: 'false',
        ...(via ? { via: via.id } : {}),
      };
      if (this.tfl.journeyCached(fromPlace, toPlace, params, TIMETABLE_TTL_MS)) pass.from_cache++;
      let raw: unknown;
      try {
        raw = await this.tfl.journey(fromPlace, toPlace, params, TIMETABLE_TTL_MS).catch(async (error) => {
          if (!(error instanceof TflError) || error.status !== 429) throw error;
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
          pass.calls++;
          return this.tfl.journey(fromPlace, toPlace, params, TIMETABLE_TTL_MS);
        });
      } catch (error) {
        // A bad date fails every call alike, so it is the caller's error rather than an incomplete pass.
        const validation = (error as { validation?: string }).validation;
        if (error instanceof TflError && error.status === 400 && (validation === 'date_time' || validation === 'date_range')) throw error;
        pass.stopped = error instanceof TflError && error.status === 429 ? 'rate_limited' : 'error';
        break;
      }
      const parsed = plannerResult.safeParse(raw);
      if (!parsed.success || !parsed.data.journeys.length) { pass.stopped = 'no_more_journeys'; break; }
      let latest = time;
      for (const journey of parsed.data.journeys) {
        latest = Math.max(latest, this.minuteOf(journey.startDateTime, date));
        const rides = journey.legs.filter((leg) => leg.mode.id !== 'walking');
        if (via && rides.length > 1 && this.splitAt(rides[0]!, via, termini, modes, date, start, end)) split.add(rides[0]!.departureTime);
        if (rides.length !== 1 || !modes.includes(rides[0]!.mode.id)) continue;
        const leg = rides[0]!;
        const departure = this.minuteOf(leg.departureTime, date);
        if (departure < start || departure >= end) continue;
        const option = leg.routeOptions[0];
        const operator = option?.name ?? option?.lineIdentifier?.name ?? 'Unknown';
        const line = option?.lineIdentifier?.id ?? 'unknown';
        // One leg is one train. Its calling points must reach the arrival station and it must name where it terminates.
        const calls = leg.path?.stopPoints ?? [];
        const terminus = option?.directions?.[0];
        const last = calls.at(-1);
        // TfL can leave the ID off the last calling point (the Elizabeth line at Liverpool Street); the leg's arrival
        // point then still names the station, by NaPTAN ID or by the ICS code of the station or its interchange.
        const arrives = last?.id ? arrival.ids.has(last.id)
          : arrival.ids.has(leg.arrivalPoint?.naptanId ?? '') || arrival.icsCodes.has(leg.arrivalPoint?.icsCode ?? '');
        const problem = !terminus ? 'TfL gives no terminus for this train'
          : !last ? 'TfL gives no calling points for this train'
            : !arrives ? 'its calling points do not end at the arrival station' : null;
        if (problem) {
          unverified.set(`${clockTime(departure)}|${operator}`, { departure: clockTime(departure), operator, line, reason: problem });
          continue;
        }
        const service: Service = {
          departure: clockTime(departure), arrival: clockTime(this.minuteOf(leg.arrivalTime, date)), duration_minutes: leg.duration, stops: calls.length,
          operator, line, mode: leg.mode.id, destination: placeName(terminus!), platform: leg.departurePoint?.platformName || null,
        };
        const key = `${service.departure}|${service.line}|${service.destination}`;
        mine.add(key);
        if (!found.has(key)) found.set(key, service);
      }
      pass.searched_to = clockTime(Math.min(latest, 24 * 60 - 1));
      time = Math.max(latest + 1, time + 1);
    }
    pass.services_found = mine.size;
    if (via) pass.split_at_via = split.size;
    return pass;
  }

  /**
   * Whether a journey's first train left in the window and was cut at the via stop, though it terminates where a
   * route through this corridor and the arrival station ends: likely a direct train the planner split.
   */
  private splitAt(leg: z.infer<typeof plannerLeg>, via: Via, termini: Set<string>, modes: string[], date: string, start: number, end: number) {
    const departure = this.minuteOf(leg.departureTime, date);
    const terminus = leg.routeOptions[0]?.directions?.[0];
    return departure >= start && departure < end && modes.includes(leg.mode.id) && leg.path?.stopPoints.at(-1)?.id === via.id
      && !!terminus && termini.has(normaliseName(terminus));
  }

  /** Minutes after midnight on the requested date for a TfL local timestamp (next-day times run past 24:00). */
  private minuteOf(timestamp: string, date: string) {
    const day = timestamp.slice(0, 10) === date ? 0 : timestamp.slice(0, 10) > date ? 1440 : -1440;
    return day + minutes(timestamp.slice(11, 16));
  }
}

export function defaultSources(tfl: TflClient, retryDelayMs?: number): TimetableSource[] {
  return [new LineTimetableSource(tfl), new JourneyPlannerSource(tfl, retryDelayMs)];
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const lineMatches = (wanted: string, line: { id: string; name: string }) => slug(wanted) === line.id || slug(wanted) === slug(line.name);

function directLines(from: Station, to: Station): LineRef[] {
  const lines = new Map<string, LineRef>();
  for (const fromStop of from.stops) {
    for (const line of fromStop.lines) {
      const toStop = to.stops.find((stop) => stop.id !== fromStop.id && stop.lines.some((other) => other.id === line.id));
      if (toStop && !lines.has(line.id)) lines.set(line.id, { ...line, fromStop: fromStop.id, toStop: toStop.id });
    }
  }
  return [...lines.values()];
}

function summarise(services: Service[], start: number, end: number) {
  const perHour = [];
  for (let hour = Math.floor(start / 60); hour * 60 < end; hour++) {
    const inHour = services.filter((service) => Math.floor(minutes(service.departure) / 60) === hour % 24);
    const byOperator: Record<string, number> = {};
    for (const service of inHour) byOperator[service.operator] = (byOperator[service.operator] ?? 0) + 1;
    perHour.push({ hour: clockTime(hour * 60), from: clockTime(Math.max(hour * 60, start)), to: clockTime(Math.min(hour * 60 + 60, end)), total: inHour.length, by_operator: byOperator });
  }
  let gap: { minutes: number; after: string; before: string } | null = null;
  for (let index = 1; index < services.length; index++) {
    const length = minutes(services[index]!.departure) - minutes(services[index - 1]!.departure);
    if (!gap || length > gap.minutes) gap = { minutes: length, after: services[index - 1]!.departure, before: services[index]!.departure };
  }
  return { per_hour: perHour, longest_gap: gap };
}

const describeStation = (station: Station, input?: string, matchedBy?: string) => ({ id: station.id, name: station.name, ...(input ? { input, matched_by: matchedBy } : {}) });
const unresolved = (resolution: Awaited<ReturnType<typeof resolveStation>>) =>
  resolution.status === 'ambiguous' ? { status: 'ambiguous', candidates: resolution.candidates as Candidate[], truncated: resolution.truncated } : { status: resolution.status };

/** Lines at a station, for telling a line that serves only one end from a name that matches nothing. */
const linesAt = (station: Station) => station.stops.flatMap((stop) => stop.lines);

/** Every direct service between two stations in a window, from whichever sources cover their lines. */
export async function buildTimetable(tfl: TflClient, query: TimetableQuery, sources = defaultSources(tfl)) {
  const [fromResolution, toResolution] = await Promise.all([resolveStation(tfl, query.from), resolveStation(tfl, query.to)]);
  if (fromResolution.status !== 'ok' || toResolution.status !== 'ok') {
    const ambiguous = fromResolution.status === 'ambiguous' || toResolution.status === 'ambiguous';
    return {
      status: ambiguous ? 'needs_disambiguation' : 'station_not_found',
      from: fromResolution.status === 'ok' ? describeStation(fromResolution.station) : unresolved(fromResolution),
      to: toResolution.status === 'ok' ? describeStation(toResolution.station) : unresolved(toResolution),
      next_action: ambiguous
        ? 'Retry with the intended candidate id for each ambiguous station. Ask the user if intent is unclear; do not guess.'
        : 'No station matches. Check the spelling, or use a CRS code or TfL stop ID. Streets, postcodes and bus stops are not stations.',
    };
  }
  const from = fromResolution.station;
  const to = toResolution.station;
  const start = minutes(query.start_time);
  const end = minutes(query.end_time);
  const stations = { from: describeStation(from, query.from, fromResolution.matched_by), to: describeStation(to, query.to, toResolution.matched_by) };
  let lines = directLines(from, to);
  const unmatched = (query.operators ?? []).filter((wanted) => !lines.some((line) => lineMatches(wanted, line)));
  const servesOneEnd = unmatched.flatMap((wanted) => {
    const station = [from, to].find((candidate) => linesAt(candidate).some((line) => lineMatches(wanted, line)));
    const line = station && linesAt(station).find((item) => lineMatches(wanted, item));
    return station && line ? [{ operator: wanted, line: line.id, name: line.name, serves_only: station.name }] : [];
  });
  const unknownOperators = unmatched.filter((wanted) => !servesOneEnd.some((item) => item.operator === wanted));
  const operatorReport = {
    ...(unknownOperators.length ? { unknown_operators: unknownOperators } : {}),
    ...(servesOneEnd.length ? { operators_not_serving_both: servesOneEnd } : {}),
    ...(unmatched.length ? { operators_note: 'unknown_operators match no line at either station in TfL\'s data: check the spelling or use a line ID from lines_at_both. operators_not_serving_both are real lines that call at only one of the two stations (serves_only), so they have no direct train here.' } : {}),
  };
  if (query.operators) lines = lines.filter((line) => query.operators!.some((wanted) => lineMatches(wanted, line)));
  if (!lines.length) {
    return {
      status: 'no_direct_line', ...stations, services: [],
      ...operatorReport,
      lines_at_both: directLines(from, to).map((line) => ({ id: line.id, name: line.name, mode: line.mode })),
      next_action: 'No line in TfL\'s station data serves both stations (with this operator filter). Use plan_journey for a trip with changes, or check the operator names in lines_at_both.',
    };
  }

  const services: Service[] = [];
  const reports: SourceReport[] = [];
  const unverified: Unverified[] = [];
  // Services from a dated source (the journey planner), the only ones for which the platform note applies.
  const dated = new Set<Service>();
  let pending = lines;
  for (const source of sources) {
    const mine = pending.filter((line) => source.handles(line));
    if (!mine.length) continue;
    const result = await source.collect({ from, to, lines: mine, date: query.date, start, end });
    services.push(...result.services);
    if (result.reports.some((report) => report.schedule_basis === 'dated')) for (const service of result.services) dated.add(service);
    reports.push(...result.reports);
    unverified.push(...(result.unverified ?? []));
    pending = [...pending.filter((line) => !mine.includes(line)), ...result.unserved];
  }

  const wanted = (service: Service) => !query.operators || query.operators.some((name) => lineMatches(name, { id: service.line, name: service.operator }));
  const seen = new Set<string>();
  const listed = services.filter(wanted)
    .sort((a, b) => minutes(a.departure) - minutes(b.departure) || a.operator.localeCompare(b.operator))
    .filter((service) => {
      const key = `${service.departure}|${service.line}|${service.destination}`;
      return !seen.has(key) && seen.add(key);
    });
  const shownUnverified = unverified.filter((item) => !query.operators || query.operators.some((name) => lineMatches(name, { id: item.line, name: item.operator })));
  // An unverified train may well be real, so a list that leaves any out cannot claim to be complete.
  const complete = reports.every((report) => report.complete) && pending.length === 0 && shownUnverified.length === 0;
  const bases = [...new Set(reports.map((report) => report.schedule_basis).filter(Boolean))];
  return {
    status: listed.length ? 'ok' : 'no_services', ...stations,
    window: { date: query.date, start: query.start_time, end: query.end_time, rule: 'departures at or after start and before end' },
    services: listed.slice(0, MAX_SERVICES), services_truncated: listed.length > MAX_SERVICES, count: listed.length,
    ...summarise(listed, start, end),
    schedule_basis: bases.length === 1 ? bases[0] : 'mixed',
    ...(shownUnverified.length ? { unverified: shownUnverified.slice(0, 20), unverified_note: 'Left out of services and counts: TfL returned these but they could not be shown to be one train calling at both stations. They may be real trains, so the list is marked incomplete; check one with plan_journey.' } : {}),
    completeness: {
      complete,
      method: reports.map((report) => `${report.source}: ${report.lines.join(', ')}`).join('; '),
      sources: reports,
      ...(pending.length ? { unserved_lines: pending.map((line) => line.id) } : {}),
      ...(shownUnverified.length ? { unverified_trains: shownUnverified.length, unverified_reason: `${shownUnverified.length} train(s) in unverified may be real direct services that this list leaves out.` } : {}),
      ...(listed.some((service) => dated.has(service)) ? { platforms: 'TfL publishes no National Rail platforms in advance; platform is null unless the source gives one.' } : {}),
    },
    ...operatorReport,
    ...(listed.length ? {} : { next_action: 'No direct service departs in this window. Widen the window, check line_status for closures, or use plan_journey for a trip with changes.' }),
  };
}
