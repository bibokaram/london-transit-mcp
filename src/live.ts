import { z } from 'zod';
import {
  departureOrder, LIVE_MODES, LIVE_NATIONAL_RAIL_LINES, overdue, PREDICTED_MODES, SCHEDULED_MODES, SURFACE_MODES, TUBE_LINE_IDS,
  type Arrival, type RailDeparture, type RawStopPoint, type SurfaceArrival, TflClient, TflError,
} from './tfl.js';
import { crsOf, type RttClient, type RttDeparture, RttError, TFL_LIVE_OPERATORS } from './rtt.js';
import { crsStation, looksLikeStopId, normaliseName, resolveStation } from './stations.js';

export const liveSchema = {
  stop: z.string().trim().min(2).max(80).regex(/^[^\x00-\x1f\x7f]+$/).describe('The station, interchange, bus stop or pier: its name ("London Bridge", "Embankment Pier", "Camberwell Green"), a National Rail CRS code (LBG), or a TfL stop ID from an earlier result. A station name that matches one station is used directly and the result says which under stop. A name that matches several returns them as candidates with their IDs and modes instead of a board: pass the id of the one meant. Bus stops share names, so expect candidates for those. Not a postcode or coordinates.'),
  line: z.string().regex(/^[a-z0-9-]{1,40}$/).optional().describe('Optional exact TfL line or route ID, such as jubilee, elizabeth, mildmay, thameslink, dlr, a bus route (11, n381, c10) or a river bus route (rb1). Overground lines have their own IDs (liberty, lioness, mildmay, suffragette, weaver, windrush). At a HUB, a bus route adds that route\'s stops to the board.'),
  direction: z.enum(['Northbound', 'Southbound', 'Eastbound', 'Westbound']).optional().describe('Optional Tube compass direction. It filters only entries whose platform names a direction (Tube); entries of other modes are kept unfiltered and coverage_note says so, so filter those by line and read each destination. Omit if unknown.'),
  calling_at: z.string().trim().min(2).max(80).regex(/^[^\x00-\x1f\x7f]+$/).optional().describe('Only trains from stop_id that later call at this station: a CRS code (ECR), a 910G station ID or an exact station name. Answers "next trains from London Bridge to East Croydon" with live times and platforms. The board then comes from Realtime Trains alone and lists National Rail, Thameslink, Overground and Elizabeth line trains; Tube, DLR, tram, bus and boat entries are left off. Needs the National Rail feed (see get_context).'),
  limit: z.number().int().min(1).max(20).default(8).describe('Maximum departures across the filtered board, soonest first, 1–20. Filter line and direction before increasing this.'),
};
type LiveQuery = { stop_id: string; line?: string; direction?: string; calling_at?: string; limit: number };
type Departure = (Arrival & { mode: string }) | RailDeparture | SurfaceArrival | RttDeparture;

/** Modes a stop can be searched in when a name is not a station. */
export const SEARCH_MODES = ['tube', 'elizabeth-line', 'overground', 'dlr', 'tram', 'national-rail', 'bus', 'river-bus', 'cable-car'] as const;
const MAX_STOP_CANDIDATES = 8;
export type LiveStop =
  | { status: 'ok'; id: string; stop?: { input: string; id: string; name: string; matched_by: string } }
  | { status: 'ambiguous'; candidates: { id: string; name: string; modes: string[] }[]; truncated: boolean }
  | { status: 'not_found' };

/**
 * Turns what a caller typed for a stop into the ID a board is read by. An ID passes through; a station name or
 * CRS code resolves as it does for timetable; anything else is searched across every mode, bus stops included.
 * One clear match is used. Several are handed back for the caller to choose from, never picked silently.
 */
export async function resolveLiveStop(tfl: TflClient, input: string): Promise<LiveStop> {
  const value = input.trim();
  if (looksLikeStopId(value.toUpperCase())) return { status: 'ok', id: value.toUpperCase() };
  const station = await resolveStation(tfl, value);
  if (station.status === 'ok') return { status: 'ok', id: station.station.id, stop: { input: value, id: station.station.id, name: station.station.name, matched_by: station.matched_by } };
  if (station.status === 'ambiguous') return { status: 'ambiguous', candidates: station.candidates, truncated: station.truncated };
  const stops = await tfl.search(value, SEARCH_MODES);
  const exact = stops.filter((stop) => normaliseName(stop.name) === normaliseName(value));
  const pick = exact.length === 1 ? exact[0] : stops.length === 1 ? stops[0] : undefined;
  if (pick) return { status: 'ok', id: pick.id, stop: { input: value, id: pick.id, name: pick.name, matched_by: 'name' } };
  return stops.length ? { status: 'ambiguous', candidates: stops.slice(0, MAX_STOP_CANDIDATES), truncated: stops.length > MAX_STOP_CANDIDATES } : { status: 'not_found' };
}

