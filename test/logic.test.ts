import { describe, expect, it } from 'vitest';
import {
  addStation, canAddStation, formatTimes, parseSettings, removeStation, setLineShown, shownLines, updatedLabel,
} from '../public/logic.js';

describe('formatTimes', () => {
  it.each([
    [[3, 7, 12], '3, 7, 12 min'],
    [[0, 4], 'Due, 4 min'],
    [[0], 'Due'],
    [[0, 0, 6], 'Due, Due, 6 min'],
    [[1, 2, 3, 4, 5], '1, 2, 3 min'],
    [[], 'No trains'],
  ])('%j -> %s', (minutes, want) => {
    expect(formatTimes(minutes)).toBe(want);
  });
});

describe('updatedLabel', () => {
  it.each([
    [0, 'Updated just now'],
    [4_000, 'Updated just now'],
    [12_400, 'Updated 12s ago'],
    [59_000, 'Updated 59s ago'],
    [125_000, 'Updated 2m ago'],
  ])('%i ms -> %s', (elapsed, want) => {
    expect(updatedLabel(elapsed)).toBe(want);
  });
});

describe('parseSettings', () => {
  const empty = { stations: [] };
  const wembley = { id: '940GZZLUWYP', name: 'Wembley Park', hidden: [] };

  it('restores saved stations in order, each with its hidden lines', () => {
    const aldgate = { id: '940GZZLUALD', name: 'Aldgate', hidden: ['circle'] };
    expect(parseSettings(JSON.stringify({ stations: [wembley, aldgate] }))).toEqual({ stations: [wembley, aldgate] });
  });

  it('turns the old single home station into the first saved station, hiding the lines that were not chosen', () => {
    const old = { stop: { id: '940GZZLUWYP', name: 'Wembley Park' }, lines: ['metropolitan', 'jubilee'] };
    const { stations } = parseSettings(JSON.stringify(old));
    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({ id: '940GZZLUWYP', name: 'Wembley Park' });
    expect(stations[0]!.hidden).not.toContain('metropolitan');
    expect(stations[0]!.hidden).not.toContain('jubilee');
    expect(stations[0]!.hidden).toContain('circle');
  });

  it('shows every line at an old home station that had no lines chosen', () => {
    const old = { stop: { id: '940GZZLUWYP', name: 'Wembley Park' }, lines: [] };
    expect(parseSettings(JSON.stringify(old))).toEqual({ stations: [wembley] });
  });

  it('drops broken stations, duplicates, unknown hidden lines, and anything past five', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `S${i}`, name: `Stop ${i}`, hidden: [] }));
    const raw = { stations: [{ id: 7 }, { ...wembley, hidden: ['nope', 'circle'] }, wembley, ...many] };
    const { stations } = parseSettings(JSON.stringify(raw));
    expect(stations.map((s: any) => s.id)).toEqual(['940GZZLUWYP', 'S0', 'S1', 'S2', 'S3']);
    expect(stations[0]!.hidden).toEqual(['circle']);
  });

  it.each([[null], ['not json'], ['null'], ['[]'], ['{"stations":"x"}'], ['{"lines":["victoria"],"stop":null}']])(
    'falls back to no stations for %j',
    (raw) => {
      expect(parseSettings(raw)).toEqual(empty);
    },
  );
});

