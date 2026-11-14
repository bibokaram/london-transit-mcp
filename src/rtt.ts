import { z } from 'zod';
import { TtlCache } from './cache.js';
import { CRS_TABLE } from './data/crs.js';
import { withLondonOffset } from './journeys.js';

const BASE = 'https://data.rtt.io';
/**
 * Realtime Trains allows 10 requests a minute, 100 an hour and 1,000 a day (October 2026), so a board is
 * kept for a minute: one person asking about one station costs one request however often they ask.
 */
const BOARD_TTL_MS = 60_000;
/** An access token is asked for again this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;
const DIMENSIONS = ['Minute', 'Hour', 'Day'] as const;

/** A Realtime Trains failure. The message is safe to return: it never contains a token. */
export class RttError extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds?: number) {
    super(`Realtime Trains responded with ${status}`);
  }
}

/** Realtime Trains operator codes for the lines TfL reads live itself. */
export const TFL_LIVE_OPERATORS: Record<string, string> = { TL: 'thameslink', LO: 'overground', XR: 'elizabeth-line' };
/** Operator code -> the TfL line ID line_status and the line filter use for that operator. */
const OPERATOR_LINES: Record<string, string> = {
  VT: 'avanti-west-coast', CC: 'c2c', CH: 'chiltern-railways', XC: 'crosscountry', EM: 'east-midlands-railway',
  GX: 'gatwick-express', GC: 'grand-central', LE: 'greater-anglia', GN: 'great-northern', GW: 'great-western-railway',
  HX: 'heathrow-express', HT: 'hull-trains', IL: 'island-line', GR: 'london-north-eastern-railway', LD: 'lumo',
  ME: 'merseyrail', NT: 'northern-rail', SR: 'scotrail', SE: 'southeastern', SN: 'southern',
  SW: 'south-western-railway', TL: 'thameslink', TP: 'transpennine-express', AW: 'transport-for-wales',
  LM: 'west-midlands-trains', LO: 'london-overground', XR: 'elizabeth',
};

const STATION_CRS = new Map(CRS_TABLE.split(' ').map((pair) => {
  const [code, suffix] = pair.split(':') as [string, string];
  return [`910G${suffix}`, code];
}));
/** The National Rail CRS code of a TfL rail station ID (910G...), if it has one. */
export const crsOf = (stationId: string) => STATION_CRS.get(stationId.toUpperCase());

const time = z.object({
  scheduleAdvertised: z.string().nullish(),
  realtimeForecast: z.string().nullish(),
  realtimeActual: z.string().nullish(),
  realtimeNoReport: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
}).nullish();
const place = z.object({ description: z.string().nullish(), shortCodes: z.array(z.string()).nullish() }).nullish();
const pair = z.object({ location: place, temporalData: time });
const reason = z.object({ type: z.string().nullish(), shortText: z.string().nullish(), longText: z.string().nullish() });
const temporal = z.object({
  arrival: time, departure: time,
  scheduledCallType: z.string().nullish(), realtimeCallType: z.string().nullish(),
  displayAs: z.string().nullish(), status: z.string().nullish(),
}).nullish();
const platform = z.object({ planned: z.string().nullish(), forecast: z.string().nullish(), actual: z.string().nullish() }).nullish();
const locationMetadata = z.object({ platform, numberOfVehicles: z.number().nullish() }).nullish();
const scheduleMetadata = z.object({
  uniqueIdentity: z.string().nullish(), identity: z.string().nullish(), departureDate: z.string().nullish(),
  operator: z.object({ code: z.string().nullish(), name: z.string().nullish() }).nullish(),
  modeType: z.string().nullish(), inPassengerService: z.boolean().nullish(),
}).nullish();
const systemStatus = z.object({ realtimeNetworkRail: z.string().nullish(), rttCore: z.string().nullish() }).nullish();

const lineUp = z.object({
  systemStatus,
  services: z.array(z.object({
    temporalData: temporal, locationMetadata, scheduleMetadata,
    reasons: z.array(reason).nullish(), origin: z.array(pair).nullish(), destination: z.array(pair).nullish(),
  })).nullish(),
});
const serviceDetail = z.object({
  systemStatus,
  service: z.object({
    scheduleMetadata,
    locations: z.array(z.object({ temporalData: temporal, locationMetadata, location: place })).nullish(),
    origin: z.array(pair).nullish(), destination: z.array(pair).nullish(), reasons: z.array(reason).nullish(),
  }),
});

