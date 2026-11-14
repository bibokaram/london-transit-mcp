import { CRS_TABLE } from './data/crs.js';
import { cleanStationName, type RawStopChild, type RawStopPoint, type StationMatch, TflClient, TflError } from './tfl.js';

/** Modes that have stations. Names resolve only to these, never to a bus stop or street. */
export const STATION_MODES = ['tube', 'elizabeth-line', 'overground', 'dlr', 'tram', 'national-rail', 'river-bus', 'cable-car'] as const;
const RAIL_SEARCH_MODES = ['tube', 'elizabeth-line', 'overground', 'dlr', 'tram', 'national-rail'] as const;

const CRS = new Map(CRS_TABLE.split(' ').map((pair) => {
  const [code, suffix] = pair.split(':') as [string, string];
  return [code, `910G${suffix}`];
}));

/** TfL stop and hub IDs: HUBxxx, NaPTAN station/stop codes such as 910GLNDNBDC, 940GZZLUVIC, 490000139R. */
const STOP_ID = /^(?=.{4,16}$)(HUB[A-Z0-9]+|[0-9]{3}[0-9A-Z]*[A-Z][0-9A-Z]*)$/;
/** Whether a value has the shape of a TfL stop or hub ID, as opposed to a name. */
export const looksLikeStopId = (value: string) => STOP_ID.test(value);
const ICS_ID = /^[0-9]{7}$/;
const POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$/i;
const COORDINATES = /^-?[0-9]+(\.[0-9]+)?,\s*-?[0-9]+(\.[0-9]+)?$/;

/** One stop in a station group and the lines TfL lists for it. */
export type StationStop = { id: string; modes: string[]; lines: { id: string; name: string; mode: string }[] };
/** icsCodes: the ICS codes of the group and its stations, which the journey planner reports at arrival. */
export type Station = { id: string; name: string; icsCode: string | null; stops: StationStop[]; icsCodes?: string[] };
export type Candidate = { id: string; name: string; modes: string[] };
export type Resolution =
  | { status: 'ok'; station: Station; matched_by: 'crs' | 'stop_id' | 'name' }
  | { status: 'ambiguous'; candidates: Candidate[]; truncated: boolean }
  | { status: 'not_found' };
const MAX_CANDIDATES = 8;

/** A station name for output: TfL pads some names ("Waterloo Station   / York Road"). */
export const displayName = (name: string) => cleanStationName(name).replace(/\s+/g, ' ').trim();

