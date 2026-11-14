import { type ExcludableMode, planJourney, type SavedPlaceLookup } from './journeys.js';
import { buildLegs, legPlanOf, type LegSpec } from './legs.js';
import { type OwnerStore, type TrackedJourney, type TrackedRoute } from './store.js';
import { TflClient, TflError } from './tfl.js';

/** A journey is kept this long after its planned arrival, so a late arrival can still be checked. */
export const KEEP_AFTER_ARRIVAL_MS = 2 * 60 * 60 * 1000;
/** An arrival this many minutes from the plan counts as on plan. */
const ON_PLAN_MINUTES = 2;
/** TfL's own suggestion is mentioned when it beats the saved route by at least this much. */
const WORTH_SWITCHING_MINUTES = 5;

type Planned = Awaited<ReturnType<typeof planJourney>>;

/** The route a caller chose from a plan, as a journey to follow. Undefined when the plan has no such route. */
export function journeyFromPlan(label: string, plan: Planned, choice: number, query: { time_is: 'departing' | 'arriving'; preference: TrackedJourney['preference'] }, now: number): TrackedJourney | undefined {
  if (plan.status !== 'ok' || !('routes' in plan)) return undefined;
  const picked = plan.routes[choice - 1];
  if (!picked) return undefined;
  const { disruptions_truncated: _a, legs_truncated: _b, ...route } = picked;
  const name = (end: { input: string; name?: string; saved_place?: string }, fallback: string) => end.saved_place ?? end.name ?? fallback;
  return {
    label, started_at: new Date(now).toISOString(),
    expires_at: new Date(Date.parse(route.arrival) + KEEP_AFTER_ARRIVAL_MS).toISOString(),
    from_name: name(plan.resolved.from, route.legs[0]!.from), to_name: name(plan.resolved.to, route.legs.at(-1)!.to),
    from_value: plan.resolved.from.used, to_value: plan.resolved.to.used,
    time_is: query.time_is, exclude_modes: plan.mode_filter.excluded as ExcludableMode[], preference: query.preference,
    route: route as TrackedRoute, ...legPlanOf(route as TrackedRoute, plan.resolved.to.used),
  };
}

/** A journey to follow from a route built leg by leg. */
export function journeyFromLegs(label: string, names: { from: string; to: string }, origin: string, specs: LegSpec[], built: { route: TrackedRoute; leg_spec_index: number[] }, now: number): TrackedJourney {
  return {
    label, started_at: new Date(now).toISOString(),
    expires_at: new Date(Date.parse(built.route.arrival) + KEEP_AFTER_ARRIVAL_MS).toISOString(),
    from_name: names.from, to_name: names.to, from_value: origin, to_value: specs.at(-1)!.to,
    time_is: 'departing', exclude_modes: [], preference: 'fastest',
    route: built.route, leg_plan: specs, leg_spec_index: built.leg_spec_index,
  };
}

const lineSequence = (route: TrackedRoute, fromLeg = 0) =>
  route.legs.slice(fromLeg).filter((leg) => leg.mode !== 'walking').map((leg) => leg.line_ids[0] ?? leg.mode).join('>');

/**
 * Where a followed journey stands now. The server cannot see the traveller, so their position is taken from
 * the planned times; the rest of the trip is planned afresh from the next boarding point, which picks up
 * delays and closures since the journey was saved, and its arrival is compared with the plan.
 */