type RawTime = z.infer<typeof time>;
type RawService = NonNullable<z.infer<typeof lineUp>['services']>[number];

/** One timed event. expected is null when the train is cancelled here or has not reported and has no forecast. */
export type TrainTime = { scheduled: string | null; expected: string | null; actual: boolean; status: 'OnTime' | 'Delayed' | 'Cancelled' | 'NoReport' | 'Scheduled'; late_minutes: number | null };

/**
 * Reads one arrival or departure. A forecast or actual time is live; with neither, the train has not been
 * seen yet and the advertised time stands in as the expectation, marked Scheduled.
 */
export function trainTime(raw: RawTime, cancelledHere = false): TrainTime | null {
  // The API allows a time with no offset, meaning local time at the station.
  const at = (value: string | null | undefined) => (value ? withLondonOffset(value) : null);
  const scheduled = at(raw?.scheduleAdvertised);
  if (!raw || (!scheduled && !raw.realtimeForecast && !raw.realtimeActual)) return null;
  if (raw.isCancelled || cancelledHere) return { scheduled, expected: null, actual: false, status: 'Cancelled', late_minutes: null };
  const live = at(raw.realtimeActual) ?? at(raw.realtimeForecast);
  if (!live) {
    return raw.realtimeNoReport
      ? { scheduled, expected: null, actual: false, status: 'NoReport', late_minutes: null }
      : { scheduled, expected: scheduled, actual: false, status: 'Scheduled', late_minutes: null };
  }
  const late = scheduled ? Math.round((Date.parse(live) - Date.parse(scheduled)) / 60_000) : null;
  return { scheduled, expected: live, actual: Boolean(raw.realtimeActual), status: late !== null && late >= 1 ? 'Delayed' : 'OnTime', late_minutes: late };
}

