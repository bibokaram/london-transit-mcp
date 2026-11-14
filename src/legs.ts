import { z } from 'zod';
import { placeSchema, planJourney, type SavedPlaceLookup } from './journeys.js';
import type { TrackedLeg, TrackedRoute } from './store.js';

type PlannedRoute = Extract<Awaited<ReturnType<typeof planJourney>>, { routes: unknown }>['routes'][number];
import { TflClient } from './tfl.js';

/**
 * A journey as its owner means it: an ordered list of legs, each "get to this place by this line". TfL's planner
 * picks whole routes and cannot be told to use or avoid one line, so a leg plan is timed one leg at a time, each
 * starting where and when the last one ended. That lets a caller construct a route TfL would not suggest, swap
 * one leg for another line, and ask how their own route is doing rather than what TfL would do instead.
 */
export const legSpecSchema = z.object({
  to: placeSchema.describe('Where this leg ends: a station name, a stop or station ID (the to_id of a leg in any journey result), a saved place label, a postcode or coordinates. The next leg starts here.'),
  by: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,40}$/)
    .describe('How to travel this leg: a line or route ID exactly as line_ids gives it in journey results (jubilee, thameslink, windrush, elizabeth, dlr, southern, a bus route such as 436), a mode (tube, bus, national-rail, overground, elizabeth-line, dlr, tram, river-bus, cable-car) when any line of that mode will do, or walk. A named line means one direct service on that line, no change.'),
}).strict();
export type LegSpec = z.infer<typeof legSpecSchema>;

/**
 * The planner shows about three options and drops a train another one beats or ties, so where lines share
 * track (Circle, Hammersmith & City and Metropolitan at Farringdon) the wanted line can be missing from the
 * first answer. It is asked again from just after the first departure it offered, this many times in all.
 */
const ATTEMPTS = 3;
const MODES = ['tube', 'overground', 'elizabeth-line', 'dlr', 'national-rail', 'tram', 'bus', 'river-bus', 'cable-car'];

/** What a leg's "by" asks for: a mode, and a line within it when one is named. */
async function wanted(tfl: TflClient, by: string): Promise<{ mode: string; line?: string } | undefined> {
  if (by === 'walk' || by === 'walking') return { mode: 'walking' };
  if (MODES.includes(by)) return { mode: by };
  const line = (await tfl.networkStatus()).find((item) => item.id === by);
  if (line) return { mode: line.mode, line: by };
  // Bus and river bus routes have no status entry to look up: 436, n381, c10, rb1.
  if (/^rb\d{1,2}[a-z]?$/.test(by)) return { mode: 'river-bus', line: by };
  if (/^[a-z]{0,2}\d{1,3}[a-z]?$/.test(by)) return { mode: 'bus', line: by };
  return undefined;
}

export type BuiltJourney =
  | { status: 'ok'; route: TrackedRoute; leg_spec_index: number[] }
  | { status: 'leg_failed'; leg: number; spec: LegSpec; reason: string; tfl_offered?: string[]; candidates?: unknown; legs_timed: number };

