import { TtlCache } from './cache.js';

const BASE = 'https://api.tfl.gov.uk';
const LIVE_TTL_MS = 30_000;
const STATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Published timetables change rarely; an hour keeps repeated window queries cheap. */
export const TIMETABLE_TTL_MS = 60 * 60 * 1000;
const NEARBY_RADIUS_M = 1500;
const MAX_NEARBY = 8;

// Network order, which is also the order the app lists lines in.
const TUBE_LINE_ORDER = [
  'bakerloo', 'central', 'circle', 'district', 'hammersmith-city', 'jubilee',
  'metropolitan', 'northern', 'piccadilly', 'victoria', 'waterloo-city',
];
export const TUBE_LINE_IDS = new Set(TUBE_LINE_ORDER);

/** Rail modes TfL reports line status for, in the order results are listed. */
export const RAIL_MODES = ['tube', 'elizabeth-line', 'overground', 'dlr', 'tram', 'national-rail'] as const;
export type RailMode = (typeof RAIL_MODES)[number];
/** Modes line_status reads: the rail modes and the cable car, which TfL reports a status for but which has no rail stations. */
export const STATUS_MODES = [...RAIL_MODES, 'cable-car'] as const;
/** Rail modes with live departures for every line. Of the National Rail operators, only LIVE_NATIONAL_RAIL_LINES have any. */
export const LIVE_MODES: RailMode[] = ['tube', 'elizabeth-line', 'overground', 'dlr', 'tram'];
/** National Rail lines TfL serves on /ArrivalDepartures; it rejects every other operator's line ID with 400. */
export const LIVE_NATIONAL_RAIL_LINES = new Set(['thameslink']);
/** Modes whose /Arrivals predictions are passed through as TfL gives them, without the rail board corrections. */
export const SURFACE_MODES = ['bus', 'river-bus'] as const;
export type SurfaceMode = (typeof SURFACE_MODES)[number];
/** At most this many bus stops or piers are read for one board (a big bus cluster has more). */
const MAX_SURFACE_STOPS = 8;
/** Modes whose /Arrivals predictions are reliable; the Tube board logic below is built on them. */
export const PREDICTED_MODES: RailMode[] = ['tube', 'dlr', 'tram'];
/**
 * Modes read from /ArrivalDepartures instead: /Arrivals invents trains at their starting stations
 * (Overground at Clapham Junction, Elizabeth line at Paddington), while this gives timetabled and
 * estimated departures with a status and delay cause.
 */
export const SCHEDULED_MODES: RailMode[] = ['elizabeth-line', 'overground'];
/**
 * How long after its scheduled time a train with no estimate stays listed. Long enough to show a late or
 * cancelled train someone may be waiting for, short enough that a disrupted morning's backlog does not linger.
 */
const STALE_DELAY_MS = 20 * 60 * 1000;

function tubeLinesInOrder<T extends { id: string }>(lines: T[]): T[] {
  const unique = [...new Map(lines.filter((l) => TUBE_LINE_IDS.has(l.id)).map((l) => [l.id, l])).values()];
  return unique.sort((a, b) => TUBE_LINE_ORDER.indexOf(a.id) - TUBE_LINE_ORDER.indexOf(b.id));
}

export type Level = 'good' | 'minor' | 'severe';

export type LineStatus = {
  id: string;
  name: string;
  status: string;
  level: Level;
  reason: string | null;
};

export type Arrival = {
  line: string;
  lineName: string;
  bound: string | null;
  platform: string;
  destination: string;
  minutes: number;
  expected: string;
  location: string | null;
};
export type Stop = { id: string; name: string; modes: string[] };
/** A bus or boat prediction. platform is the bus stop letter (e.g. "W"); towards is TfL's direction text for the stop. */
export type SurfaceArrival = Arrival & { mode: SurfaceMode; towards: string | null };
/**
 * A rail departure. minutes and expected are null when TfL has no estimate (typically a delayed or cancelled
 * train); scheduled is then the only time known.
 */
export type RailDeparture = Omit<Arrival, 'minutes' | 'expected'> & {
  mode: RailMode;
  minutes: number | null;
  expected: string | null;
  scheduled: string;
  status: string;
  reason: string | null;
};
export type Station = { id: string; name: string; lines: { id: string; name: string }[] };
export type NearbyStation = { id: string; name: string; distance: number; lines: string[] };

