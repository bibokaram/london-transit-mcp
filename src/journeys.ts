import { z } from 'zod';
import { type PlaceResolution, placeForPlanner, stationsFirst } from './stations.js';
import { TflClient, TflError } from './tfl.js';

export const placeSchema = z.string().trim().min(1).max(120)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..', 'Use a place name, postcode, coordinates or stop ID.')
  .describe('A saved place label such as "home" or "work" (listed by get_context), UK postcode, station/place name, TfL stop/ICS ID, HUB interchange ID, or latitude,longitude. A name that matches a rail or Tube station exactly (e.g. "London Bridge") plans from that station. Postcodes include walking at that endpoint; station-to-station results are not door-to-door. Reuse a disambiguation candidate value verbatim.');

export const timeSchema = {
  at: z.iso.datetime({ offset: true }).optional()
    .describe('Full ISO timestamp with Z or an explicit UTC offset, e.g. 2026-11-10T08:00:00+00:00. Converted to Europe/London including daylight saving. Omit for now. Resolve relative dates before calling; a future result is a plan, not a live prediction.'),
  time_is: z.enum(['departing', 'arriving']).default('departing')
    .describe('Whether at is a departure time or an arrive-by deadline. Arriving requires an explicit at. Batch origins all use this same criterion.'),
};

/** Modes a caller can keep out of a planned route. bus also covers rail replacement buses. */
export const EXCLUDABLE_MODES = ['bus', 'tube', 'national-rail', 'overground', 'elizabeth-line', 'dlr', 'tram', 'river-bus', 'cable-car'] as const;
export type ExcludableMode = (typeof EXCLUDABLE_MODES)[number];
/** What the planner is told to use when anything is excluded. Walking is always allowed: every route needs it. */
const PLANNER_MODES = ['tube', 'overground', 'elizabeth-line', 'dlr', 'national-rail', 'tram', 'bus', 'replacement-bus', 'river-bus', 'cable-car', 'walking'];
/** The planner modes one excludable mode removes. */
const plannerModesOf = (mode: ExcludableMode) => (mode === 'bus' ? ['bus', 'replacement-bus'] : [mode]);
const PREFERENCES = { fastest: 'leasttime', fewest_changes: 'leastinterchange', least_walking: 'leastwalking' } as const;

export const routeSchema = {
  exclude_modes: z.array(z.enum(EXCLUDABLE_MODES)).max(EXCLUDABLE_MODES.length - 1).optional()
    .describe('Modes no returned route may use, e.g. ["bus"]; bus also removes rail replacement buses. Enforced by the server: TfL is asked for routes without them and any route still using one is dropped, so a result never contains an excluded mode. It adds to the owner\'s saved travel preference, which always applies as well: for "no tube today" pass ["tube"] and any saved avoidance (say buses) still holds, so never repeat saved modes here. mode_filter shows what was left out and why, and names a much faster route the saved preference hid. To let the saved modes back in for one call, use ignore_preference. Keep a one-off exclusion on every planning call for as long as the user tied it to ("today", "this trip"). Excluding a mode usually means more walking or a longer trip, so compare walking_minutes and say what the exclusion cost.'),
  ignore_preference: z.boolean().optional()
    .describe('true plans this one call as if no travel preference were saved, so the modes the owner normally avoids may be used. Only when the user asks for it ("include buses this time") or accepts it after nothing else gets there. exclude_modes still applies.'),
  preference: z.enum(['fastest', 'fewest_changes', 'least_walking']).default('fastest')
    .describe('What TfL optimises: fastest (default), fewest_changes, or least_walking. fewest_changes favours a single long bus ride where one exists, so pair it with exclude_modes when buses are unwanted.'),
};

export const journeySchema = z.object({
  from: placeSchema,
  to: placeSchema,
  ...timeSchema,
  ...routeSchema,
  max_routes: z.number().int().min(1).max(3).default(3)
    .describe('Maximum TfL alternatives returned, in TfL order, 1–3. These are planner suggestions, not a guarantee of an exhaustive or fastest route.'),
}).strict().refine((value) => value.time_is !== 'arriving' || value.at !== undefined, {
  message: 'An arrive-by journey requires at with an explicit timestamp.', path: ['at'],
});

export type JourneyQuery = z.infer<typeof journeySchema>;