/** At most this many station codes are read from Realtime Trains for one board, to stay inside its request allowance. */
const MAX_RTT_STATIONS = 2;
/** As on TfL's rail boards: a train with no estimate stays listed this long after its scheduled time. */
const STALE_DELAY_MS = 20 * 60 * 1000;

/** Why the National Rail feed gave nothing, in words a caller can act on. */
function rttFailure(error: RttError) {
  if (error.status === 429) return `Realtime Trains' request allowance is used up${error.retryAfterSeconds ? ` for about ${Math.ceil(error.retryAfterSeconds / 60)} more minute${error.retryAfterSeconds > 60 ? 's' : ''}` : ''}`;
  if (error.status === 401 || error.status === 403) return 'Realtime Trains rejected the server\'s token';
  return 'Realtime Trains did not answer';
}

/** The CRS code a calling_at value names: a code, a 910G station ID or an exactly matching station name. */
async function callingAtCode(tfl: TflClient, value: string): Promise<string | undefined> {
  const upper = value.toUpperCase();
  if (crsStation(upper)) return upper;
  if (upper.startsWith('910G')) return crsOf(upper);
  const resolved = await resolveStation(tfl, value);
  if (resolved.status !== 'ok') return undefined;
  return resolved.station.stops.map((stop) => crsOf(stop.id)).find(Boolean);
}

/** A prediction this far past its expected time has left; TfL's feed lags, so a few seconds late is kept. */
const PAST_GRACE_MS = 60_000;
const MODE_NAMES: Record<string, string> = {
  bus: 'bus', 'river-bus': 'river bus', 'elizabeth-line': 'Elizabeth line', overground: 'Overground', 'national-rail': 'Thameslink', dlr: 'DLR', tram: 'tram',
};

const CABLE_CAR_NOTE = 'The cable car has no live departures in TfL\'s feeds. Use timetable for its published timetable and line_status for disruption.';

/** National Rail lines at a stop, from its record, split into those TfL serves live (Thameslink) and the rest. */
function nationalRailLines(record: RawStopPoint | null) {
  const ids = record?.lineModeGroups?.filter((group) => group.modeName === 'national-rail').flatMap((group) => group.lineIdentifier ?? []) ?? [];
  const names = new Map((record?.lines ?? []).map((ref) => [ref.id, ref.name]));
  const named = [...new Set(ids)].map((id) => ({ id, name: names.get(id) ?? id }));
  return { live: named.filter((ref) => LIVE_NATIONAL_RAIL_LINES.has(ref.id)), other: named.filter((ref) => !LIVE_NATIONAL_RAIL_LINES.has(ref.id)) };
}

/**
 * The live board for a stop. Bus stops and piers are read from /Arrivals as TfL gives them; stations and hubs
 * merge Tube, DLR and tram predictions (with the board corrections) and Elizabeth line, Overground and
 * Thameslink departures. Other National Rail operators come from Realtime Trains when the server has a token
 * for it; without one they have no live source. The cable car never has one.
 */
