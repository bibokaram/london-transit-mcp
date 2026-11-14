// Official TfL line colours.
export const TUBE_LINES = [
  { id: 'bakerloo', name: 'Bakerloo', color: '#B36305' },
  { id: 'central', name: 'Central', color: '#E32017' },
  { id: 'circle', name: 'Circle', color: '#FFD300' },
  { id: 'district', name: 'District', color: '#00782A' },
  { id: 'hammersmith-city', name: 'Hammersmith & City', color: '#F3A9BB' },
  { id: 'jubilee', name: 'Jubilee', color: '#A0A5A9' },
  { id: 'metropolitan', name: 'Metropolitan', color: '#9B0056' },
  { id: 'northern', name: 'Northern', color: '#000000' },
  { id: 'piccadilly', name: 'Piccadilly', color: '#003688' },
  { id: 'victoria', name: 'Victoria', color: '#0098D4' },
  { id: 'waterloo-city', name: 'Waterloo & City', color: '#95CDBA' },
];

const MAX_TIMES_SHOWN = 3;

export function formatTimes(minutes) {
  if (minutes.length === 0) return 'No trains';
  const shown = minutes.slice(0, MAX_TIMES_SHOWN);
  const text = shown.map((m) => (m === 0 ? 'Due' : String(m))).join(', ');
  // "min" once, after the last number: "Due, 3, 7 min".
  return shown.at(-1) === 0 ? text : `${text} min`;
}

export function updatedLabel(elapsedMs) {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
}

export const MAX_STATIONS = 5;
const TUBE_LINE_IDS = TUBE_LINES.map((line) => line.id);
const isStop = (s) => s && typeof s.id === 'string' && typeof s.name === 'string';

/**
 * Settings are your saved stations, in the order you added them. Each keeps the lines you've hidden there,
 * so every line at a new station shows until you untick it.
 */
export function parseSettings(raw) {
  const empty = { stations: [] };
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return empty;

  // Before saved stations there was one home station plus the lines you'd chosen.
  if (!('stations' in saved) && isStop(saved.stop)) {
    const chosen = Array.isArray(saved.lines) ? saved.lines.filter((id) => TUBE_LINE_IDS.includes(id)) : [];
    const hidden = chosen.length > 0 ? TUBE_LINE_IDS.filter((id) => !chosen.includes(id)) : [];
    return { stations: [{ id: saved.stop.id, name: saved.stop.name, hidden }] };
  }

  if (!Array.isArray(saved.stations)) return empty;
  const stations = [];
  for (const station of saved.stations) {
    if (!isStop(station) || stations.some((s) => s.id === station.id)) continue;
    const hidden = Array.isArray(station.hidden) ? station.hidden.filter((id) => TUBE_LINE_IDS.includes(id)) : [];
    stations.push({ id: station.id, name: station.name, hidden });
    if (stations.length === MAX_STATIONS) break;
  }
  return { stations };
}

export const canAddStation = (settings) => settings.stations.length < MAX_STATIONS;

export function addStation(settings, stop) {
  if (!canAddStation(settings) || settings.stations.some((s) => s.id === stop.id)) return settings;
  return { ...settings, stations: [...settings.stations, { id: stop.id, name: stop.name, hidden: [] }] };
}

export function removeStation(settings, id) {
  return { ...settings, stations: settings.stations.filter((s) => s.id !== id) };
}

export function setLineShown(settings, stationId, lineId, shown) {
  return {
    ...settings,
    stations: settings.stations.map((station) => {
      if (station.id !== stationId) return station;
      const hidden = station.hidden.filter((id) => id !== lineId);
      return { ...station, hidden: shown ? hidden : [...hidden, lineId] };
    }),
  };
}

/** The station's lines minus the ones you've hidden there, in network order. */
export function shownLines(station, lineIds) {
  return TUBE_LINE_IDS.filter((id) => lineIds.includes(id) && !station.hidden.includes(id));
}

const COMPASS = ['Northbound', 'Southbound', 'Eastbound', 'Westbound'];