const point = z.object({ commonName: z.string().optional(), naptanId: z.string().optional(), lat: z.number().optional(), lon: z.number().optional() });
/** Something the planner accepts for this point again: its stop ID, or its coordinates. */
const pointId = (value: z.infer<typeof point>) => value.naptanId || (value.lat !== undefined && value.lon !== undefined ? `${value.lat.toFixed(5)},${value.lon.toFixed(5)}` : null);
const disruption = z.object({ description: z.string().optional(), summary: z.string().optional() });
const leg = z.object({
  duration: z.number().nonnegative(),
  departureTime: z.string(), arrivalTime: z.string(),
  departurePoint: point, arrivalPoint: point,
  mode: z.object({ id: z.string() }),
  instruction: z.object({ summary: z.string().optional() }).optional(),
  routeOptions: z.array(z.object({
    name: z.string().optional(),
    lineIdentifier: z.object({ id: z.string().optional() }).nullish(),
  })).default([]),
  disruptions: z.array(disruption).default([]),
  plannedWorks: z.array(disruption).default([]),
  isDisrupted: z.boolean().optional(),
});
const ambiguity = z.object({
  disambiguationOptions: z.array(z.object({
    parameterValue: z.string(),
    place: z.object({ commonName: z.string().optional(), modes: z.array(z.string()).optional() }),
  })).default([]),
});
const itinerary = z.object({
  journeys: z.array(z.object({
    duration: z.number().nonnegative(), startDateTime: z.string(), arrivalDateTime: z.string(),
    legs: z.array(leg).min(1),
  })).optional(),
  fromLocationDisambiguation: ambiguity.optional(),
  toLocationDisambiguation: ambiguity.optional(),
});

function text(value: string | undefined, limit = 600) {
  return (value ?? '').replace(/<[^>]*>/g, '').slice(0, limit);
}

/** TfL place names can carry doubled spaces ("Victoria  Station"). */
function placeName(value: string | undefined, limit = 160) {
  return text(value, limit).replace(/\s+/g, ' ').trim();
}

export function londonTime(at: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (kind: string) => parts.find((item) => item.type === kind)!.value;
  return { date: `${part('year')}${part('month')}${part('day')}`, time: `${part('hour')}${part('minute')}` };
}

/** Minutes Europe/London is ahead of UTC at this instant: 0 in GMT, 60 in BST. */
function londonOffsetMinutes(instant: number) {
  const { date, time } = londonTime(new Date(instant).toISOString());
  const local = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2), +time.slice(2, 4));
  return Math.round((local - Math.floor(instant / 60_000) * 60_000) / 60_000);
}

/** The planner gives London wall-clock times with no offset ("2026-11-12T14:00:00"); add it, so they read like every other time. */
export function withLondonOffset(local: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(local)) return local;
  const asUtc = Date.parse(`${local}Z`);
  const offset = londonOffsetMinutes(asUtc - londonOffsetMinutes(asUtc) * 60_000);
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return `${local}${offset < 0 ? '-' : '+'}${hours}:${minutes}`;
}

/** Partly matched stations offered for one ambiguous endpoint, leaving room for TfL's own candidates. */
const MAX_STATION_CANDIDATES = 5;

/** Looks a from/to value up among the owner's saved places; undefined when it is not a saved label. */
export type SavedPlaceLookup = (label: string) => { label: string; place: string } | undefined;

/**
 * The owner's stored settings a plan draws on. avoidModes applies when the call names no exclusion; with
 * compareAvoided the result also says what a route using those modes would save, so the preference never hides
 * a much faster trip.
 */
export type PlanContext = { savedPlace?: SavedPlaceLookup; avoidModes?: ExcludableMode[]; compareAvoided?: boolean; /** Plan with these planner modes alone: how one leg is timed on one line. */ onlyModes?: string[] };
/** A faster route is worth mentioning from this many minutes saved. */
const WORTH_MENTIONING_MINUTES = 5;