/** "King's Cross St. Pancras Underground Station" and "kings cross st pancras" compare equal. */
export function normaliseName(name: string) {
  return cleanStationName(name).toLowerCase()
    .replace(/&/g, ' and ').replace(/['’.]/g, '')
    .replace(/\b(rail|underground|dlr|overground|tram|railway)?\s*(station|stop|pier)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function crsStation(code: string) {
  return /^[A-Z]{3}$/.test(code) ? CRS.get(code) : undefined;
}

function lineModeOf(record: { lineModeGroups?: RawStopPoint['lineModeGroups'] }, lineId: string) {
  return record.lineModeGroups?.find((group) => group.lineIdentifier?.includes(lineId))?.modeName;
}

/** The NaPTAN ID prefix of a station for each mode: rail stations are 910G..., Tube, DLR, tram and cable car 940G..., piers 930G.... */
const STATION_PREFIX: Record<string, string> = {
  'national-rail': '910G', 'elizabeth-line': '910G', overground: '910G',
  tube: '940G', dlr: '940G', tram: '940G', 'cable-car': '940G', 'river-bus': '930G',
};

function descendants(node: { children?: RawStopChild[] }): RawStopChild[] {
  return (node.children ?? []).flatMap((child) => [child, ...descendants(child)]);
}
/** Rail, Tube/DLR/tram/cable car and pier station records, as opposed to their access areas, platforms and bus stops. */
const STATION_RECORD = /^(910G|930G|940G)/;

/**
 * Gives each line the station ID its mode uses. TfL can hang a station's lines on a non-station record: "Gatwick
 * Airport" and 910GGTWK both return 920GLGW0 (an airport building), whose rail station 910GGTWK sits two levels down.
 * Route sequences and the planner's calling points use 910GGTWK, so the airport ID would match neither.
 */
function toStationIds(stops: StationStop[], record: RawStopPoint): StationStop[] {
  const nested = descendants(record);
  const byId = new Map<string, StationStop>();
  for (const stop of stops) {
    for (const line of stop.lines) {
      const prefix = STATION_PREFIX[line.mode];
      const id = !prefix || stop.id.startsWith(prefix) ? stop.id
        : (nested.find((child) => child.id.startsWith(prefix) && /Station|Pier/.test(child.stopType ?? '')) ?? nested.find((child) => child.id.startsWith(prefix)))?.id ?? stop.id;
      const target = byId.get(id) ?? { id, modes: [], lines: [] };
      if (!target.modes.includes(line.mode)) target.modes.push(line.mode);
      target.lines.push(line);
      byId.set(id, target);
    }
  }
  return [...byId.values()];
}

/** Turns a station or interchange record into its stations and the lines at each, leaving out bus stops. */
export function stationFromRecord(record: RawStopPoint): Station {
  const stopsOf = (children: NonNullable<RawStopPoint['children']>) => children
    .filter((child) => (child.modes ?? []).some((mode) => (STATION_MODES as readonly string[]).includes(mode)) && (child.lines ?? []).length > 0)
    .map((child) => ({
      id: child.id,
      modes: (child.modes ?? []).filter((mode) => mode !== 'bus'),
      lines: (child.lines ?? []).map((line) => ({ id: line.id, name: line.name, mode: lineModeOf(record, line.id) ?? child.modes?.[0] ?? 'unknown' }))
        .filter((line) => line.mode !== 'bus'),
    }));
  // A station can sit inside another station's record: HUBWIM nests Thameslink's 910GWIMBLDN inside SWR's 910GWDON.
  const children = record.children ?? [];
  const nested = children.flatMap(descendants).filter((child) => STATION_RECORD.test(child.id) && !children.some((top) => top.id === child.id));
  let stops = record.id.startsWith('HUB') ? stopsOf([...children, ...nested]) : [];
  if (stops.length === 0) {
    // A station outside any interchange: its own record carries the lines.
    const lines = (record.lines ?? []).map((line) => ({ id: line.id, name: line.name, mode: lineModeOf(record, line.id) ?? 'unknown' }))
      .filter((line) => line.mode !== 'bus');
    stops = lines.length ? [{ id: record.id, modes: (record.modes ?? []).filter((mode) => mode !== 'bus'), lines }] : [];
  }
  stops = toStationIds(stops, record);
  // A single station outside an interchange is known by its own station ID (910GGTWK, not the airport's 920GLGW0).
  const id = !record.id.startsWith('HUB') && stops.length === 1 ? stops[0]!.id : record.id;
  const icsCodes = [record, ...descendants(record).filter((child) => !child.id.startsWith('490'))]
    .map((node) => (node as { icsCode?: string }).icsCode).filter((code): code is string => !!code);
  return { id, name: displayName(record.commonName ?? record.id), icsCode: record.icsCode ?? null, stops, icsCodes: [...new Set(icsCodes)] };
}

/** The best station match for a typed name: an exact name, or the only match. Otherwise the caller must choose. */
export function pickStation(query: string, matches: StationMatch[]) {
  const wanted = normaliseName(query);
  const exact = matches.filter((match) => normaliseName(match.name) === wanted);
  if (exact.length >= 1) return { pick: exact[0]!, exact: true };
  if (matches.length === 1) return { pick: matches[0]!, exact: false };
  return { pick: undefined, exact: false };
}

/**
 * Resolves a station name, CRS code or TfL stop/hub ID to a station group. Names search station modes only,
 * so a street, hotel or bus stop is never chosen. An unclear name returns candidates instead of a guess.
 */
export async function resolveStation(tfl: TflClient, input: string): Promise<Resolution> {
  const value = input.trim();
  const crs = crsStation(value);
  const id = crs ?? (STOP_ID.test(value.toUpperCase()) ? value.toUpperCase() : undefined);
  if (id) {
    try {
      const station = stationFromRecord(await tfl.stopRecord(id));
      return station.stops.length ? { status: 'ok', station, matched_by: crs ? 'crs' : 'stop_id' } : { status: 'not_found' };
    } catch (error) {
      if (error instanceof TflError && (error.status === 404 || error.status === 400)) return { status: 'not_found' };
      throw error;
    }
  }
  const matches = await tfl.searchStations(value, STATION_MODES);
  const { pick } = pickStation(value, matches);
  if (!pick) {
    return matches.length
      ? { status: 'ambiguous', candidates: matches.slice(0, MAX_CANDIDATES).map(({ id, name, modes }) => ({ id, name: displayName(name), modes })), truncated: matches.length > MAX_CANDIDATES }
      : { status: 'not_found' };
  }
  const record = await tfl.stopRecord(pick.id);
  const station = stationFromRecord(record);
  // TfL answers a station inside an interchange with the HUB record ("Royal Docks" cable car -> Royal Victoria):
  // the group stays the hub, but the name is the station that was asked for.
  if (record.id.startsWith('HUB') && pick.id !== record.id) station.name = displayName(pick.name);
  return station.stops.length ? { status: 'ok', station, matched_by: 'name' } : { status: 'not_found' };
}

/** A station the planner accepts as an endpoint: value is its ICS code. */
export type PlannerStation = { value: string; name: string; modes: string[] };
/** stations: the rail and Tube stations a name partly matched, offered if the planner asks which place was meant. */
export type PlaceResolution = { input: string; value: string; name?: string; resolved_by?: 'hub_id' | 'station_name'; stations?: PlannerStation[] };

/**
 * What plan_journey sends TfL for one endpoint. A HUB ID becomes the interchange's ICS code (the planner
 * reads "HUBLBG" as a street name), and a name that exactly matches a rail or Tube station becomes that
 * station's ICS code, so "London Bridge" plans from the station rather than a street or hotel. Anything
 * else (postcodes, coordinates, stop and ICS IDs, other place names) passes through unchanged.
 */
export async function placeForPlanner(tfl: TflClient, input: string): Promise<PlaceResolution> {
  const value = input.trim();
  if (/^HUB[A-Z0-9]{2,8}$/i.test(value)) {
    try {
      const record = await tfl.stopRecord(value.toUpperCase());
      if (record.icsCode) return { input, value: record.icsCode, name: cleanStationName(record.commonName ?? value), resolved_by: 'hub_id' };
    } catch (error) {
      if (!(error instanceof TflError)) throw error;
    }
    return { input, value };
  }
  if (ICS_ID.test(value) || STOP_ID.test(value) || POSTCODE.test(value) || COORDINATES.test(value) || !/[a-z]/i.test(value)) return { input, value };
  let matches: StationMatch[];
  try {
    matches = await tfl.searchStations(value, RAIL_SEARCH_MODES);
  } catch (error) {
    // Resolution is a convenience: if the search fails, the planner still gets the name as typed.
    if (error instanceof TflError) return { input, value };
    throw error;
  }
  const { pick, exact } = pickStation(value, matches);
  if (pick && exact && pick.icsId) return { input, value: pick.icsId, name: pick.name, resolved_by: 'station_name' };
  // "Bridge" or "Croydon" match several stations; TfL's own candidates for such names are streets and places.
  const stations = matches.filter((match) => match.icsId)
    .map((match) => ({ value: match.icsId!, name: match.name, modes: match.modes }))
    .filter((station, index, all) => all.findIndex((other) => other.value === station.value) === index);
  return stations.length ? { input, value, stations } : { input, value };
}

const RAIL = new Set<string>(RAIL_SEARCH_MODES);
/** Stations first, in TfL's order otherwise, so a caller choosing a candidate sees the station near the top. */
export function stationsFirst<T extends { modes: string[] }>(options: T[]) {
  const rank = (option: T) => (option.modes.some((mode) => RAIL.has(mode)) ? 0 : 1);
  return options.map((option, index) => ({ option, index }))
    .sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index)
    .map(({ option }) => option);
}
