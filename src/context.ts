import type { OwnerStore } from './store.js';
import type { RttClient } from './rtt.js';
import { type NetworkLineStatus, TflClient } from './tfl.js';

/**
 * get_context returns only what tool descriptions cannot know: what the user has saved and
 * what is true right now. It carried routing and wording advice until blind tests (bench/no-anchor,
 * bench/harder) found that advice cost about 4,000 tokens a conversation and changed no outcome; the
 * descriptions, and guidance returned by a tool at the moment it applies, do that work.
 */

const LONDON_RAIL = new Set(['tube', 'elizabeth-line', 'overground', 'dlr', 'tram']);

function londonClock(now: number) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(new Date(now));
  const part = (kind: string) => parts.find((item) => item.type === kind)?.value ?? '';
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00';
  return {
    london_time: `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:00${offset}`,
    weekday: part('weekday'),
  };
}

function railFeed(rtt: RttClient | undefined, tokenAccepted: boolean | null) {
  const serves = 'Live departures for every National Rail operator, the calling_at filter and train_service.';
  if (!rtt?.configured) {
    return {
      state: 'not_configured', serves,
      effect: 'National Rail operators other than Thameslink have no live departures. Use timetable or plan_journey and say the time is timetabled. calling_at and train_service are unavailable.',
    };
  }
  const known = rtt.state();
  const allowance = {
    limits: '10 requests a minute, 100 an hour, 1,000 a day, shared by every conversation',
    remaining: known.rate, cache_seconds: 60,
    rule: 'One station board or one train is one request. Never loop over stations or poll a board; a repeat inside a minute is served from cache.',
  };
  if (known.blocked_until) {
    return { state: 'rate_limited', serves, blocked_until: known.blocked_until, allowance, effect: 'Until then National Rail live boards fail and say so; fall back to timetable and say the time is timetabled.' };
  }
  if (tokenAccepted === false) {
    return { state: 'failing', serves, last_error: known.last_error, allowance, effect: 'Realtime Trains is refusing or not answering. Treat National Rail as timetabled only and tell the user the live feed is down.' };
  }
  if (tokenAccepted === null) {
    return { state: 'unverified', serves, allowance, effect: 'A token is configured but no board has been read since the server started. The first live_departures call at a National Rail station will show whether it works.' };
  }
  return {
    state: known.system && known.system !== 'OK' ? 'degraded' : 'ok', serves,
    ...(known.system && known.system !== 'OK' ? { upstream_status: known.system, effect: 'Realtime Trains is running on limited live data: its times may be timetable times.' } : {}),
    last_board_read_at: known.last_ok_at, ...(known.last_error ? { last_error: known.last_error } : {}), allowance,
  };
}

function networkNow(lines: NetworkLineStatus[]) {
  const disrupted = lines.filter((line) => line.level !== 'good');
  const brief = (line: NetworkLineStatus) => ({ id: line.id, name: line.name, mode: line.mode, status: line.status, level: line.level });
  return {
    london_lines_disrupted: disrupted.filter((line) => LONDON_RAIL.has(line.mode)).map(brief),
    national_rail_operators_disrupted: disrupted.filter((line) => line.mode === 'national-rail').map((line) => ({ id: line.id, status: line.status })),
    lines_with_good_service: lines.length - disrupted.length,
  };
}

export async function userContext(tfl: TflClient, rtt: RttClient | undefined, places: OwnerStore, now: number) {
  const [network, tokenAccepted] = await Promise.all([
    tfl.networkStatus().then((lines) => ({ ok: true as const, lines }), () => ({ ok: false as const, lines: [] as NetworkLineStatus[] })),
    rtt?.configured ? rtt.verify() : Promise.resolve(null),
  ]);
  const railLive = railFeed(rtt, tokenAccepted);
  const saved = places.list();
  const preferences = places.preferences();
  const avoided = preferences?.avoid_modes ?? [];
  const followed = places.trackedJourneys(now);
  // What only the owner can switch on, in the host's settings. Listed while it is outstanding, so the model can remind them.
  const setup = [
    ...(rtt?.configured ? [] : [{ missing: 'RTT_TOKEN', where: 'The environment variables of the host running this server', unlocks: 'Live departures for every National Rail operator, calling_at and train_service.', how: 'Paste the Realtime Trains API token from api-portal.rtt.io as RTT_TOKEN.' }]),
    ...(places.durable ? [] : [{ missing: 'DATA_DIR on a volume', where: 'The host running this server: attach persistent storage (on Railway, a volume), then set DATA_DIR to its path', unlocks: 'Saved places, travel preferences and followed journeys that survive restarts and deploys.', how: 'Add a volume (for example mounted at /data) and set DATA_DIR=/data.' }]),
  ];

  return {
    clock: londonClock(now),
    user: {
      saved_places: saved.map(({ label, place, note }) => ({ label, place, ...(note ? { note } : {}) })),
      avoid_modes: avoided,
      ...(preferences?.note ? { preference_note: preferences.note } : {}),
      followed_journeys: followed.map((journey) => ({ label: journey.label, from: journey.from_name, to: journey.to_name, departs: journey.route.departure, planned_arrival: journey.route.arrival })),
      ...(places.durable ? {} : { not_durable: 'Saved on a server with no storage directory: lost when it restarts or redeploys.' }),
    },
    feeds: {
      tfl: {
        state: network.ok ? 'ok' : 'failing',
        ...(network.ok ? {} : { effect: 'TfL did not answer just now. Tell the user TfL is unreachable rather than inferring normal service.' }),
      },
      national_rail_live: railLive,
    },
    ...(network.ok ? { network_now: networkNow(network.lines) } : {}),
    ...(setup.length ? { owner_setup_pending: setup } : {}),
  };
}