export async function planJourney(tfl: TflClient, query: JourneyQuery, { savedPlace = () => undefined, avoidModes = [], compareAvoided = false, onlyModes }: PlanContext = {}) {
  // A saved label ("home") stands for the place stored under it, which is then resolved like any other input.
  const endpoint = async (input: string): Promise<PlaceResolution & { saved_place?: string }> => {
    const saved = savedPlace(input);
    if (!saved) return placeForPlanner(tfl, input);
    return { ...await placeForPlanner(tfl, saved.place), input, saved_place: saved.label };
  };
  const [from, to] = await Promise.all([endpoint(query.from), endpoint(query.to)]);
  // What this call rules out and what the owner always avoids add up; neither replaces the other.
  const requested = [...new Set(query.exclude_modes ?? [])];
  const preferred = query.ignore_preference ? [] : avoidModes.filter((mode) => !requested.includes(mode));
  const excluded = [...requested, ...preferred];
  const fromPreference = preferred.length > 0;
  const banned = new Set(excluded.flatMap(plannerModesOf));
  const requestBanned = new Set(requested.flatMap(plannerModesOf));
  const filter: Record<string, unknown> = {
    excluded,
    source: requested.length && fromPreference ? 'request_and_saved_preference' : fromPreference ? 'saved_preference' : requested.length ? 'request' : 'none',
    ...(requested.length && fromPreference ? { from_request: requested, from_saved_preference: preferred } : {}),
    ...(query.ignore_preference && avoidModes.length ? { preference_ignored: avoidModes } : {}),
  };
  const modeFilter = { mode_filter: filter };
  const plannerParams = {
    ...londonTime(query.at!), timeIs: query.time_is,
    nationalSearch: 'true', useRealTimeLiveArrivals: 'true', applyHtmlMarkup: 'false', calcOneDirection: 'true',
    ...(query.preference && query.preference !== 'fastest' ? { journeyPreference: PREFERENCES[query.preference] } : {}),
  };
  const entry = (place: PlaceResolution & { saved_place?: string }) => ({
    input: place.input, used: place.value, ...(place.resolved_by ? { name: place.name, resolved_by: place.resolved_by } : {}),
    ...(place.saved_place ? { saved_place: place.saved_place } : {}),
  });
  const resolution = { resolved: { from: entry(from), to: entry(to) } };
  const parsed = itinerary.safeParse(await tfl.journey(from.value, to.value, {
    ...plannerParams,
    ...(onlyModes ? { mode: onlyModes.join(',') } : banned.size ? { mode: PLANNER_MODES.filter((mode) => !banned.has(mode)).join(',') } : {}),
  }));
  if (!parsed.success) throw new TflError(502);
  const raw = parsed.data;
  // TfL's candidates for a loose name are mostly streets and places; the stations the name matched go first,
  // by ICS code, so the caller can pick a station.
  const candidates = (value: z.infer<typeof ambiguity>, place: PlaceResolution) => {
    const planner = value.disambiguationOptions.map((option) => ({
      value: text(option.parameterValue, 120), name: placeName(option.place.commonName),
      modes: (option.place.modes ?? []).slice(0, 8).map((mode) => text(mode, 40)),
    }));
    const stations = (place.stations ?? []).filter((station) => !planner.some((option) => option.value === station.value))
      .slice(0, MAX_STATION_CANDIDATES)
      .map((station) => ({ value: station.value, name: placeName(station.name), modes: station.modes.slice(0, 8) }));
    const options = stationsFirst([...stations, ...planner]);
    return { options: options.slice(0, 8), truncated: options.length > 8 };
  };
  const ambiguous = (value: z.infer<typeof ambiguity> | undefined): value is z.infer<typeof ambiguity> => Boolean(value?.disambiguationOptions.length);
  if (ambiguous(raw.fromLocationDisambiguation) || ambiguous(raw.toLocationDisambiguation)) {
    return {
      status: 'needs_disambiguation', ...resolution, ...modeFilter,
      ...(ambiguous(raw.fromLocationDisambiguation) ? { from: candidates(raw.fromLocationDisambiguation, from) } : {}),
      ...(ambiguous(raw.toLocationDisambiguation) ? { to: candidates(raw.toLocationDisambiguation, to) } : {}),
      next_action: 'Choose the intended candidate for each ambiguous endpoint and retry with its value. Ask the user if intent is unclear; do not guess.',
    };
  }
  if (!raw.journeys) throw new TflError(502);
  // The exclusion is a guarantee, so it does not rest on TfL honouring the mode list.
  const allowed = raw.journeys.filter((route) => !route.legs.some((item) => banned.has(item.mode.id)));
  const dropped = raw.journeys.length - allowed.length;
  const routes = allowed.slice(0, query.max_routes).map((route) => {
    const disruptions = [...new Set(route.legs.flatMap((item) =>
      [...item.disruptions, ...item.plannedWorks].map((issue) => text(issue.description || issue.summary)).filter(Boolean),
    ))];
    const transitLegs = route.legs.filter((item) => item.mode.id !== 'walking');
    return {
      duration_minutes: route.duration, departure: withLondonOffset(route.startDateTime), arrival: withLondonOffset(route.arrivalDateTime),
      walking_minutes: route.legs.filter((item) => item.mode.id === 'walking').reduce((sum, item) => sum + item.duration, 0),
      changes: Math.max(0, transitLegs.length - 1),
      disrupted: route.legs.some((item) => item.isDisrupted) || disruptions.length > 0,
      disruptions: disruptions.slice(0, 5), disruptions_truncated: disruptions.length > 5,
      legs: route.legs.slice(0, 16).map((item) => ({
        mode: text(item.mode.id, 40), from: placeName(item.departurePoint.commonName),
        to: placeName(item.arrivalPoint.commonName),
        from_id: pointId(item.departurePoint), to_id: pointId(item.arrivalPoint), duration_minutes: item.duration,
        departure: withLondonOffset(item.departureTime), arrival: withLondonOffset(item.arrivalTime),
        instruction: text(item.instruction?.summary, 200),
        // TfL gives walking legs one route option with an empty name.
        lines: item.routeOptions.map((option) => text(option.name, 80)).filter(Boolean).slice(0, 4),
        line_ids: item.routeOptions.map((option) => text(option.lineIdentifier?.id, 40)).filter(Boolean).slice(0, 4),
      })),
      legs_truncated: route.legs.length > 16,
    };
  });
  // A saved preference was applied without being asked for, so say what it cost: the fastest route that ignores it.
  if (fromPreference && compareAvoided) {
    try {
      const open = itinerary.safeParse(await tfl.journey(from.value, to.value, {
        ...plannerParams, ...(requestBanned.size ? { mode: PLANNER_MODES.filter((mode) => !requestBanned.has(mode)).join(',') } : {}),
      }));
      const best = (open.success ? open.data.journeys ?? [] : [])
        .filter((route) => route.legs.some((item) => banned.has(item.mode.id)) && !route.legs.some((item) => requestBanned.has(item.mode.id)))
        .sort((a, b) => a.duration - b.duration)[0];
      const ours = routes.length ? Math.min(...routes.map((route) => route.duration_minutes)) : null;
      if (best && (ours === null || ours - best.duration >= WORTH_MENTIONING_MINUTES)) {
        filter.faster_with_avoided_modes = {
          duration_minutes: best.duration, ...(ours === null ? {} : { saves_minutes: ours - best.duration }),
          walking_minutes: best.legs.filter((item) => item.mode.id === 'walking').reduce((sum, item) => sum + item.duration, 0),
          uses: [...new Set(best.legs.map((item) => item.mode.id).filter((mode) => banned.has(mode)))],
          note: 'Tell the user this option exists. Call again with ignore_preference: true to see it if they want it.',
        };
      }
    } catch (error) {
      // The comparison is extra; the plan stands without it.
      if (!(error instanceof TflError)) throw error;
    }
  }
  return {
    status: routes.length ? 'ok' : 'no_journeys', ...resolution, ...modeFilter, routes,
    routes_truncated: allowed.length > query.max_routes,
    ...(dropped ? { routes_dropped_for_excluded_modes: dropped } : {}),
    ...(routes.length ? {} : {
      next_action: excluded.length
        ? `No route avoids ${excluded.join(', ')} for these endpoints and time. Tell the user, and retry with fewer exclusions (ignore_preference: true for saved ones) only if they accept ${excluded.length === 1 ? 'that mode' : 'those modes'}; do not interpret this as a suspension.`
        : 'No route was returned for these endpoints and time. Check the places and travel time; do not interpret this as a suspension.',
    }),
  };
}

export async function mapConcurrent<Input, Output>(items: Input[], concurrency: number, run: (item: Input) => Promise<Output>) {
  const results = new Array<Output>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index]!);
    }
  }));
  return results;
}