const clean = (value: string | null | undefined, limit = 120) => (value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
const platformOf = (raw: z.infer<typeof platform>) => clean(raw?.actual ?? raw?.forecast ?? raw?.planned, 12);
const places = (pairs: z.infer<typeof pair>[] | null | undefined) =>
  [...new Set((pairs ?? []).map((item) => clean(item.location?.description)).filter(Boolean))].join(' & ') || 'Unknown';
const reasonText = (reasons: z.infer<typeof reason>[] | null | undefined) => {
  const first = (reasons ?? [])[0];
  return first ? clean(first.longText || first.shortText, 240) || null : null;
};
/** A call passengers can board at: an advertised stop that is not set-down only. */
const boardable = (callType: string | null | undefined) => callType === 'ADVERTISED_OPEN' || callType === 'ADVERTISED_PICK_UP';
const modeOf = (modeType: string | null | undefined) =>
  (modeType === 'TRAIN' || !modeType ? 'national-rail' : modeType === 'SHIP' ? 'ferry' : 'replacement-bus');

export type RttDeparture = {
  line: string; lineName: string; mode: string; operator_code: string;
  bound: null; platform: string; destination: string; origin: string;
  minutes: number | null; expected: string | null; scheduled: string; status: string; reason: string | null;
  location: string | null; coaches: number | null; service_id: string | null; source: 'realtime-trains';
};
export type RttBoard = { departures: RttDeparture[]; system: string | null };
export type RttState = {
  configured: boolean;
  last_ok_at: string | null;
  last_error: { status: number; at: string } | null;
  blocked_until: string | null;
  rate: Partial<Record<Lowercase<(typeof DIMENSIONS)[number]>, { limit: number | null; remaining: number | null }>>;
  system: string | null;
};

function toDeparture(service: RawService, now: number): RttDeparture | null {
  const call = service.temporalData;
  const meta = service.scheduleMetadata;
  if (meta?.inPassengerService === false) return null;
  // Left out only when the feed says nobody can board; a response without call types is taken at face value.
  const callTypes = [call?.scheduledCallType, call?.realtimeCallType].filter(Boolean);
  if (callTypes.length && !callTypes.some(boardable)) return null;
  const display = call?.displayAs ?? 'CALL';
  if (display === 'PASS' || display === 'TERMINATES' || display === 'DIVERTED') return null;
  const departure = trainTime(call?.departure, display === 'CANCELLED');
  if (!departure?.scheduled) return null;
  const code = clean(meta?.operator?.code, 4).toUpperCase();
  const name = clean(meta?.operator?.name, 60) || code || 'National Rail';
  return {
    line: OPERATOR_LINES[code] ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    lineName: name, mode: modeOf(meta?.modeType), operator_code: code,
    bound: null, platform: platformOf(service.locationMetadata?.platform),
    destination: places(service.destination), origin: places(service.origin),
    minutes: departure.expected ? Math.round((Date.parse(departure.expected) - now) / 60_000) : null,
    expected: departure.expected, scheduled: departure.scheduled, status: departure.status,
    reason: reasonText(service.reasons),
    location: call?.status ? call.status.toLowerCase().replace(/_/g, ' ') : null,
    coaches: service.locationMetadata?.numberOfVehicles ?? null,
    service_id: meta?.uniqueIdentity ?? (meta?.identity && meta.departureDate ? `gb-nr:${meta.identity}:${meta.departureDate}` : null),
    source: 'realtime-trains',
  };
}

/**
 * Reads live National Rail trains from the Realtime Trains API (data.rtt.io). The configured token is either
 * a long-life access token or a refresh token that buys 20-minute access tokens; the client works out which.
 */
export class RttClient {
  private cache: TtlCache;
  private access: { token: string; expires: number } | undefined;
  /** True once the token has been seen to work directly, so no access token is asked for. */
  private direct = false;
  private lastOk: number | null = null;
  private lastError: { status: number; at: number } | null = null;
  private blockedUntil = 0;
  private rate: RttState['rate'] = {};
  private system: string | null = null;

  constructor(private fetchImpl: typeof fetch, private token: string | undefined, private now: () => number) {
    this.cache = new TtlCache(now);
  }

  get configured() {
    return Boolean(this.token);
  }

  /** What is known about the feed from the calls made so far; it never spends a request. */
  state(): RttState {
    const iso = (value: number) => new Date(value).toISOString();
    return {
      configured: this.configured,
      last_ok_at: this.lastOk === null ? null : iso(this.lastOk),
      last_error: this.lastError ? { status: this.lastError.status, at: iso(this.lastError.at) } : null,
      blocked_until: this.blockedUntil > this.now() ? iso(this.blockedUntil) : null,
      rate: this.rate, system: this.system,
    };
  }

  /**
   * Whether Realtime Trains accepts the token: true, false, or null when a long-life token has not been used
   * yet. A refresh token is checked by buying an access token, which is kept, so this rarely costs a request.
   */
  async verify(): Promise<boolean | null> {
    if (!this.token) return null;
    try {
      await this.bearer();
    } catch {
      return false;
    }
    // A data call that failed since the last good one outweighs a token that was merely accepted.
    const failedLast = this.lastError && this.lastError.status !== 429 && (this.lastOk === null || this.lastError.at > this.lastOk);
    if (failedLast) return false;
    return this.direct && this.lastOk === null ? null : true;
  }

  private async send(path: string, bearer: string): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, BASE), { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new RttError(503);
    }
  }

  /** The bearer for data calls: the token itself, or an access token bought with it. */
  private async bearer(): Promise<string> {
    if (this.direct) return this.token!;
    if (this.access && this.access.expires - TOKEN_MARGIN_MS > this.now()) return this.access.token;
    const response = await this.send('/api/get_access_token', this.token!);
    if (response.status === 429) throw new RttError(429, Number(response.headers.get('Retry-After')) || undefined);
    // A long-life access token is not a refresh token, so this endpoint refuses it: use it as it is.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      this.direct = true;
      return this.token!;
    }
    if (!response.ok) throw new RttError(response.status);
    const body = await response.json().catch(() => null) as { token?: unknown; validUntil?: unknown } | null;
    if (typeof body?.token !== 'string') throw new RttError(502);
    const expires = typeof body.validUntil === 'string' ? Date.parse(body.validUntil) : NaN;
    this.access = { token: body.token, expires: Number.isFinite(expires) ? expires : this.now() + 10 * 60_000 };
    return this.access.token;
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    if (!this.token) throw new RttError(401);
    if (this.blockedUntil > this.now()) throw new RttError(429, Math.ceil((this.blockedUntil - this.now()) / 1000));
    const query = new URLSearchParams(params).toString();
    try {
      let response = await this.send(`${path}?${query}`, await this.bearer());
      if (response.status === 401 && this.access) {
        // The access token was revoked or expired early: buy one more and try once.
        this.access = undefined;
        response = await this.send(`${path}?${query}`, await this.bearer());
      }
      for (const dimension of DIMENSIONS) {
        const read = (kind: string) => {
          const value = response.headers.get(`X-RateLimit-${kind}-${dimension}`);
          return value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
        };
        const limit = read('Limit');
        const remaining = read('Remaining');
        if (limit !== null || remaining !== null) this.rate[dimension.toLowerCase() as Lowercase<typeof dimension>] = { limit, remaining };
      }
      if (response.status === 429) {
        const wait = Number(response.headers.get('Retry-After')) || 60;
        this.blockedUntil = this.now() + wait * 1000;
        throw new RttError(429, wait);
      }
      if (response.status === 204) {
        this.lastOk = this.now();
        return null;
      }
      if (!response.ok) throw new RttError(response.status);
      const body = await response.json().catch(() => { throw new RttError(502); });
      this.lastOk = this.now();
      return body;
    } catch (error) {
      const status = error instanceof RttError ? error.status : 500;
      this.lastError = { status, at: this.now() };
      throw error instanceof RttError ? error : new RttError(500);
    }
  }

  private noteSystem(status: z.infer<typeof systemStatus>) {
    const parts = [status?.rttCore, status?.realtimeNetworkRail].filter((value): value is string => Boolean(value) && value !== 'OK');
    this.system = status ? (parts.length ? parts.join(', ') : 'OK') : this.system;
  }

  /** Whether board() would answer from cache, so a caller can report it without spending a request. */
  boardCached(crs: string, callingAt?: string) {
    return this.cache.has(`board:${crs}:${callingAt ?? ''}`);
  }

  /** Trains departing a station in the next hour, soonest first, optionally only those later calling at another. */
  board(crs: string, callingAt?: string): Promise<RttBoard> {
    return this.cache.get(`board:${crs}:${callingAt ?? ''}`, BOARD_TTL_MS, async () => {
      const raw = await this.request('/gb-nr/location', { code: crs, ...(callingAt ? { filterTo: callingAt } : {}) });
      if (raw === null) return { departures: [], system: this.system };
      const parsed = lineUp.safeParse(raw);
      if (!parsed.success) throw new RttError(502);
      this.noteSystem(parsed.data.systemStatus);
      const now = this.now();
      const departures = (parsed.data.services ?? []).map((service) => toDeparture(service, now)).filter((item): item is RttDeparture => item !== null);
      return { departures, system: this.system };
    });
  }

  /** One train's calling points with live times. id is "gb-nr:L01525:2026-11-14" or "L01525:2026-11-14". */
  service(id: string) {
    const unique = id.replace(/^gb-nr:/, '');
    return this.cache.get(`service:${unique}`, BOARD_TTL_MS, async () => {
      const raw = await this.request('/gb-nr/service', { uniqueIdentity: unique });
      const parsed = serviceDetail.safeParse(raw);
      if (!parsed.success) throw new RttError(raw === null ? 404 : 502);
      this.noteSystem(parsed.data.systemStatus);
      const { service } = parsed.data;
      const calls = (service.locations ?? []).flatMap((item) => {
        const call = item.temporalData;
        const display = call?.displayAs ?? 'PASS';
        const callTypes = [call?.scheduledCallType, call?.realtimeCallType].filter(Boolean);
        if (display === 'PASS' || (callTypes.length > 0 && callTypes.every((type) => type === 'OPERATIONAL_ONLY'))) return [];
        const cancelled = display === 'CANCELLED' || display === 'DIVERTED';
        return [{
          station: clean(item.location?.description) || 'Unknown', crs: item.location?.shortCodes?.[0] ?? null,
          call: display.toLowerCase(),
          arrival: trainTime(call?.arrival, cancelled), departure: trainTime(call?.departure, cancelled),
          platform: platformOf(item.locationMetadata?.platform),
          at_station: call?.status ? call.status.toLowerCase().replace(/_/g, ' ') : null,
        }];
      });
      const meta = service.scheduleMetadata;
      return {
        service_id: `gb-nr:${unique}`,
        operator: clean(meta?.operator?.name, 60) || null, operator_code: clean(meta?.operator?.code, 4) || null,
        mode: modeOf(meta?.modeType),
        origin: places(service.origin), destination: places(service.destination),
        reason: reasonText(service.reasons), calls,
      };
    });
  }
}
