import {
  LINES_STALE_MS, MAX_STATIONS, TUBE_LINES, addRecent, addStation, canAddStation, cleanLocation, clockTime,
  destinationsOf, formatTimes, groupBoard, parseRecents, parseRoute, parseSettings, parseStoredLines, removeStation,
  routeHash, setLineShown, shownLines, storeLines, updatedLabel,
} from './logic.js';

const SETTINGS_KEY = 'tube-settings';
const RECENTS_KEY = 'tube-recents';
const LINES_KEY = 'tube-station-lines';
// Every screen asks for every line's status: it is one TfL call whatever the count, and the server's
// cache then answers every screen and every phone from the same entry.
const ALL_LINE_IDS = TUBE_LINES.map((line) => line.id);
const REFRESH_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 250;
const PULL_THRESHOLD_PX = 70;
const LIVE_VIEWS = new Set(['home', 'line', 'station']);

const $ = (selector, root = document) => root.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lineBar(lineId, className = 'line-bar') {
  const bar = el('span', className);
  const color = TUBE_LINES.find((line) => line.id === lineId)?.color;
  if (color) bar.style.setProperty('--line-color', color);
  return bar;
}

const lineName = (id) => TUBE_LINES.find((line) => line.id === id)?.name ?? id;

// ---- Storage (private browsing can block it; the app then forgets on reload) ----

function read(key, parse) {
  try {
    return parse(localStorage.getItem(key));
  } catch {
    return parse(null);
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do: the in-memory copy still works for this visit.
  }
}

let settings = read(SETTINGS_KEY, parseSettings);
let recents = read(RECENTS_KEY, parseRecents);
let storedLines = read(LINES_KEY, parseStoredLines);

// ---- Fetching ----

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

const api = {
  status: (lines) => getJson(`/api/status?lines=${lines.join(',')}`).then((r) => r.lines),
  arrivals: (stop, line) =>
    getJson(`/api/arrivals?stop=${encodeURIComponent(stop)}${line ? `&line=${encodeURIComponent(line)}` : ''}`)
      .then((r) => r.arrivals),
  station: (stop) => getJson(`/api/station?stop=${encodeURIComponent(stop)}`),
  search: (q) => getJson(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.stops),
  nearby: (lat, lon) => getJson(`/api/nearby?lat=${lat}&lon=${lon}`).then((r) => r.stations),
};

/**
 * A station's tube lines rarely change, so they are kept on the phone and used straight away; a copy older
 * than a day is refreshed in the background for next time. Asked at most once per visit. A failed ask is
 * forgotten so it can be retried.
 */
const stationLineCache = new Map();

function fetchStationLines(id) {
  return api.station(id).then((station) => {
    const lines = station.lines.map((line) => line.id);
    storedLines = storeLines(storedLines, id, lines, Date.now());
    write(LINES_KEY, storedLines);
    return lines;
  });
}

function stationLines(id) {
  if (stationLineCache.has(id)) return stationLineCache.get(id);
  const stored = storedLines[id];
  let lines;
  if (stored) {
    lines = Promise.resolve(stored.lines);
    if (Date.now() - stored.saved > LINES_STALE_MS) fetchStationLines(id).catch(() => {});
  } else {
    lines = fetchStationLines(id);
    lines.catch(() => stationLineCache.delete(id));
  }
  stationLineCache.set(id, lines);
  return lines;
}

/**
 * Run every request at once, calling `apply` with each result as soon as it lands, so the screen fills in
 * piece by piece instead of waiting for the slowest. Resolves to whether any failed. Results that land after
 * the screen has changed are dropped.
 */
async function loadAll(token, requests) {
  const results = await Promise.allSettled(
    requests.map(([request, apply]) =>
      request.then((value) => {
        if (token === viewToken) apply(value);
      }),
    ),
  );
  return results.some((r) => r.status === 'rejected');
}

// ---- Navigation ----

let route = parseRoute(location.hash);
let viewToken = 0;

function go(next) {
  location.hash = routeHash(next);
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-back]')) return;
  // Opened straight onto an inner screen (e.g. from the home-screen icon after a crash): go home instead.
  if (history.length > 1) history.back();
  else go({ view: 'home' });
});