/** Arrivals (soonest first) grouped into lines, in network order, each split by direction. */
export function groupBoard(arrivals) {
  const lineOrder = TUBE_LINES.map((line) => line.id);
  const lines = new Map();
  for (const arrival of arrivals) {
    let line = lines.get(arrival.line);
    if (!line) {
      line = { line: arrival.line, lineName: arrival.lineName, directions: new Map() };
      lines.set(arrival.line, line);
    }
    const label = arrival.bound ?? (arrival.platform || 'Other');
    if (!line.directions.has(label)) line.directions.set(label, { label, bound: arrival.bound, arrivals: [] });
    line.directions.get(label).arrivals.push(arrival);
  }
  const rank = (list, value) => (list.includes(value) ? list.indexOf(value) : list.length);
  return [...lines.values()]
    .sort((a, b) => rank(lineOrder, a.line) - rank(lineOrder, b.line))
    .map((line) => ({
      line: line.line,
      lineName: line.lineName,
      directions: [...line.directions.values()].sort(
        (a, b) => rank(COMPASS, a.label) - rank(COMPASS, b.label) || a.label.localeCompare(b.label),
      ),
    }));
}

export function destinationsOf(arrivals) {
  return [...new Set(arrivals.slice(0, MAX_TIMES_SHOWN).map((a) => a.destination))].join(' · ');
}

const LONDON_CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/London',
});

export function clockTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : LONDON_CLOCK.format(date);
}

const MAX_RECENTS = 5;

export function addRecent(recents, stop) {
  return [{ id: stop.id, name: stop.name }, ...recents.filter((s) => s.id !== stop.id)].slice(0, MAX_RECENTS);
}

export function parseRecents(raw) {
  try {
    const saved = JSON.parse(raw);
    return Array.isArray(saved) ? saved.filter(isStop).map(({ id, name }) => ({ id, name })).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

const MAX_STORED_LINES = 20;
export const LINES_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Each station's tube lines, kept on the phone so a launch can draw the board without asking TfL first.
 * Shaped { [stationId]: { lines, saved } }, where saved is when they were fetched.
 */
export function parseStoredLines(raw) {
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  const stored = {};
  for (const [id, entry] of Object.entries(saved)) {
    if (!entry || !Array.isArray(entry.lines) || typeof entry.saved !== 'number') continue;
    stored[id] = { lines: entry.lines.filter((line) => TUBE_LINE_IDS.includes(line)), saved: entry.saved };
  }
  return stored;
}

/** Remember a station's lines, keeping the most recently fetched stations. */
export function storeLines(stored, id, lines, now) {
  const entries = Object.entries({ ...stored, [id]: { lines, saved: now } })
    .sort(([, a], [, b]) => b.saved - a.saved)
    .slice(0, MAX_STORED_LINES);
  return Object.fromEntries(entries);
}

/** Screens live in the URL hash so the phone's back gesture moves between them. */
export function parseRoute(hash) {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const stop = params.get('stop');
  const name = params.get('name');
  switch (path) {
    case '/settings':
      return { view: 'settings' };
    case '/explore':
      return { view: 'explore' };
    case '/station':
      return stop && name ? { view: 'station', stop, name } : { view: 'home' };
    case '/line': {
      const line = params.get('line');
      return stop && name && line ? { view: 'line', stop, name, line, bound: params.get('bound') } : { view: 'home' };
    }
    default:
      return { view: 'home' };
  }
}

export function routeHash(route) {
  if (route.view === 'home') return '#/';
  const params = new URLSearchParams();
  for (const key of ['stop', 'name', 'line', 'bound']) {
    if (route[key]) params.set(key, route[key]);
  }
  const query = params.toString();
  return `#/${route.view}${query ? `?${query}` : ''}`;
}
/** "At Platform" says nothing new beside the platform, and another station's platform number just confuses. */
export function cleanLocation(location) {
  if (!location || location === 'At Platform') return null;
  return location.replace(/ Platform \d+$/, '');
}