describe('saved stations', () => {
  const settings = { stations: [{ id: 'A', name: 'Aldgate', hidden: [] }] };

  it('adds a station to the end, once', () => {
    const added = addStation(settings, { id: 'B', name: 'Bank' });
    expect(added.stations.map((s: any) => s.id)).toEqual(['A', 'B']);
    expect(addStation(added, { id: 'A', name: 'Aldgate' })).toBe(added);
  });

  it('stops adding at five', () => {
    let full = { stations: [] as any[] };
    for (const id of ['1', '2', '3', '4', '5']) full = addStation(full, { id, name: id });
    expect(canAddStation(full)).toBe(false);
    expect(addStation(full, { id: '6', name: '6' })).toBe(full);
    expect(canAddStation(settings)).toBe(true);
  });

  it('removes a station', () => {
    expect(removeStation(settings, 'A')).toEqual({ stations: [] });
  });

  it('hides and shows a line at one station only', () => {
    const two = addStation(settings, { id: 'B', name: 'Bank' });
    const hidden = setLineShown(two, 'A', 'circle', false);
    expect(hidden.stations[0].hidden).toEqual(['circle']);
    expect(hidden.stations[1].hidden).toEqual([]);
    expect(setLineShown(hidden, 'A', 'circle', true).stations[0].hidden).toEqual([]);
  });

  it('lists the lines to show at a station, in network order', () => {
    const station = { id: 'A', name: 'Aldgate', hidden: ['circle'] };
    expect(shownLines(station, ['metropolitan', 'circle', 'hammersmith-city'])).toEqual(['hammersmith-city', 'metropolitan']);
  });
});

import { addRecent, cleanLocation, clockTime, destinationsOf, groupBoard, parseRecents, parseRoute, parseStoredLines, routeHash, storeLines } from '../public/logic.js';

const train = (over: Record<string, unknown>) => ({
  line: 'metropolitan', lineName: 'Metropolitan', bound: 'Northbound', platform: 'Platform 2',
  destination: 'Uxbridge', minutes: 3, expected: '2026-11-06T10:04:00Z', location: null, ...over,
});

describe('groupBoard', () => {
  it('groups by line in network order, then by direction', () => {
    const board = groupBoard([
      train({ minutes: 1, line: 'jubilee', lineName: 'Jubilee', bound: 'Southbound' }),
      train({ minutes: 2, bound: 'Southbound', destination: 'Aldgate' }),
      train({ minutes: 3 }),
      train({ minutes: 4, line: 'jubilee', lineName: 'Jubilee', bound: 'Northbound' }),
      train({ minutes: 5, destination: 'Chesham' }),
    ]);
    expect(board.map((l: any) => [l.line, l.directions.map((d: any) => [d.label, d.arrivals.map((a: any) => a.minutes)])])).toEqual([
      ['jubilee', [['Northbound', [4]], ['Southbound', [1]]]],
      ['metropolitan', [['Northbound', [3, 5]], ['Southbound', [2]]]],
    ]);
  });

  it('orders compass directions north, south, east, west', () => {
    const board = groupBoard([
      train({ bound: 'Westbound' }), train({ bound: 'Eastbound' }), train({ bound: 'Southbound' }), train({ bound: 'Northbound' }),
    ]);
    expect(board[0]!.directions.map((d: any) => d.label)).toEqual(['Northbound', 'Southbound', 'Eastbound', 'Westbound']);
  });

  it('groups trains with no direction by platform, after the compass directions', () => {
    const board = groupBoard([train({ bound: null, platform: 'Platform 1' }), train({ bound: 'Southbound' })]);
    expect(board[0]!.directions.map((d: any) => d.label)).toEqual(['Southbound', 'Platform 1']);
  });

  it('labels a train with neither direction nor platform as Other', () => {
    expect(groupBoard([train({ bound: null, platform: '' })])[0]!.directions[0].label).toBe('Other');
  });
});

describe('destinationsOf', () => {
  it('lists the distinct destinations of the next three trains', () => {
    const trains = ['Chesham', 'Uxbridge', 'Chesham', 'Watford'].map((destination) => train({ destination }));
    expect(destinationsOf(trains)).toBe('Chesham · Uxbridge');
  });
});

describe('clockTime', () => {
  it.each([
    ['2026-11-06T10:09:10Z', '10:09'],
    ['2026-07-01T09:09:00Z', '10:09'],
    ['2026-11-06T23:59:59Z', '23:59'],
    ['not a date', ''],
  ])('%s -> %s in London time', (iso, want) => {
    expect(clockTime(iso)).toBe(want);
  });
});