export async function liveDepartures(tfl: TflClient, rtt: RttClient | undefined, { stop_id, line, direction, calling_at, limit }: LiveQuery): Promise<Record<string, unknown>> {
  const id = stop_id.toUpperCase();
  const surfaceStop = id.startsWith('490') || id.startsWith('930G');
  let record: RawStopPoint | null = null;
  try {
    record = await tfl.stopRecord(id);
  } catch (error) {
    // A bare bus stop or pier can still be read; for a station, an unknown record falls back to the Tube board.
    if (!(error instanceof TflError)) throw error;
  }
  const modes = surfaceStop ? [] : record?.modes ?? [];
  const has = (wanted: readonly string[]) => modes.some((mode) => wanted.includes(mode));
  const lineMode = line ? record?.lineModeGroups?.find((group) => group.lineIdentifier?.includes(line))?.modeName : undefined;
  const surfaceLine = (SURFACE_MODES as readonly string[]).includes(lineMode ?? '');
  const nationalRail = surfaceStop ? { live: [], other: [] } : nationalRailLines(record);
  // A National Rail line TfL has no live data for: there is nothing to read.
  const deadLine = line ? nationalRail.other.find((ref) => ref.id === line) : undefined;
  const knownLines = new Set([...(record?.lines ?? []).map((ref) => ref.id), ...(record?.lineModeGroups ?? []).flatMap((group) => group.lineIdentifier ?? [])]);
  const unlistedLine = Boolean(line && record && !knownLines.has(line));

  // Realtime Trains covers what TfL does not: every other operator, and any train filtered by a later stop.
  const unnamedRail = has(['national-rail']) && nationalRail.live.length + nationalRail.other.length === 0;
  const railGap = nationalRail.other.length > 0 || unnamedRail || (!record && id.startsWith('910G'));
  const tflLine = Boolean(line && !deadLine && !unlistedLine);
  const useRtt = Boolean(rtt?.configured) && !surfaceStop && !surfaceLine && (Boolean(calling_at) || (railGap && !tflLine && !unlistedLine));
  const rttNotes: string[] = [];
  let rttDepartures: RttDeparture[] = [];
  let rttRead = false;
  if (calling_at && !rtt?.configured) {
    return { arrivals: [], truncated: false, next_action: 'calling_at needs the National Rail live feed, which this server has no token for. Use timetable for every direct train between the two stations, or live_departures without calling_at and read each destination.' };
  }
  if (useRtt) {
    const target = calling_at ? await callingAtCode(tfl, calling_at) : undefined;
    if (calling_at && !target) {
      return { arrivals: [], truncated: false, next_action: `calling_at "${calling_at}" is not a National Rail station this server can name. Pass its CRS code (three letters, as printed on a ticket) or its 910G station ID.` };
    }
    const codes = [...new Set((await tfl.nationalRailStations(id).catch(() => [] as string[])).map((station) => crsOf(station)).filter((code): code is string => Boolean(code)))].slice(0, MAX_RTT_STATIONS);
    if (codes.length === 0) {
      if (calling_at) return { arrivals: [], truncated: false, next_action: 'calling_at works from a National Rail station. Pass a station that has national-rail among its modes.' };
    } else {
      try {
        const boards = await Promise.all(codes.map((code) => rtt!.board(code, target)));
        rttRead = true;
        // Without calling_at, TfL's own boards already carry these operators' trains where it has them.
        const fromTfl = new Set<string>(calling_at ? [] : [
          ...(nationalRail.live.some((ref) => ref.id === 'thameslink') ? ['TL'] : []),
          ...(has(['overground']) ? ['LO'] : []), ...(has(['elizabeth-line']) ? ['XR'] : []),
        ]);
        const seen = new Set<string>();
        rttDepartures = boards.flatMap((board) => board.departures).filter((departure) => {
          if (fromTfl.has(departure.operator_code)) return false;
          if (line && departure.line !== line && TFL_LIVE_OPERATORS[departure.operator_code] !== line) return false;
          const key = departure.service_id ?? `${departure.line}|${departure.scheduled}|${departure.destination}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const system = boards.map((board) => board.system).find((state) => state && state !== 'OK');
        if (system) rttNotes.push(`Realtime Trains reports its live data as ${system}, so National Rail times may be timetable times.`);
      } catch (error) {
        if (!(error instanceof RttError)) throw error;
        rttNotes.push(`${rttFailure(error)}, so ${calling_at ? 'this filtered board could not be read' : 'National Rail operators other than Thameslink are missing from this board'}. Use timetable or plan_journey for timetabled trains and line_status for the operator.`);
      }
    }
  }

  // A hub adds piers always and bus stops only for a named route; a bus route at a hub skips the rail boards.
  const readSurface = !calling_at && !deadLine && (surfaceStop || (id.startsWith('HUB') && (has(['river-bus']) || surfaceLine)));
  const readRail = !calling_at && !deadLine && !surfaceStop && !surfaceLine;
  const [predicted, scheduled, surface] = await Promise.all([
    readRail && (id.startsWith('HUB') || modes.length === 0 || has(PREDICTED_MODES)) ? tfl.arrivals(id, line, PREDICTED_MODES, PREDICTED_MODES) : [],
    readRail && (has(SCHEDULED_MODES) || nationalRail.live.length > 0) ? tfl.railDepartures(id, line) : [],
    readSurface ? tfl.surfaceStops(id, line).then((stops) => tfl.surfaceArrivals(stops, line)) : [],
  ]);
  // TfL's minutes (timeToStation) come from its own cache and can be a minute or more old, so they are worked
  // out again from the expected time against our clock, and trains that have already left are dropped.
  const now = tfl.now();
  const modeOf = (lineId: string) => record?.lineModeGroups?.find((group) => group.lineIdentifier?.includes(lineId))?.modeName ?? (TUBE_LINE_IDS.has(lineId) ? 'tube' : lineId);
  const unfiltered = new Set<string>();
  const departures: Departure[] = [...predicted.map((arrival) => ({ ...arrival, mode: modeOf(arrival.line) })), ...scheduled, ...surface, ...rttDepartures]
    .filter((departure) => departure.expected === null
      ? !('source' in departure) || Date.parse(departure.scheduled) >= now - STALE_DELAY_MS
      : Date.parse(departure.expected) >= now - PAST_GRACE_MS)
    .map((departure) => departure.expected === null ? departure : { ...departure, minutes: Math.max(0, Math.round((Date.parse(departure.expected) - now) / 60_000)) })
    // Only Tube platforms name a compass direction; buses, boats and trains elsewhere are kept and the note says so.
    .filter((departure) => {
      if (!direction) return true;
      if (departure.bound) return departure.bound === direction;
      if (departure.mode === 'tube') return false;
      unfiltered.add(departure.mode);
      return true;
    })
    .sort(departureOrder(now));
  const shown = departures.slice(0, limit);

  const notes: string[] = [...rttNotes];
  // TfL can list the mode without naming the operators; then the note names examples instead.
  const unnamed = unnamedRail;
  if (calling_at && rttRead) notes.push('This board lists only trains that later call at the calling_at station, from Realtime Trains: National Rail, Thameslink, Overground and Elizabeth line. Tube, DLR, tram, bus and boat departures are left off.');
  if (rttRead && rttDepartures.some((departure) => departure.mode === 'replacement-bus')) notes.push('Entries with mode replacement-bus are buses standing in for trains.');
  if ((nationalRail.other.length || unnamed) && readRail && !unlistedLine && !rtt?.configured) {
    const operators = unnamed ? 'National Rail operators other than Thameslink (for example Southern, South Western Railway)' : nationalRail.other.map((ref) => ref.name).join(', ');
    notes.push(`Trains of ${operators} are not included: TfL publishes live National Rail departures only for Thameslink. Use timetable or plan_journey for their timetabled trains and line_status with that operator for disruption.`);
  }
  if (has(['cable-car'])) notes.push(CABLE_CAR_NOTE);
  if (id.startsWith('HUB') && surfaceLine) {
    notes.push(`TfL's record for this interchange may not list every stop route ${line} uses (often a stop for one direction is missing). For the full picture, ask for the bus stop by its own name (the stop or street name) with line.`);
  }
  if (unfiltered.size) {
    notes.push(`direction applies only to Tube platforms; ${[...unfiltered].map((mode) => MODE_NAMES[mode] ?? mode).join(', ')} entries are not filtered by it, so read each destination.`);
  }
  // Overdue trains with no estimate sort last, so say how many the limit hid rather than drop them silently.
  const hidden = departures.slice(limit).filter((departure) => overdue(departure, now));
  if (hidden.length) {
    const cancelled = hidden.filter((departure) => 'status' in departure && departure.status === 'Cancelled').length;
    notes.push(`${hidden.length} train${hidden.length === 1 ? '' : 's'} past ${hidden.length === 1 ? 'its' : 'their'} scheduled time with no estimate${cancelled ? ` (${cancelled} cancelled)` : ''} ${hidden.length === 1 ? 'is' : 'are'} listed last and fell past limit; filter by line or raise limit to see ${hidden.length === 1 ? 'it' : 'them'}.`);
  }

  let empty = 'No departures match. Check the stop, filters and line_status; an empty board alone does not prove service is suspended.';
  if (rttRead) {
    empty = calling_at
      ? 'No train from this station to the calling_at station is due in the next hour. Check both stations and use timetable for the whole day; an empty board alone does not prove service is suspended.'
      : 'No departures are due here in the next hour. Check the stop and filters, and line_status for the operator; an empty board alone does not prove service is suspended.';
  } else if (rttNotes.length) {
    empty = 'The National Rail live feed could not be read, so this board says nothing about those trains. Use timetable or plan_journey for timetabled trains, and try again in a minute.';
  } else if (deadLine) {
    empty = `TfL publishes no live departures for ${deadLine.name}. Use timetable or plan_journey for its timetabled trains and line_status with ${deadLine.id} for disruption.`;
  } else if (unlistedLine) {
    empty = `${line} is not listed at this ${id.startsWith('HUB') ? 'interchange' : 'stop'} in TfL's data, so its stops are not on this board. If it is a bus route, ask for the bus stop by its own name (the stop or street name) with line, or pass a bus stop cluster ID (490G…).`;
  } else if (id.startsWith('940GZZAL')) empty = CABLE_CAR_NOTE;
  else if (surfaceStop) empty = 'No buses or boats are predicted here now. Check the stop (a bus stop, a stop cluster or a pier) and the route; services may have finished for the day.';
  else if (has(['cable-car']) && !has(LIVE_MODES)) empty = CABLE_CAR_NOTE;
  else if (has(['national-rail']) && !has(LIVE_MODES) && nationalRail.live.length === 0) {
    empty = 'This station is served only by National Rail operators without live TfL departures. Use timetable or plan_journey for timetabled trains and line_status for the operator.';
  }
  return {
    ...(rttRead ? { source: 'TfL Unified API and Realtime Trains', cache_max_age_seconds: 60 } : {}),
    arrivals: shown,
    truncated: departures.length > limit,
    ...(notes.length ? { coverage_note: notes.join(' ') } : {}),
    ...(departures.length ? {} : { next_action: empty }),
  };
}