type RawStatus = { statusSeverity: number; statusSeverityDescription: string; reason?: string };
type RawLine = { id: string; name: string; modeName?: string; lineStatuses: RawStatus[] };
export type NetworkLineStatus = LineStatus & { mode: string };
type RawPrediction = {
  lineId: string;
  lineName: string;
  platformName?: string;
  destinationName?: string;
  towards?: string;
  destinationNaptanId?: string;
  timeToStation: number;
  expectedArrival: string;
  currentLocation?: string;
  vehicleId?: string;
  modeName?: string;
};
type RawLineRef = { id: string; name: string };
export type RawStopPoint = {
  id: string;
  commonName?: string;
  icsCode?: string;
  stopType?: string;
  distance?: number;
  modes?: string[];
  lines?: RawLineRef[];
  lineModeGroups?: { modeName: string; lineIdentifier?: string[] }[];
  children?: RawStopChild[];
};
/** A stop inside a station record. Airports nest the rail station two levels down (920GLGW0 > 920GLGW2 > 910GGTWK). */
export type RawStopChild = { id: string; commonName?: string; stopType?: string; modes?: string[]; lines?: RawLineRef[]; children?: RawStopChild[] };

function descendants(node: { children?: RawStopChild[] }): RawStopChild[] {
  return (node.children ?? []).flatMap((child) => [child, ...descendants(child)]);
}

/** The node for an ID inside a record: TfL answers a station or bus stop inside an interchange with the HUB record. */
function nodeIn(record: RawStopPoint, id: string): RawStopChild | RawStopPoint {
  return record.id === id ? record : descendants(record).find((child) => child.id === id) ?? record;
}

/** "Platform Unknown" carries no information; show no platform instead. */
const platformOf = (name: string | undefined) => (!name || /^platform unknown$/i.test(name) || name === 'null' ? '' : name);

type Timed = { expected: string | null; scheduled?: string };

/** A train with no estimate whose scheduled time has passed: it leaves at some unknown later time, or not at all. */
export const overdue = (departure: Timed, now: number) => departure.expected === null && Date.parse(departure.scheduled ?? '') < now;

/**
 * Board order: by expected time, or by scheduled time for a train with no estimate (as a station board lists
 * a cancelled train). Overdue trains with no estimate come last, so a disrupted morning's backlog never
 * pushes running trains off a short board.
 */
export function departureOrder(now: number) {
  const key = (departure: Timed) => Date.parse(departure.expected ?? departure.scheduled ?? '');
  return (a: Timed, b: Timed) => Number(overdue(a, now)) - Number(overdue(b, now)) || key(a) - key(b);
}

type RawArrivalDeparture = {
  platformName?: string;
  destinationNaptanId?: string;
  destinationName?: string;
  scheduledTimeOfDeparture?: string;
  estimatedTimeOfDeparture?: string;
  departureStatus?: string;
  cause?: string;
};
type RawSearch = { matches?: { id: string; name: string; modes?: string[]; icsId?: string }[] };
/** A station search match with the ICS code the journey planner resolves to the whole station. */
export type StationMatch = Stop & { icsId: string | null };

/** A TfL failure. The message is safe to return: it never contains the request URL. */
export class TflError extends Error {
  /** date_time: TfL rejected the date or time; date_range: the date is past the end of what the planner covers. */
  constructor(readonly status: number, readonly validation?: 'date_time' | 'date_range') {
    super(`TfL responded with ${status}`);
  }
}

// TfL severity codes: https://api.tfl.gov.uk/Line/Meta/Severity
const GOOD_SEVERITIES = new Set([10, 18]);
const MINOR_SEVERITIES = new Set([0, 7, 8, 9, 12, 13, 14, 15, 17, 19]);

function levelOf(severity: number): Level {
  if (GOOD_SEVERITIES.has(severity)) return 'good';
  if (MINOR_SEVERITIES.has(severity)) return 'minor';
  return 'severe';
}

const LEVEL_RANK: Record<Level, number> = { good: 0, minor: 1, severe: 2 };

/** "Edgware Road (Circle Line) Underground Station" -> "Edgware Road". */
export function cleanStationName(name: string): string {
  return name
    // TfL pads some names ("Waterloo Station   / York Road").
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[ -]+(Underground|Rail|DLR)( Station)?$/, '')
    .replace(/ \([^()]* Line\)$/, '');
}