describe('recent stations', () => {
  const a = { id: 'A', name: 'Alpha' };
  const b = { id: 'B', name: 'Bravo' };

  it('puts the newest first and moves a repeat to the front', () => {
    expect(addRecent([a, b], b)).toEqual([b, a]);
  });

  it('keeps five at most', () => {
    const many = ['1', '2', '3', '4', '5'].map((id) => ({ id, name: id }));
    expect(addRecent(many, a).map((s: any) => s.id)).toEqual(['A', '1', '2', '3', '4']);
  });

  it.each([[null], ['nope'], ['{}'], ['[{"id":1}]']])('reads %j as no recents', (raw) => {
    expect(parseRecents(raw)).toEqual([]);
  });

  it('reads back what was saved, dropping malformed entries', () => {
    expect(parseRecents(JSON.stringify([a, { id: 7 }, b]))).toEqual([a, b]);
  });
});

describe('stored station lines', () => {
  it.each([[null], ['nope'], ['[]'], ['{"A":{"lines":"x","saved":1}}'], ['{"A":{"lines":[]}}']])(
    'reads %j as nothing stored',
    (raw) => {
      expect(parseStoredLines(raw)).toEqual({});
    },
  );

  it('reads back what was stored, dropping unknown lines', () => {
    const raw = JSON.stringify({ A: { lines: ['victoria', 'nope'], saved: 5 } });
    expect(parseStoredLines(raw)).toEqual({ A: { lines: ['victoria'], saved: 5 } });
  });

  it('replaces a station and keeps the 20 most recently fetched', () => {
    let stored: Record<string, any> = {};
    for (let i = 0; i < 25; i++) stored = storeLines(stored, `S${i}`, ['central'], i);
    stored = storeLines(stored, 'S10', ['victoria'], 100);
    const ids = Object.keys(stored);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('S10');
    expect(stored.S10).toEqual({ lines: ['victoria'], saved: 100 });
    expect(ids).not.toContain('S4');
    expect(ids).toContain('S5');
  });
});

describe('routes', () => {
  it.each([
    ['', { view: 'home' }],
    ['#/', { view: 'home' }],
    ['#/settings', { view: 'settings' }],
    ['#/explore', { view: 'explore' }],
    ['#/station?stop=HUBKGX&name=King%27s%20Cross', { view: 'station', stop: 'HUBKGX', name: "King's Cross" }],
    ['#/line?stop=940GZZLUWYP&name=Wembley%20Park&line=metropolitan&bound=Southbound',
      { view: 'line', stop: '940GZZLUWYP', name: 'Wembley Park', line: 'metropolitan', bound: 'Southbound' }],
    ['#/line?stop=940GZZLUWYP&name=Wembley%20Park&line=metropolitan',
      { view: 'line', stop: '940GZZLUWYP', name: 'Wembley Park', line: 'metropolitan', bound: null }],
    ['#/station', { view: 'home' }],
    ['#/nonsense', { view: 'home' }],
  ])('parses %j', (hash, want) => {
    expect(parseRoute(hash)).toEqual(want);
  });

  it('round-trips a route through its hash', () => {
    const route = { view: 'line', stop: 'HUBKGX', name: "King's Cross & St Pancras", line: 'victoria', bound: 'Northbound' };
    expect(parseRoute(routeHash(route))).toEqual(route);
  });
});

describe('cleanLocation', () => {
  it.each([
    ['At Platform', null],
    ['At Ruislip Manor Platform 2', 'At Ruislip Manor'],
    ['At Kilburn Platform 1', 'At Kilburn'],
    ['Between Pinner and North Harrow', 'Between Pinner and North Harrow'],
    ['Harrow on the Hill Siding', 'Harrow on the Hill Siding'],
    [null, null],
  ])('%j -> %j', (location, want) => {
    expect(cleanLocation(location)).toBe(want);
  });
});