function showView(name) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${name}`;
  window.scrollTo(0, 0);
}

// ---- Live refresh: only the screen on show, only while the app is open ----

let refreshTimer = null;
let lastUpdated = null;
let currentRefresh = null;

function startTimer() {
  clearInterval(refreshTimer);
  refreshTimer = null;
  if (!currentRefresh) return;
  currentRefresh();
  refreshTimer = setInterval(currentRefresh, REFRESH_MS);
}

/** Make `refresh` the live screen's loader. Pass null for screens with nothing live. */
function setLive(refresh) {
  currentRefresh = refresh;
  lastUpdated = null;
  renderUpdated();
  startTimer();
}

function renderUpdated() {
  for (const node of document.querySelectorAll('.view:not([hidden]) .updated')) {
    node.textContent = lastUpdated === null ? '' : updatedLabel(Date.now() - lastUpdated);
  }
}
setInterval(renderUpdated, 1000);

function showError(view, failed) {
  const banner = $(`#view-${view} .error`);
  banner.hidden = !failed;
  banner.textContent = failed
    ? lastUpdated === null
      ? "Can't reach TfL right now. Pull down to try again."
      : "Can't reach TfL right now. Showing the last update."
    : '';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    startTimer();
  } else {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

// ---- Boards: a station's lines, each with its status and next trains each way ----

function directionRow(stop, line, direction) {
  const link = el('a', 'dir-row');
  link.href = routeHash({ view: 'line', stop: stop.id, name: stop.name, line, bound: direction.label });
  link.append(
    el('span', 'dir-label', direction.label),
    el('span', 'dir-times', formatTimes(direction.arrivals.map((a) => a.minutes))),
    el('span', 'dir-dest', destinationsOf(direction.arrivals)),
    el('span', 'chevron', '›'),
  );
  return link;
}

/** One card per line. Without arrivals (not loaded yet, or TfL failed) the cards show status only. */
function boardCards(stop, lineIds, statuses, arrivals) {
  const board = arrivals ? groupBoard(arrivals) : [];
  return lineIds.map((id) => {
    const card = el('section', 'card line-card');
    const head = el('div', 'line-head');
    head.append(lineBar(id), el('h3', 'line-name', lineName(id)));
    const status = statuses?.find((s) => s.id === id);
    if (status) head.append(el('span', `status-text ${status.level}`, status.status));
    card.append(head);
    if (status?.reason) card.append(el('p', 'status-reason', status.reason));

    if (arrivals) {
      const directions = board.find((l) => l.line === id)?.directions ?? [];
      if (directions.length === 0) card.append(el('p', 'no-trains', `No trains from ${stop.name} right now`));
      for (const direction of directions) card.append(directionRow(stop, id, direction));
    }
    return card;
  });
}

/** The lines to show: the station's own list, else whatever lines its trains are on. */
function lineIdsFor(station, lines, arrivals) {
  const all = lines ?? (arrivals ? groupBoard(arrivals).map((l) => l.line) : []);
  return shownLines(station, all);
}


// ---- Home: every saved station, stacked ----

// The last good copy of each, so one failed request doesn't blank the rest.
let homeData = { statuses: null, lines: new Map(), arrivals: new Map() };

function renderHome() {
  const nodes = [];
  for (const station of settings.stations) {
    const arrivals = homeData.arrivals.get(station.id) ?? null;
    const lineIds = lineIdsFor(station, homeData.lines.get(station.id), arrivals);
    nodes.push(el('h2', 'station-heading', station.name));
    if (lineIds.length === 0) {
      const note = el('p', 'card note');
      note.textContent = arrivals || homeData.lines.has(station.id) ? 'Every line here is hidden. Change that in Settings.' : 'Loading…';
      nodes.push(note);
    } else {
      nodes.push(...boardCards(station, lineIds, homeData.statuses, arrivals));
    }
  }
  $('#home-board').replaceChildren(...nodes);
}

async function loadHome(token) {
  const { stations } = settings;
  const failed = await loadAll(token, [
    [api.status(ALL_LINE_IDS), (statuses) => { homeData.statuses = statuses; renderHome(); }],
    ...stations.map((s) => [stationLines(s.id), (lines) => { homeData.lines.set(s.id, lines); renderHome(); }]),
    ...stations.map((s) => [api.arrivals(s.id), (arrivals) => { homeData.arrivals.set(s.id, arrivals); renderHome(); }]),
  ]);
  if (token !== viewToken) return;
  showError('home', failed);
  if (!failed) lastUpdated = Date.now();
  renderUpdated();
}

function openHome(token) {
  const empty = settings.stations.length === 0;
  $('#welcome').hidden = !empty;
  $('#view-home .error').hidden = true;
  homeData = { statuses: null, lines: new Map(), arrivals: new Map() };
  renderHome();
  setLive(empty ? null : () => loadHome(token));
}

// ---- Line: every train for one line at one station ----

function trainRow(arrival) {
  const row = el('li', 'train');
  const when = el('div', 'train-when');
  when.append(
    el('span', 'train-mins', arrival.minutes === 0 ? 'Due' : String(arrival.minutes)),
    el('span', 'train-clock', arrival.minutes === 0 ? clockTime(arrival.expected) : `min · ${clockTime(arrival.expected)}`),
  );
  const what = el('div', 'train-what');
  const where = [cleanLocation(arrival.location), arrival.platform].filter(Boolean).join(' · ');
  what.append(el('span', 'train-dest', arrival.destination), el('span', 'train-where', where));
  row.append(when, what);
  return row;
}

function renderLine(arrivals) {
  const directions = groupBoard(arrivals)[0]?.directions ?? [];
  const chosen = directions.find((d) => d.label === route.bound) ?? directions[0];

  $('#line-bounds').hidden = directions.length < 2;
  $('#line-bounds').replaceChildren(
    ...directions.map((direction) => {
      const tab = el('button', direction === chosen ? 'on' : '', direction.label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(direction === chosen));
      tab.addEventListener('click', () => {
        // Replace rather than push, so Back leaves the line instead of undoing the switch.
        history.replaceState(null, '', routeHash({ ...route, bound: direction.label }));
        route = parseRoute(location.hash);
        renderLine(arrivals);
      });
      return tab;
    }),
  );

  $('#line-trains').replaceChildren(
    ...(chosen ? chosen.arrivals.map(trainRow) : [el('li', 'note', `No ${lineName(route.line)} line trains from here right now.`)]),
  );
}

async function loadLine(token) {
  const [status, arrivals] = await Promise.allSettled([api.status(ALL_LINE_IDS), api.arrivals(route.stop, route.line)]);
  if (token !== viewToken) return;

  const line = status.status === 'fulfilled' ? status.value.find((s) => s.id === route.line) : null;
  if (line) {
    const node = $('#line-status');
    node.className = `line-status ${line.level}`;
    node.textContent = line.reason ?? line.status;
  }
  if (arrivals.status === 'fulfilled') renderLine(arrivals.value);
  const failed = status.status === 'rejected' || arrivals.status === 'rejected';
  showError('line', failed);
  if (!failed) lastUpdated = Date.now();
  renderUpdated();
}

function openLine(token) {
  const bar = $('#view-line .line-bar');
  bar.style.setProperty('--line-color', TUBE_LINES.find((l) => l.id === route.line)?.color ?? 'transparent');
  $('#line-name').textContent = lineName(route.line);
  $('#line-station').textContent = route.name;
  $('#line-status').textContent = '';
  $('#line-bounds').replaceChildren();
  $('#line-trains').replaceChildren();
  $('#view-line .error').hidden = true;
  setLive(() => loadLine(token));
}

// ---- Another station ----

function stationLink(stop, detail) {
  const row = el('li');
  const link = el('a', 'list-row');
  link.href = routeHash({ view: 'station', stop: stop.id, name: stop.name });
  const text = el('span', 'list-text');
  text.append(el('span', '', stop.name));
  if (detail) text.append(el('span', 'list-detail', detail));
  link.append(text);
  if (stop.lines) {
    const dots = el('span', 'line-dots');
    dots.append(...stop.lines.map((id) => lineBar(id, 'line-dot')));
    link.append(dots);
  }
  link.append(el('span', 'chevron', '›'));
  row.append(link);
  return row;
}

const distanceLabel = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

function renderRecents() {
  $('#recent-section').hidden = recents.length === 0;
  $('#recent-list').replaceChildren(...recents.map((stop) => stationLink(stop)));
}

let exploreTimer = null;
let exploreToken = 0;

function setExploreResults(message, rows = []) {
  $('#explore-message').textContent = message;
  $('#explore-results').replaceChildren(...rows);
}

$('#explore-search').addEventListener('input', (event) => {
  clearTimeout(exploreTimer);
  const query = event.target.value.trim();
  const token = ++exploreToken;
  if (query.length < 2) return setExploreResults('');
  exploreTimer = setTimeout(async () => {
    setExploreResults('Searching…');
    try {
      const stops = (await api.search(query)).filter((stop) => stop.modes.includes('tube'));
      if (token !== exploreToken) return;
      setExploreResults(stops.length === 0 ? 'No tube stations found.' : '', stops.map((stop) => stationLink(stop)));
    } catch {
      if (token === exploreToken) setExploreResults("Couldn't search right now. Try again.");
    }
  }, SEARCH_DEBOUNCE_MS);
});

$('#near-me').addEventListener('click', () => {
  const token = ++exploreToken;
  $('#explore-search').value = '';
  if (!('geolocation' in navigator)) return setExploreResults("This phone can't share its location. Search instead.");
  setExploreResults('Finding stations near you…');
  navigator.geolocation.getCurrentPosition(
    async ({ coords }) => {
      try {
        const stations = await api.nearby(coords.latitude, coords.longitude);
        if (token !== exploreToken) return;
        setExploreResults(
          stations.length === 0 ? 'No tube stations within 1.5 km. Search instead.' : '',
          stations.map((s) => stationLink(s, distanceLabel(s.distance))),
        );
      } catch {
        if (token === exploreToken) setExploreResults("Couldn't load nearby stations. Try again.");
      }
    },
    (error) => {
      if (token !== exploreToken) return;
      setExploreResults(
        error.code === error.PERMISSION_DENIED
          ? 'Location is off for this app. Search instead, or allow location in Settings.'
          : "Couldn't find where you are. Search instead.",
      );
    },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
  );
});

function openExplore() {
  exploreToken++;
  $('#explore-search').value = '';
  setExploreResults('');
  renderRecents();
  setLive(null);
}

// ---- Any station: the same board as home ----

function renderStationAdd() {
  const saved = settings.stations.some((s) => s.id === route.stop);
  $('#station-add').hidden = saved || !canAddStation(settings);
  $('#station-saved').textContent = saved
    ? 'In your stations, so it shows on home.'
    : canAddStation(settings)
      ? ''
      : `You have ${MAX_STATIONS} stations saved. Remove one in Settings to add this.`;
}

$('#station-add').addEventListener('click', () => {
  settings = addStation(settings, { id: route.stop, name: route.name });
  saveSettings();
  renderStationAdd();
});

// The last good copy of each, so a failed refresh keeps what was showing.
let stationData = { statuses: null, lines: null, arrivals: null };

function renderStation(done) {
  const stop = { id: route.stop, name: route.name };
  // Every line here shows, whatever you've hidden at a saved station.
  const lineIds = lineIdsFor({ hidden: [] }, stationData.lines, stationData.arrivals);
  if (lineIds.length > 0) {
    $('#station-board').replaceChildren(...boardCards(stop, lineIds, stationData.statuses, stationData.arrivals));
  } else if (done) {
    $('#station-board').replaceChildren(el('p', 'card note', 'No tube lines stop here.'));
  }
}

async function loadStation(token) {
  const failed = await loadAll(token, [
    [api.status(ALL_LINE_IDS), (statuses) => { stationData.statuses = statuses; renderStation(false); }],
    [stationLines(route.stop), (lines) => { stationData.lines = lines; renderStation(false); }],
    [api.arrivals(route.stop), (arrivals) => { stationData.arrivals = arrivals; renderStation(false); }],
  ]);
  if (token !== viewToken) return;
  renderStation(!failed);
  showError('station', failed);
  if (!failed) lastUpdated = Date.now();
  renderUpdated();
}

function openStation(token) {
  $('#station-title').textContent = route.name;
  $('#station-board').replaceChildren();
  $('#view-station .error').hidden = true;
  stationData = { statuses: null, lines: null, arrivals: null };
  renderStationAdd();

  recents = addRecent(recents, { id: route.stop, name: route.name });
  write(RECENTS_KEY, recents);
  setLive(() => loadStation(token));
}

// ---- Settings: your stations, and which of each one's lines to show ----

let searchTimer = null;
let searchToken = 0;

function saveSettings() {
  write(SETTINGS_KEY, settings);
}

function lineOption(station, lineId) {
  const label = el('label', 'line-option');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !station.hidden.includes(lineId);
  checkbox.addEventListener('change', () => {
    settings = setLineShown(settings, station.id, lineId, checkbox.checked);
    saveSettings();
  });
  label.append(lineBar(lineId), el('span', '', lineName(lineId)), checkbox);
  return label;
}

function renderSavedStations() {
  $('#no-stations').hidden = settings.stations.length > 0;
  $('#saved-stations').replaceChildren(
    ...settings.stations.map((station) => {
      const card = el('section', 'card saved-station');
      const head = el('div', 'saved-head');
      const remove = el('button', 'remove-button', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${station.name}`);
      remove.addEventListener('click', () => {
        settings = removeStation(settings, station.id);
        saveSettings();
        renderSavedStations();
        renderAddMessage();
      });
      head.append(el('h3', '', station.name), remove);
      const lines = el('div', '');
      lines.append(el('p', 'note small', 'Loading lines…'));
      card.append(head, lines);

      stationLines(station.id).then(
        (ids) => {
          // Read the latest copy: the ticks may have changed while this loaded.
          const current = settings.stations.find((s) => s.id === station.id);
          if (!current) return;
          lines.replaceChildren(
            ...(ids.length === 0
              ? [el('p', 'note small', 'No tube lines stop here.')]
              : shownLines({ hidden: [] }, ids).map((id) => lineOption(current, id))),
          );
        },
        () => lines.replaceChildren(el('p', 'note small', "Couldn't load this station's lines. Open Settings again to retry.")),
      );
      return card;
    }),
  );
}

function renderAddMessage() {
  if (canAddStation(settings)) {
    $('#stop-search').disabled = false;
    if ($('#search-message').dataset.full) $('#search-message').textContent = '';
    delete $('#search-message').dataset.full;
  } else {
    clearSettingsSearch();
    $('#stop-search').disabled = true;
    $('#search-message').textContent = `That's ${MAX_STATIONS} stations, the most you can save. Remove one to add another.`;
    $('#search-message').dataset.full = 'true';
  }
}

function clearSettingsSearch() {
  searchToken++;
  clearTimeout(searchTimer);
  $('#stop-search').value = '';
  $('#search-message').textContent = '';
  $('#search-results').replaceChildren();
}

$('#stop-search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const query = event.target.value.trim();
  const token = ++searchToken;
  if (query.length < 2) {
    $('#search-message').textContent = '';
    $('#search-results').replaceChildren();
    return;
  }
  searchTimer = setTimeout(async () => {
    $('#search-message').textContent = 'Searching…';
    try {
      const stops = (await api.search(query)).filter((stop) => stop.modes.includes('tube'));
      if (token !== searchToken) return;
      $('#search-message').textContent = stops.length === 0 ? 'No tube stations found.' : '';
      $('#search-results').replaceChildren(
        ...stops.map((stop) => {
          const row = el('li');
          const saved = settings.stations.some((s) => s.id === stop.id);
          const button = el('button', 'list-row');
          button.type = 'button';
          button.append(el('span', 'list-text', stop.name));
          if (saved) button.append(el('span', 'list-detail', 'Saved'));
          button.disabled = saved;
          button.addEventListener('click', () => {
            settings = addStation(settings, { id: stop.id, name: stop.name });
            saveSettings();
            clearSettingsSearch();
            renderSavedStations();
            renderAddMessage();
          });
          row.append(button);
          return row;
        }),
      );
    } catch {
      if (token !== searchToken) return;
      $('#search-message').textContent = "Couldn't search right now. Try again.";
      $('#search-results').replaceChildren();
    }
  }, SEARCH_DEBOUNCE_MS);
});

function openSettings() {
  setLive(null);
  clearSettingsSearch();
  renderSavedStations();
  renderAddMessage();
}

// ---- Pull to refresh (live screens only) ----

let pullStartY = null;
let pullReady = false;

function setPullIndicator(distance) {
  const indicator = $('#pull-indicator');
  const progress = Math.min(distance / PULL_THRESHOLD_PX, 1);
  indicator.style.opacity = String(progress);
  indicator.style.transform = `translate(-50%, ${-60 + progress * 60}px)`;
  indicator.textContent = progress >= 1 ? 'Release to refresh' : 'Pull to refresh';
}

window.addEventListener('touchstart', (event) => {
  if (!LIVE_VIEWS.has(route.view) || window.scrollY > 0 || event.touches.length !== 1) return;
  pullStartY = event.touches[0].clientY;
}, { passive: true });

window.addEventListener('touchmove', (event) => {
  if (pullStartY === null) return;
  const distance = event.touches[0].clientY - pullStartY;
  pullReady = distance >= PULL_THRESHOLD_PX;
  setPullIndicator(Math.max(distance, 0));
}, { passive: true });

function endPull() {
  if (pullStartY === null) return;
  pullStartY = null;
  setPullIndicator(0);
  if (pullReady) startTimer();
  pullReady = false;
}
window.addEventListener('touchend', endPull);
window.addEventListener('touchcancel', endPull);

// ---- Start ----

function render() {
  route = parseRoute(location.hash);
  const token = ++viewToken;
  showView(route.view);
  if (route.view === 'home') openHome(token);
  else if (route.view === 'line') openLine(token);
  else if (route.view === 'explore') openExplore();
  else if (route.view === 'station') openStation(token);
  else openSettings();
}

window.addEventListener('hashchange', render);
render();