function simplifyLine(line: RawLine): LineStatus {
  const worst = line.lineStatuses.reduce<RawStatus | undefined>((current, candidate) => {
    if (!current) return candidate;
    const currentRank = LEVEL_RANK[levelOf(current.statusSeverity)];
    return LEVEL_RANK[levelOf(candidate.statusSeverity)] > currentRank ? candidate : current;
  }, undefined);
  return {
    id: line.id,
    name: line.name,
    status: worst?.statusSeverityDescription ?? 'Unknown',
    level: worst ? levelOf(worst.statusSeverity) : 'minor',
    reason: worst?.reason?.trim() || null,
  };
}

const BOUND = /^((?:North|South|East|West)bound)\b[\s-]*(.*)$/;

/** TfL platform names look like "Northbound - Platform 5", "Eastbound Platform 25" or "Platform 1". */
function splitPlatform(name: string): { bound: string | null; platform: string } {
  const match = BOUND.exec(name);
  return match ? { bound: match[1]!, platform: match[2]! } : { bound: null, platform: name };
}

function toArrival(p: RawPrediction): Arrival {
  return {
    line: p.lineId,
    lineName: p.lineName,
    ...splitPlatform(p.platformName ?? ''),
    destination: cleanStationName(p.destinationName ?? p.towards ?? 'Unknown'),
    minutes: Math.round(p.timeToStation / 60),
    expected: p.expectedArrival,
    location: p.currentLocation?.trim() || null,
  };
}

/**
 * The Waterloo & City is a two-stop shuttle. At each end TfL labels the arriving train by the way it came
 * (and at Bank on both platforms), but it can only leave for the other end.
 */
const SHUTTLE_DEPARTURES: Record<string, { bound: string; destination: string }> = {
  'waterloo-city|940GZZLUBNK': { bound: 'Westbound', destination: 'Waterloo' },
  'waterloo-city|940GZZLUWLO': { bound: 'Eastbound', destination: 'Bank' },
};

/**
 * DLR and tram predictions carry no vehicle id, and TfL lists a train on both faces of a platform pair
 * (Canary Wharf 5 and 6) at the same second. Keep one, without a platform when the copies disagree.
 * Tube predictions are left alone.
 */
function collapsePlatformTwins(arrivals: Arrival[]): Arrival[] {
  const kept: Arrival[] = [];
  for (const arrival of arrivals) {
    const twin = TUBE_LINE_IDS.has(arrival.line) ? undefined : kept.find((other) =>
      other.line === arrival.line && other.destination === arrival.destination &&
      Math.abs(Date.parse(other.expected) - Date.parse(arrival.expected)) <= 30_000);
    if (!twin) kept.push(arrival);
    else if (twin.platform !== arrival.platform) twin.platform = '';
  }
  return kept;
}

export class TflClient {
  private cache: TtlCache;

  constructor(
    private fetchImpl: typeof fetch,
    private appKey: string | undefined,
    readonly now: () => number,
  ) {
    this.cache = new TtlCache(now);
  }