/** Times a leg plan from a starting point and moment, one planner call per leg. */
export async function buildLegs(tfl: TflClient, origin: string, at: number, specs: LegSpec[], savedPlace?: SavedPlaceLookup): Promise<BuiltJourney> {
  const legs: TrackedLeg[] = [];
  const specIndex: number[] = [];
  const disruptions = new Set<string>();
  let disrupted = false;
  let from = origin;
  let ready = at;
  for (const [index, spec] of specs.entries()) {
    const fail = (reason: string, extra: Record<string, unknown> = {}): BuiltJourney => ({ status: 'leg_failed', leg: index + 1, spec, reason, legs_timed: index, ...extra });
    const want = await wanted(tfl, spec.by);
    if (!want) return fail(`"${spec.by}" is not a line, route or mode this server knows. Use a line_ids value from a journey result, a mode name, or walk.`);
    let pick: PlannedRoute | undefined;
    let routes: PlannedRoute[] = [];
    const offeredLines = new Set<string>();
    for (let attempt = 0, askFrom = ready; attempt < ATTEMPTS && !pick; attempt++) {
      const plan = await planJourney(tfl, { from, to: spec.to, at: new Date(askFrom).toISOString(), time_is: 'departing', max_routes: 3, preference: 'fastest' },
        { savedPlace, onlyModes: want.mode === 'walking' ? ['walking'] : [want.mode, 'walking'] });
      if (plan.status === 'needs_disambiguation') return fail(`"${spec.to}" matches more than one place. Use one of the candidate values.`, { candidates: 'to' in plan ? plan.to : ('from' in plan ? plan.from : undefined) });
      routes = 'routes' in plan ? plan.routes : [];
      pick = routes.filter((route) => {
        const transit = route.legs.filter((leg) => leg.mode !== 'walking');
        if (want.mode === 'walking') return transit.length === 0;
        if (want.line) return transit.length === 1 && transit[0]!.line_ids.includes(want.line);
        return transit.length >= 1 && transit.every((leg) => leg.mode === want.mode);
      }).sort((a, b) => Date.parse(a.arrival) - Date.parse(b.arrival))[0];
      for (const route of routes) offeredLines.add(route.legs.filter((leg) => leg.mode !== 'walking').map((leg) => leg.line_ids[0] ?? leg.mode).join(' then ') || 'walk');
      // Only a named line is worth asking for again: the next few minutes may hold its train.
      const firstDepartures = routes.flatMap((route) => route.legs.filter((leg) => leg.mode !== 'walking').slice(0, 1).map((leg) => Date.parse(leg.departure)));
      if (!want.line || firstDepartures.length === 0) break;
      askFrom = Math.min(...firstDepartures) + 60_000;
    }
    if (!pick) {
      const what = want.line ? `direct ${spec.by} service` : want.mode === 'walking' ? 'walking route' : `route by ${spec.by} alone`;
      return fail(offeredLines.size
        ? `TfL's planner returned no ${what} from the previous point to "${spec.to}" around that time. It offered other options (tfl_offered); the line may not serve both places directly, may be disrupted, or may be one TfL's planner does not show because another is faster.`
        : `TfL's planner returned nothing from the previous point to "${spec.to}" by ${spec.by} around that time.`, { tfl_offered: [...offeredLines] });
    }
    for (const leg of pick.legs) {
      legs.push(leg);
      specIndex.push(index);
    }
    pick.disruptions.forEach((item) => disruptions.add(item));
    disrupted ||= pick.disrupted;
    const last = pick.legs.at(-1)!;
    // Stop IDs chain exactly; without one the place as the caller named it is the next best starting point.
    from = last.to_id ?? spec.to;
    ready = Date.parse(pick.arrival);
  }
  return { status: 'ok', leg_spec_index: specIndex, route: routeOf(legs, [...disruptions], disrupted) };
}

/** A route's totals from its legs. */
function routeOf(legs: TrackedLeg[], disruptions: string[], disrupted: boolean): TrackedRoute {
  const departure = legs[0]!.departure;
  const arrival = legs.at(-1)!.arrival;
  const transit = legs.filter((leg) => leg.mode !== 'walking');
  return {
    duration_minutes: Math.round((Date.parse(arrival) - Date.parse(departure)) / 60_000), departure, arrival,
    walking_minutes: legs.filter((leg) => leg.mode === 'walking').reduce((sum, leg) => sum + leg.duration_minutes, 0),
    changes: Math.max(0, transit.length - 1), disrupted: disrupted || disruptions.length > 0, disruptions: [...new Set(disruptions)].slice(0, 5), legs,
  };
}

/**
 * Times an edited leg plan against the route it came from. Legs before the first changed one keep the times
 * they already have, and only the rest is asked of TfL, starting where and when the last kept leg ends: one
 * request per leg from the change onward, none for a route that was planned in a single call and not touched.
 */
export async function retimeFrom(
  tfl: TflClient, base: { route: TrackedRoute; leg_spec_index: number[]; from_value: string }, specs: LegSpec[], firstChanged: number, savedPlace?: SavedPlaceLookup,
): Promise<BuiltJourney> {
  const kept = base.route.legs.filter((_, index) => base.leg_spec_index[index]! < firstChanged);
  if (kept.length === 0) return buildLegs(tfl, base.from_value, Date.parse(base.route.departure), specs, savedPlace);
  const last = kept.at(-1)!;
  const rest = await buildLegs(tfl, last.to_id ?? specs[firstChanged - 1]!.to, Date.parse(last.arrival), specs.slice(firstChanged), savedPlace);
  if (rest.status === 'leg_failed') return { ...rest, leg: rest.leg + firstChanged, legs_timed: rest.legs_timed + firstChanged };
  return {
    status: 'ok',
    leg_spec_index: [...base.leg_spec_index.slice(0, kept.length), ...rest.leg_spec_index.map((index) => index + firstChanged)],
    route: routeOf([...kept, ...rest.route.legs], [...base.route.disruptions, ...rest.route.disruptions], rest.route.disrupted),
  };
}

/** The leg plan a planned route amounts to: one spec per leg, so it can be edited and built again. */
export function legPlanOf(route: TrackedRoute, destination: string): { leg_plan: LegSpec[]; leg_spec_index: number[] } {
  const leg_plan = route.legs.map((leg, index) => ({
    to: index === route.legs.length - 1 ? destination : leg.to_id ?? leg.to,
    by: leg.mode === 'walking' ? 'walk' : leg.line_ids[0] ?? leg.mode,
  }));
  return { leg_plan, leg_spec_index: route.legs.map((_, index) => index) };
}
