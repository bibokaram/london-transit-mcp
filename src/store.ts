import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExcludableMode } from './journeys.js';

/** A place the owner has asked to be remembered, such as home or work, usable as from/to in journey planning. */
export type SavedPlace = { label: string; place: string; note?: string; saved_at: string };

/** Modes the owner prefers not to use. The planning tools apply it when a call does not say otherwise. */
export type TravelPreferences = { avoid_modes: ExcludableMode[]; note?: string; updated_at: string };

/** A journey being followed: the chosen route as planned, and enough of the request to plan the rest of it again. */
export type TrackedJourney = {
  label: string;
  started_at: string;
  /** After this the journey is over and is dropped. */
  expires_at: string;
  from_name: string;
  to_name: string;
  /** What the planner was sent for the destination, so the remainder can be planned again. */
  to_value: string;
  from_value: string;
  time_is: 'departing' | 'arriving';
  exclude_modes: ExcludableMode[];
  preference: 'fastest' | 'fewest_changes' | 'least_walking';
  route: TrackedRoute;
  /** The journey as legs ("to this place by this line"), and which of them each leg of route belongs to. */
  leg_plan?: { to: string; by: string }[];
  leg_spec_index?: number[];
};
export type TrackedLeg = {
  mode: string; from: string; to: string; from_id: string | null; to_id: string | null;
  duration_minutes: number; departure: string; arrival: string; instruction: string; lines: string[]; line_ids: string[];
};
export type TrackedRoute = {
  duration_minutes: number; departure: string; arrival: string; walking_minutes: number; changes: number;
  disrupted: boolean; disruptions: string[]; legs: TrackedLeg[];
};

export const MAX_PLACES = 20;
export const MAX_JOURNEYS = 5;
/** Labels are short lower-case words: "home", "work", "mum's" becomes invalid, "mums" is fine. */
export const LABEL = /^[a-z][a-z0-9 _-]{0,19}$/;
export const normaliseLabel = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * What the server remembers for its owner: saved places, travel preferences and journeys being followed. With a
 * directory it is kept in owner.json there and survives restarts, which on Railway needs a volume mounted at
 * that directory; without one it lives in memory until the process ends.
 */
export class OwnerStore {
  private places = new Map<string, SavedPlace>();
  private journeys = new Map<string, TrackedJourney>();
  private travel: TravelPreferences | undefined;
  /** The routes of the most recent plan, held as leg plans so one can be amended without planning again. Never written to disk. */
  private drafts: { expires: number; routes: TrackedJourney[] } | undefined;
  private file: string | undefined;

  constructor(directory?: string) {
    if (!directory) return;
    this.file = join(directory, 'owner.json');
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as { places?: SavedPlace[]; preferences?: TravelPreferences; journeys?: TrackedJourney[] };
      for (const item of stored.places ?? []) {
        if (typeof item?.label === 'string' && typeof item.place === 'string' && LABEL.test(item.label)) this.places.set(item.label, item);
      }
      if (Array.isArray(stored.preferences?.avoid_modes)) this.travel = stored.preferences;
      for (const item of stored.journeys ?? []) {
        if (typeof item?.label === 'string' && Array.isArray(item.route?.legs)) this.journeys.set(item.label, item);
      }
    } catch {
      // No file yet, or one that cannot be read: start empty and write a fresh one on the first save.
    }
  }

  /** Whether saved places survive a restart. */
  get durable() {
    return Boolean(this.file);
  }

  list(): SavedPlace[] {
    return [...this.places.values()];
  }

  get(label: string): SavedPlace | undefined {
    return this.places.get(normaliseLabel(label));
  }

  /** Saves or replaces a place. Returns what it replaced, or 'full' when the list is at its limit. */
  save(label: string, place: string, note: string | undefined, now: number): { saved: SavedPlace; replaced?: SavedPlace } | 'full' {
    const key = normaliseLabel(label);
    const replaced = this.places.get(key);
    if (!replaced && this.places.size >= MAX_PLACES) return 'full';
    const saved = { label: key, place, ...(note ? { note } : {}), saved_at: new Date(now).toISOString() };
    this.places.set(key, saved);
    this.persist();
    return { saved, ...(replaced ? { replaced } : {}) };
  }

  forget(label: string): SavedPlace | undefined {
    const key = normaliseLabel(label);
    const removed = this.places.get(key);
    if (removed) {
      this.places.delete(key);
      this.persist();
    }
    return removed;
  }

  /** Keeps the routes of a plan for an hour, replacing the previous plan's. */
  setDraft(routes: TrackedJourney[], now: number) {
    this.drafts = { expires: now + 60 * 60 * 1000, routes };
  }

  draft(route: number, now: number): TrackedJourney | undefined {
    return this.drafts && this.drafts.expires > now ? this.drafts.routes[route - 1] : undefined;
  }

  draftCount(now: number) {
    return this.drafts && this.drafts.expires > now ? this.drafts.routes.length : 0;
  }

  preferences(): TravelPreferences | undefined {
    return this.travel;
  }

  setPreferences(avoid: ExcludableMode[], note: string | undefined, now: number) {
    const previous = this.travel;
    this.travel = { avoid_modes: avoid, ...(note ? { note } : {}), updated_at: new Date(now).toISOString() };
    this.persist();
    return { saved: this.travel, ...(previous ? { previous } : {}) };
  }

  /** Journeys still being followed; ones past their expiry are dropped first. */
  trackedJourneys(now: number): TrackedJourney[] {
    let dropped = false;
    for (const [label, journey] of this.journeys) {
      if (Date.parse(journey.expires_at) <= now) {
        this.journeys.delete(label);
        dropped = true;
      }
    }
    if (dropped) this.persist();
    return [...this.journeys.values()];
  }

  journey(label: string, now: number): TrackedJourney | undefined {
    return this.trackedJourneys(now).find((item) => item.label === normaliseLabel(label));
  }

  track(journey: TrackedJourney, now: number): { replaced?: TrackedJourney } | 'full' {
    const current = this.trackedJourneys(now);
    const replaced = this.journeys.get(journey.label);
    if (!replaced && current.length >= MAX_JOURNEYS) return 'full';
    this.journeys.set(journey.label, journey);
    this.persist();
    return replaced ? { replaced } : {};
  }

  endJourney(label: string): TrackedJourney | undefined {
    const key = normaliseLabel(label);
    const removed = this.journeys.get(key);
    if (removed) {
      this.journeys.delete(key);
      this.persist();
    }
    return removed;
  }

  private persist() {
    if (!this.file) return;
    // Written beside the file and renamed over it, so a crash mid-write never leaves half a file.
    const temporary = `${this.file}.tmp`;
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ places: this.list(), preferences: this.travel, journeys: [...this.journeys.values()] }, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