  private async request<T>(path: string, params: Record<string, string> = {}, allowAmbiguity = false): Promise<T> {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (this.appKey) url.searchParams.set('app_key', this.appKey);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      // The underlying error can quote the URL, which holds the key. Drop it.
      throw new TflError(503);
    }
    if (!response.ok && !(allowAmbiguity && response.status === 300)) {
      if (allowAmbiguity && response.status === 400) {
        const body = await response.json().catch(() => null) as { message?: unknown } | null;
        const dateTime = typeof body?.message === 'string' && /\b(date|time)\b/i.test(body.message);
        throw new TflError(400, dateTime ? 'date_time' : undefined);
      }
      // A date beyond the planner's range (about five weeks ahead in Nov 2026) fails with a 500 whose
      // exceptionType is ArgumentException, not a 400. A real outage is a different 5xx or exception.
      if (allowAmbiguity && response.status === 500 && (params.date ?? '') > new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, '')) {
        const body = await response.json().catch(() => null) as { exceptionType?: unknown } | null;
        if (body?.exceptionType === 'ArgumentException') throw new TflError(400, 'date_range');
      }
      throw new TflError(response.status);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new TflError(502);
    }
  }

  /** Whether journey() would answer these arguments from cache rather than asking TfL. */
  journeyCached(from: string, to: string, params: Record<string, string>, ttlMs = LIVE_TTL_MS) {
    return this.cache.has(`journey:${ttlMs}:${JSON.stringify([from, to, params])}`);
  }

  journey(from: string, to: string, params: Record<string, string>, ttlMs = LIVE_TTL_MS): Promise<unknown> {
    const path = `/Journey/JourneyResults/${encodeURIComponent(from)}/to/${encodeURIComponent(to)}`;
    return this.cache.get(`journey:${ttlMs}:${JSON.stringify([from, to, params])}`, ttlMs, () =>
      this.request<unknown>(path, params, true),
    );
  }

  /** TfL's published timetable for one line from a stop towards another. Only some modes have one. */
  lineTimetable(line: string, from: string, to: string): Promise<unknown> {
    const path = `/Line/${encodeURIComponent(line)}/Timetable/${encodeURIComponent(from)}/to/${encodeURIComponent(to)}`;
    return this.cache.get(`timetable:${line}:${from}:${to}`, TIMETABLE_TTL_MS, () => this.request<unknown>(path));
  }

  /** The ordered stop lists of a line's routes in one direction. */
  routeSequence(line: string, direction: 'inbound' | 'outbound'): Promise<{
    orderedLineRoutes?: { name?: string; naptanIds?: string[] }[];
    stopPointSequences?: { stopPoint?: { id: string; name?: string }[] }[];
  }> {
    return this.cache.get(`sequence:${line}:${direction}`, STATION_TTL_MS, () =>
      this.request(`/Line/${encodeURIComponent(line)}/Route/Sequence/${direction}`));
  }

  /** A station's record; TfL returns the interchange (HUB...) record when the stop belongs to one. */
  stopRecord(stopId: string): Promise<RawStopPoint> {
    return this.stopPoint(stopId);
  }

  /** Station search that keeps each match's ICS code. */
  searchStations(query: string, modes: readonly string[]): Promise<StationMatch[]> {
    const normalised = query.trim().toLowerCase();
    const modeList = modes.join(',');
    return this.cache.get(`stations:${modeList}:${normalised}`, STATION_TTL_MS, async () => {
      const result = await this.request<RawSearch>(`/StopPoint/Search/${encodeURIComponent(normalised)}`, { modes: modeList });
      return (result.matches ?? []).map((match) => ({
        id: match.id, name: cleanStationName(match.name), modes: match.modes ?? [], icsId: match.icsId ?? null,
      }));
    });
  }

  status(lineIds: string[]): Promise<LineStatus[]> {
    const ids = [...new Set(lineIds)].sort().join(',');
    return this.cache.get(`status:${ids}`, LIVE_TTL_MS, async () => {
      const lines = await this.request<RawLine[]>(`/Line/${ids}/Status`);
      return lines.map(simplifyLine);
    });
  }

  /**
   * Current status of every rail line TfL reports on (Tube, Elizabeth line, Overground, DLR, tram
   * and National Rail operators) and the cable car, from one cached request.
   */
  networkStatus(): Promise<NetworkLineStatus[]> {
    return this.cache.get('status:network', LIVE_TTL_MS, async () => {
      const lines = await this.request<RawLine[]>(`/Line/Mode/${STATUS_MODES.join(',')}/Status`);
      const rank = (line: RawLine) => {
        const mode = (STATUS_MODES as readonly string[]).indexOf(line.modeName ?? '');
        return (mode < 0 ? STATUS_MODES.length : mode) * 100 + Math.max(TUBE_LINE_ORDER.indexOf(line.id), 0);
      };
      return [...lines]
        .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
        .map((line) => ({ ...simplifyLine(line), mode: line.modeName ?? 'unknown' }));
    });
  }

  /**
   * Live predictions at a station. A HUB id is resolved to its child stations in hubModes, which
   * stays Tube-only. With keepModes, predictions in other modes are dropped: /Arrivals at
   * Farringdon's Thameslink station returns the Elizabeth line's unreliable predictions.
   */
  async arrivals(stopId: string, line?: string, hubModes: readonly string[] = ['tube'], keepModes?: readonly string[]): Promise<Arrival[]> {
    const stationIds = stopId.startsWith('HUB') ? await this.stationsInHub(stopId, hubModes) : [stopId];
    const [perStation, servingLines] = await Promise.all([
      Promise.all(stationIds.map((id) => this.rawArrivals(id))),
      this.linesServing(stopId),
    ]);
    const here = new Set(stationIds);
    const predictions = perStation
      .flat()
      // TfL sometimes tags a train with a line that doesn't stop here (Hammersmith & City at Wembley Park).
      // The serving set lists Tube lines only, so it says nothing about other modes' trains.
      .filter((p) => !servingLines || !TUBE_LINE_IDS.has(p.lineId) || servingLines.has(p.lineId))
      .filter((p) => !line || p.lineId === line)
      .filter((p) => !keepModes || !p.modeName || keepModes.includes(p.modeName));
    const endsHere = (p: RawPrediction) => Boolean(p.destinationNaptanId && here.has(p.destinationNaptanId));

    // Trains ending here are short trips nobody can ride onward, unless this is the end of the line for
    // that line and direction: then they are most of the list, and they turn round to form the departures.
    const groupOf = (p: RawPrediction) => `${p.lineId}|${splitPlatform(p.platformName ?? '').bound ?? p.platformName}`;
    const counts = new Map<string, { ending: number; through: number }>();
    for (const p of predictions) {
      const count = counts.get(groupOf(p)) ?? { ending: 0, through: 0 };
      if (endsHere(p)) count.ending++;
      else count.through++;
      counts.set(groupOf(p), count);
    }
    const endOfLine = (p: RawPrediction) => {
      const count = counts.get(groupOf(p))!;
      return count.ending > count.through;
    };

    const kept = predictions
      .filter((p) => !endsHere(p) || endOfLine(p))
      .sort((a, b) => a.timeToStation - b.timeToStation);

    // At a terminus TfL lists each arriving train once per platform it might use. Show it once, with no
    // platform unless every copy agrees.
    const copies = new Map<string, RawPrediction[]>();
    for (const p of kept) {
      if (!endsHere(p) || !p.vehicleId) continue;
      const key = `${p.lineId}|${p.vehicleId}`;
      copies.set(key, [...(copies.get(key) ?? []), p]);
    }

    const arrivals: Arrival[] = [];
    for (const p of kept) {
      const same = endsHere(p) && p.vehicleId ? copies.get(`${p.lineId}|${p.vehicleId}`)! : [p];
      if (same[0] !== p) continue;
      const arrival = toArrival(p);
      if (!endsHere(p)) {
        arrivals.push(arrival);
        continue;
      }
      const platforms = new Set(same.map((c) => toArrival(c).platform));
      // TfL gives the station itself as the destination; where it goes next isn't known.
      const turned = { ...arrival, destination: 'Check Front of Train', platform: platforms.size === 1 ? arrival.platform : '' };
      const shuttle = SHUTTLE_DEPARTURES[`${p.lineId}|${p.destinationNaptanId}`];
      arrivals.push(shuttle ? { ...turned, ...shuttle } : turned);
    }
    return collapsePlatformTwins(arrivals);
  }

  /**
   * Elizabeth line, Overground and Thameslink departures at a station or hub, soonest first. Trains ending
   * here are left out, and a train listed under two station records (Paddington) appears once.
   */
  async railDepartures(stopId: string, line?: string): Promise<RailDeparture[]> {
    const stationIds = stopId.startsWith('HUB') ? await this.stationsInHub(stopId, [...SCHEDULED_MODES, 'national-rail']) : [stopId];
    const requests = (await Promise.all(stationIds.map(async (id) =>
      (await this.liveRailLines(id)).filter((ref) => !line || ref.id === line).map((ref) => ({ station: id, line: ref.id, name: ref.name, mode: ref.mode })),
    ))).flat();
    const boards = await Promise.all(requests.map((request) =>
      this.cache.get(`departures:${request.station}:${request.line}`, LIVE_TTL_MS, () =>
        this.request<RawArrivalDeparture[]>(`/StopPoint/${request.station}/ArrivalDepartures`, { lineIds: request.line }))));

    const now = this.now();
    const seen = new Set<string>();
    const departures: RailDeparture[] = [];
    requests.forEach((request, index) => {
      for (const item of boards[index] ?? []) {
        if (!item.scheduledTimeOfDeparture) continue;
        const key = `${request.line}|${item.destinationNaptanId}|${item.scheduledTimeOfDeparture}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const estimate = item.estimatedTimeOfDeparture || null;
        const minutes = estimate ? Math.round((Date.parse(estimate) - now) / 60_000) : null;
        if (minutes !== null && minutes < 0) continue;
        if (minutes === null && Date.parse(item.scheduledTimeOfDeparture) < now - STALE_DELAY_MS) continue;
        departures.push({
          line: request.line,
          lineName: request.name,
          mode: request.mode,
          bound: null,
          platform: platformOf(item.platformName),
          destination: cleanStationName(item.destinationName ?? 'Unknown'),
          minutes,
          expected: estimate,
          location: null,
          scheduled: item.scheduledTimeOfDeparture,
          status: item.departureStatus ?? 'Unknown',
          reason: item.cause?.trim() || null,
        });
      }
    });
    return departures.sort(departureOrder(now));
  }

  /**
   * The lines with a /ArrivalDepartures board at one station: every Elizabeth line and Overground line, and
   * the National Rail lines TfL serves live. The station's own lines are used where TfL nests it in a hub
   * record, so a hub's Thameslink is not asked for at its other stations.
   */
  private async liveRailLines(stationId: string): Promise<(RawLineRef & { mode: RailMode })[]> {
    const record = await this.stopPoint(stationId);
    const own = nodeIn(record, stationId).lines ?? [];
    const lines = own.length ? own : record.lines ?? [];
    const modeOf = (id: string) => record.lineModeGroups?.find((group) => group.lineIdentifier?.includes(id))?.modeName;
    return lines.flatMap((ref) => {
      const mode = modeOf(ref.id);
      const live = (SCHEDULED_MODES as string[]).includes(mode ?? '') || (mode === 'national-rail' && LIVE_NATIONAL_RAIL_LINES.has(ref.id));
      return live ? [{ ...ref, mode: mode as RailMode }] : [];
    });
  }

  /**
   * The bus stops and piers a board reads. A single bus stop (490…) or pier (930G…) is read as given. A bus
   * stop cluster (490G…, what a stop search returns for buses) is read as its lettered stops, because /Arrivals
   * returns nothing for a cluster. A hub contributes its piers, and its bus stops only for a named bus route,
   * so a big interchange's board is not swamped by buses.
   */
  async surfaceStops(stopId: string, line?: string): Promise<string[]> {
    const id = stopId.toUpperCase();
    if (id.startsWith('930G') || (id.startsWith('490') && !id.startsWith('490G'))) return [id];
    const record = await this.stopPoint(id);
    const node = nodeIn(record, id);
    const serves = (stop: RawStopChild) => !line || (stop.lines ?? []).some((ref) => ref.id === line);
    const isPier = (stop: RawStopChild) => stop.id.startsWith('930G') && (stop.modes ?? []).includes('river-bus');
    const piers = descendants(node).filter((stop) => isPier(stop) && serves(stop));
    const hubBus = id.startsWith('HUB') ? Boolean(line) && record.lineModeGroups?.some((group) => group.modeName === 'bus' && group.lineIdentifier?.includes(line!)) : true;
    const busStops = hubBus
      ? descendants(node).filter((stop) => stop.stopType === 'NaptanPublicBusCoachTram' && (stop.modes ?? []).includes('bus') && serves(stop))
      : [];
    // A pier's own children are its berths; the pier ID already answers for them.
    const topPiers = piers.filter((pier) => !piers.some((other) => other !== pier && descendants(other).includes(pier)));
    return [...new Set([...topPiers, ...busStops].map((stop) => stop.id))].slice(0, MAX_SURFACE_STOPS);
  }

  /** Bus and boat predictions at these stops as TfL gives them, soonest first, optionally for one route. */
  async surfaceArrivals(stopIds: string[], line?: string): Promise<SurfaceArrival[]> {
    const predictions = (await Promise.all(stopIds.map((id) => this.rawArrivals(id)))).flat()
      .filter((p) => (SURFACE_MODES as readonly string[]).includes(p.modeName ?? '') && (!line || p.lineId === line))
      .sort((a, b) => a.timeToStation - b.timeToStation);
    // Across a cluster or hub one bus is predicted at each stop it passes (stop A, then W a minute later).
    // Keep it once, at its first stop, so the board does not double the frequency.
    const seen = new Set<string>();
    const unique = predictions.filter((p) => {
      if (!p.vehicleId) return true;
      const key = `${p.vehicleId}|${p.lineId}|${p.destinationName}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const text = (value: string | undefined) => (value && value.trim() !== 'null' ? value.trim() : '');
    return unique.map((p) => {
      const mode = p.modeName as SurfaceMode;
      return {
        line: p.lineId,
        lineName: p.lineName,
        mode,
        bound: null,
        // A bus prediction's platform is its stop letter; a boat's is only "inbound" or "outbound".
        platform: mode === 'bus' ? platformOf(p.platformName) : '',
        destination: cleanStationName(text(p.destinationName) || text(p.towards) || 'Unknown'),
        towards: text(p.towards) || null,
        minutes: Math.round(p.timeToStation / 60),
        expected: p.expectedArrival,
        location: p.currentLocation?.trim() || null,
      };
    });
  }

  /** The National Rail station IDs (910G...) behind a stop: a hub's rail stations, or the station itself. */
  async nationalRailStations(stopId: string): Promise<string[]> {
    if (stopId.startsWith('HUB')) return this.stationsInHub(stopId, ['national-rail']);
    return stopId.startsWith('910G') ? [stopId] : [];
  }

  /** One cached fetch of a station's record, shared by the station, hub and line lookups. */
  private stopPoint(stopId: string): Promise<RawStopPoint> {
    return this.cache.get(`stoppoint:${stopId}`, STATION_TTL_MS, () => this.request<RawStopPoint>(`/StopPoint/${encodeURIComponent(stopId)}`));
  }

  /** The tube lines TfL says serve a station, or null if unknown, in which case nothing is filtered. */
  private async linesServing(stopId: string): Promise<Set<string> | null> {
    try {
      const lines = tubeLinesInOrder((await this.stopPoint(stopId)).lines ?? []);
      return lines.length > 0 ? new Set(lines.map((line) => line.id)) : null;
    } catch {
      return null;
    }
  }

  async station(stopId: string): Promise<Station> {
    const stop = await this.stopPoint(stopId);
    return {
      id: stop.id,
      name: cleanStationName(stop.commonName ?? stop.id),
      lines: tubeLinesInOrder(stop.lines ?? []).map(({ id, name }) => ({ id, name })),
    };
  }

  /** Tube stations near a point. Rounding to 3 decimals (about 100m) lets nearby callers share a lookup. */
  nearby(lat: number, lon: number): Promise<NearbyStation[]> {
    const rLat = lat.toFixed(3);
    const rLon = lon.toFixed(3);
    return this.cache.get(`nearby:${rLat},${rLon}`, STATION_TTL_MS, async () => {
      const result = await this.request<{ stopPoints?: RawStopPoint[] }>('/StopPoint/', {
        lat: rLat,
        lon: rLon,
        stopTypes: 'NaptanMetroStation',
        modes: 'tube',
        radius: String(NEARBY_RADIUS_M),
      });
      return (result.stopPoints ?? [])
        .map((stop) => ({
          id: stop.id,
          name: cleanStationName(stop.commonName ?? stop.id),
          distance: Math.round(stop.distance ?? 0),
          lines: tubeLinesInOrder(stop.lines ?? []).map((l) => l.id),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_NEARBY);
    });
  }

  private rawArrivals(stationId: string): Promise<RawPrediction[]> {
    return this.cache.get(`arrivals:${stationId}`, LIVE_TTL_MS, () =>
      this.request<RawPrediction[]>(`/StopPoint/${stationId}/Arrivals`),
    );
  }

  /**
   * Search returns HUB ids for interchanges like King's Cross and Paddington, and
   * TfL's arrivals endpoint returns nothing for those, so look up the stations in the wanted modes.
   * A station can sit below another (HUBWIM nests Thameslink's 910GWIMBLDN inside 910GWDON), so the whole
   * tree is walked; only rail and metro stations count, never their entrances, access areas or platforms.
   */
  private stationsInHub(hubId: string, modes: readonly string[]): Promise<string[]> {
    return this.stopPoint(hubId).then((hub) => [...new Set(descendants(hub)
      .filter((child) => /^9[14]0G/.test(child.id) && !/Entrance|AccessArea|Platform/.test(child.stopType ?? '') && child.modes?.some((mode) => modes.includes(mode)))
      .map((child) => child.id))]);
  }

  search(query: string, modes: readonly string[] = ['tube', 'bus']): Promise<Stop[]> {
    const normalised = query.trim().toLowerCase();
    const modeList = modes.join(',');
    return this.cache.get(`search:${modeList}:${normalised}`, LIVE_TTL_MS, async () => {
      const result = await this.request<RawSearch>(
        `/StopPoint/Search/${encodeURIComponent(normalised)}`,
        { modes: modeList },
      );
      return (result.matches ?? []).map((match) => ({
        id: match.id,
        name: cleanStationName(match.name),
        modes: match.modes ?? [],
      }));
    });
  }
}