export async function checkJourney(tfl: TflClient, store: OwnerStore, journey: TrackedJourney, now: number, savedPlace?: SavedPlaceLookup) {
  const { route } = journey;
  const departure = Date.parse(route.departure);
  const arrival = Date.parse(route.arrival);
  const phase = now < departure ? 'not_started' : now < arrival ? 'travelling' : 'arrived';
  // The leg under way, by the clock: the last one whose departure time has passed.
  const current = phase === 'travelling' ? route.legs.reduce((found, leg, index) => (Date.parse(leg.departure) <= now ? index : found), -1) : -1;
  const next = phase === 'not_started' ? 0 : phase === 'travelling' ? current + 1 : route.legs.length;

  const used = new Set(route.legs.flatMap((leg) => leg.line_ids));
  const network = used.size ? await tfl.networkStatus().catch(() => []) : [];
  const line_status = network.filter((line) => used.has(line.id)).map(({ id, name, status, level, reason }) => ({ id, name, status, level, reason }));

  const tracking: Record<string, unknown> = {
    label: journey.label, phase, started_at: journey.started_at,
    position_basis: 'Assumed from the planned times: the server cannot see where the traveller is. If they say they are somewhere else, plan from there instead.',
    current_leg: current >= 0 ? current + 1 : null,
    planned_arrival: route.arrival,
  };

  const anchor = route.legs[next];
  let origin = phase === 'not_started' ? journey.from_value : anchor?.from_id;
  // They reach the next boarding point when the current leg ends, or are there already.
  let ready = Math.max(now, phase === 'not_started' ? departure : current >= 0 ? Date.parse(route.legs[current]!.arrival) : now);
  // The legs of the saved plan not yet begun. Part-way through a plan leg, the remainder starts where it ends.
  let remaining: LegSpec[] | undefined;
  if (journey.leg_plan && journey.leg_spec_index && anchor) {
    let first = journey.leg_spec_index[next]!;
    if (next > 0 && journey.leg_spec_index[next - 1] === first) {
      const lastOfSpec = journey.leg_spec_index.lastIndexOf(first);
      origin = route.legs[lastOfSpec]!.to_id ?? journey.leg_plan[first]!.to;
      ready = Math.max(now, Date.parse(route.legs[lastOfSpec]!.arrival));
      first += 1;
    }
    remaining = journey.leg_plan.slice(first);
  }

  if (phase === 'arrived') {
    Object.assign(tracking, { verdict: 'arrived', expected_arrival: route.arrival, arrival_change_minutes: 0, next_action: 'The planned arrival time has passed. Ask whether they have arrived, then end it (follow_journey with action "end"); it is dropped by itself two hours after the planned arrival.' });
  } else if (!anchor || !origin || remaining?.length === 0) {
    // On the last leg there is nothing left to choose; only that line's status can change the picture.
    Object.assign(tracking, { verdict: 'on_plan', expected_arrival: route.arrival, arrival_change_minutes: 0, note: 'On the final leg: no onward connection to check. line_status shows whether that line is disrupted.' });
  } else {
    try {
      // First the traveller's own route, leg by leg on the lines they chose; then what TfL would do from the same point.
      const own = remaining ? await buildLegs(tfl, origin, ready, remaining, savedPlace) : undefined;
      const free = await planJourney(tfl, {
        from: origin, to: journey.to_value, at: new Date(ready).toISOString(), time_is: 'departing',
        max_routes: 1, exclude_modes: journey.exclude_modes, preference: journey.preference,
      }, { savedPlace });
      const best = free.status === 'ok' && 'routes' in free ? free.routes[0] : undefined;
      const mine = own?.status === 'ok' ? own.route : !remaining ? best as TrackedRoute | undefined : undefined;
      const suggestion = (saves: number | null) => best && { from: anchor.from, leaves: best.departure, arrives: best.arrival, ...(saves === null ? {} : { saves_minutes: saves }), route: best };
      if (mine) {
        const change = Math.round((Date.parse(mine.arrival) - arrival) / 60_000);
        const saves = best ? Math.round((Date.parse(mine.arrival) - Date.parse(best.arrival)) / 60_000) : 0;
        const differs = best ? lineSequence(best as TrackedRoute) !== lineSequence(mine) : false;
        Object.assign(tracking, {
          verdict: Math.abs(change) <= ON_PLAN_MINUTES ? 'on_plan' : change > 0 ? 'later' : 'earlier',
          expected_arrival: mine.arrival, arrival_change_minutes: change,
          your_route: { from: anchor.from, leaves: mine.departure, route: mine },
          ...(differs && saves >= WORTH_SWITCHING_MINUTES ? { tfl_suggests: suggestion(saves), note: `Their own route still works, but from ${anchor.from} TfL now suggests different lines arriving ${saves} minutes sooner. Say so; the user decides whether to switch (change_journey).` } : {}),
        });
      } else if (own?.status === 'leg_failed') {
        Object.assign(tracking, {
          verdict: 'route_broken', expected_arrival: best?.arrival ?? null, arrival_change_minutes: best ? Math.round((Date.parse(best.arrival) - arrival) / 60_000) : null,
          broken_leg: { leg: own.spec, reason: own.reason, ...(own.tfl_offered ? { tfl_offered: own.tfl_offered } : {}) },
          ...(best ? { tfl_suggests: suggestion(null) } : {}),
          next_action: 'A leg of the saved route cannot be timed now, usually because that line is disrupted or has stopped for the day. Check line_status for it, tell the user, and offer the TfL suggestion or a changed leg (change_journey).',
        });
      } else {
        Object.assign(tracking, { verdict: 'unknown', expected_arrival: null, arrival_change_minutes: null, next_action: `TfL returned no onward route from ${anchor.from}. Check line_status, then plan_journey from there; do not assume the plan still holds.` });
      }
    } catch (error) {
      if (!(error instanceof TflError)) throw error;
      Object.assign(tracking, { verdict: 'unknown', expected_arrival: null, arrival_change_minutes: null, next_action: 'TfL could not plan the rest of the journey just now. Check again in a minute; meanwhile report line_status only.' });
    }
  }
  return {
    status: 'ok',
    query: { from: journey.from_name, to: journey.to_name, time_is: journey.time_is },
    resolved: { from: { input: journey.from_name, used: journey.from_value, name: journey.from_name }, to: { input: journey.to_name, used: journey.to_value, name: journey.to_name } },
    mode_filter: { excluded: journey.exclude_modes },
    tracking, routes: [route], ...(journey.leg_plan ? { leg_plan: journey.leg_plan.map((spec, index) => ({ leg: index + 1, ...spec })) } : {}), line_status,
    durable: store.durable,
  };
}
