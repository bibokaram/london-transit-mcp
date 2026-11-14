import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeTfl, lineWith, prediction } from './helpers.js';

const STATUS_PATH = '/Line/northern,victoria/Status';
const good = { statusSeverity: 10, statusSeverityDescription: 'Good Service' };

function setup(routes: Parameters<typeof fakeTfl>[0], appKey?: string) {
  const tfl = fakeTfl(routes);
  let time = 1_000_000;
  const app = createApp({ fetch: tfl.fetch, appKey, now: () => time });
  return {
    tfl,
    get: (path: string) => app.request(path),
    json: async (path: string) => (await app.request(path)).json() as Promise<any>,
    advance: (ms: number) => { time += ms; },
  };
}

describe('GET /api/status', () => {
  it('simplifies TfL lines to id, name, status, level and reason', async () => {
    const { json } = setup({
      [STATUS_PATH]: {
        body: [
          lineWith('northern', 'Northern', good),
          lineWith('victoria', 'Victoria', {
            statusSeverity: 9,
            statusSeverityDescription: 'Minor Delays',
            reason: 'Victoria Line: minor delays due to a signal failure.',
          }),
        ],
      },
    });
    expect(await json('/api/status?lines=victoria,northern')).toEqual({
      lines: [
        { id: 'northern', name: 'Northern', status: 'Good Service', level: 'good', reason: null },
        {
          id: 'victoria',
          name: 'Victoria',
          status: 'Minor Delays',
          level: 'minor',
          reason: 'Victoria Line: minor delays due to a signal failure.',
        },
      ],
    });
  });

  it.each([
    [10, 'Good Service', 'good'],
    [18, 'No Issues', 'good'],
    [9, 'Minor Delays', 'minor'],
    [7, 'Reduced Service', 'minor'],
    [6, 'Severe Delays', 'severe'],
    [3, 'Part Suspended', 'severe'],
    [2, 'Suspended', 'severe'],
    [20, 'Service Closed', 'severe'],
  ])('classifies severity %i (%s) as %s', async (statusSeverity, statusSeverityDescription, level) => {
    const { json } = setup({
      '/Line/victoria/Status': {
        body: [lineWith('victoria', 'Victoria', { statusSeverity, statusSeverityDescription })],
      },
    });
    const { lines } = await json('/api/status?lines=victoria');
    expect(lines[0].level).toBe(level);
  });

  it('reports the worst status when a line has several', async () => {
    const { json } = setup({
      '/Line/district/Status': {
        body: [
          lineWith(
            'district',
            'District',
            { statusSeverity: 9, statusSeverityDescription: 'Minor Delays', reason: 'Minor reason' },
            { statusSeverity: 3, statusSeverityDescription: 'Part Suspended', reason: 'Part reason' },
          ),
        ],
      },
    });
    const { lines } = await json('/api/status?lines=district');
    expect(lines[0]).toMatchObject({ status: 'Part Suspended', level: 'severe', reason: 'Part reason' });
  });

  it.each(['/api/status', '/api/status?lines=', '/api/status?lines=victoria,../../secret', '/api/status?lines=elizabeth'])(
    'rejects %s without calling TfL',
    async (path) => {
      const { get, tfl } = setup({});
      expect((await get(path)).status).toBe(400);
      expect(tfl.calls).toHaveLength(0);
    },
  );
});

describe('TfL key handling', () => {
  const routes = { [STATUS_PATH]: { body: [lineWith('victoria', 'Victoria', good)] } };

  it('sends the key to TfL', async () => {
    const { get, tfl } = setup(routes, 'sekret-key');
    await get('/api/status?lines=victoria,northern');
    expect(tfl.calls[0]?.searchParams.get('app_key')).toBe('sekret-key');
  });

  it('omits app_key when no key is configured', async () => {
    const { get, tfl } = setup(routes);
    await get('/api/status?lines=victoria,northern');
    expect(tfl.calls[0]?.searchParams.has('app_key')).toBe(false);
  });

  it('never returns the key on success or upstream failure', async () => {
    const ok = setup(routes, 'sekret-key');
    expect(await (await ok.get('/api/status?lines=victoria,northern')).text()).not.toContain('sekret-key');

    const failing = setup({ [STATUS_PATH]: { status: 500, body: { message: 'boom' } } }, 'sekret-key');
    const res = await failing.get('/api/status?lines=victoria,northern');
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sekret-key');
  });

  it('does not leak the key when the network call itself throws', async () => {
    const app = createApp({
      fetch: (async (input: RequestInfo | URL) => {
        throw new Error(`connect failed for ${String(input)}`);
      }) as typeof fetch,
      appKey: 'sekret-key',
    });
    const res = await app.request('/api/status?lines=victoria');
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('sekret-key');
  });
});

describe('30 second cache', () => {
  const routes = { [STATUS_PATH]: { body: [lineWith('victoria', 'Victoria', good)] } };

  it('serves repeat requests from cache inside 30s and refetches after', async () => {
    const { get, tfl, advance } = setup(routes);
    await get('/api/status?lines=victoria,northern');
    advance(29_000);
    await get('/api/status?lines=victoria,northern');
    expect(tfl.calls).toHaveLength(1);
    advance(2_000);
    await get('/api/status?lines=victoria,northern');
    expect(tfl.calls).toHaveLength(2);
  });

  it('treats the same lines in a different order as one cache entry', async () => {
    const { get, tfl } = setup(routes);
    await get('/api/status?lines=victoria,northern');
    await get('/api/status?lines=northern,victoria');
    expect(tfl.calls).toHaveLength(1);
  });

  it('shares one TfL call between concurrent requests', async () => {
    const { get, tfl } = setup(routes);
    await Promise.all([get('/api/status?lines=victoria,northern'), get('/api/status?lines=victoria,northern')]);
    expect(tfl.calls).toHaveLength(1);
  });

  it('does not cache failures', async () => {
    let healthy = false;
    const { get } = setup({
      [STATUS_PATH]: () => (healthy ? routes[STATUS_PATH] : { status: 500 }),
    });
    expect((await get('/api/status?lines=victoria,northern')).status).toBe(502);
    healthy = true;
    expect((await get('/api/status?lines=victoria,northern')).status).toBe(200);
  });
});

describe('GET /api/arrivals', () => {
  const STOP = '/StopPoint/940GZZLUOXC/Arrivals';

  it('returns every train soonest first, with bound and platform split out', async () => {
    const { json } = setup({
      [STOP]: {
        body: [
          prediction({ timeToStation: 430, expectedArrival: '2026-11-06T10:09:10Z', currentLocation: 'At Warren Street' }),
          prediction({
            timeToStation: 20,
            platformName: 'Southbound - Platform 6',
            destinationName: 'Brixton Underground Station',
            expectedArrival: '2026-11-06T10:02:20Z',
            currentLocation: 'At Platform',
          }),
        ],
      },
    });
    expect(await json('/api/arrivals?stop=940GZZLUOXC')).toEqual({
      arrivals: [
        {
          line: 'victoria',
          lineName: 'Victoria',
          bound: 'Southbound',
          platform: 'Platform 6',
          destination: 'Brixton',
          minutes: 0,
          expected: '2026-11-06T10:02:20Z',
          location: 'At Platform',
        },
        {
          line: 'victoria',
          lineName: 'Victoria',
          bound: 'Northbound',
          platform: 'Platform 5',
          destination: 'Walthamstow Central',
          minutes: 7,
          expected: '2026-11-06T10:09:10Z',
          location: 'At Warren Street',
        },
      ],
    });
  });

  it.each([
    ['Eastbound - Platform 6', 'Eastbound', 'Platform 6'],
    ['Eastbound Platform 25', 'Eastbound', 'Platform 25'],
    ['Westbound - Platform 1', 'Westbound', 'Platform 1'],
    ['Platform 1', null, 'Platform 1'],
    ['', null, ''],
  ])('splits platform name %j into bound %j and platform %j', async (platformName, bound, platform) => {
    const { json } = setup({ [STOP]: { body: [prediction({ platformName })] } });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUOXC');
    expect(arrivals[0]).toMatchObject({ bound, platform });
  });

  it.each([
    ['Edgware Road (Circle Line) Underground Station', 'Edgware Road'],
    ['Hammersmith (H&C Line) Underground Station', 'Hammersmith'],
    ['Paddington (H&C Line)-Underground', 'Paddington'],
    ['Heathrow Terminal 5 Underground Station', 'Heathrow Terminal 5'],
  ])('tidies destination %j to %j', async (destinationName, destination) => {
    const { json } = setup({ [STOP]: { body: [prediction({ destinationName })] } });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUOXC');
    expect(arrivals[0].destination).toBe(destination);
  });

  it('falls back to towards when a prediction has no destination, and to null when it has no location', async () => {
    const { json } = setup({
      [STOP]: { body: [prediction({ destinationName: undefined, towards: 'Check Front of Train', currentLocation: '' })] },
    });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUOXC');
    expect(arrivals[0]).toMatchObject({ destination: 'Check Front of Train', location: null });
  });

  it('drops trains that end their journey at this station, since nobody can board them', async () => {
    const { json } = setup({
      [STOP]: {
        body: [
          prediction({ destinationNaptanId: '940GZZLUOXC', destinationName: 'Oxford Circus Underground Station' }),
          prediction({ destinationNaptanId: '940GZZLUWWL', timeToStation: 200 }),
        ],
      },
    });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUOXC');
    expect(arrivals.map((a: any) => a.destination)).toEqual(['Walthamstow Central']);
  });

  it('keeps terminating trains at the end of the line, where they turn round and form the departures', async () => {
    const BRIXTON = '/StopPoint/940GZZLUBXN/Arrivals';
    const terminating = (timeToStation: number) =>
      prediction({ platformName: 'Northbound - Platform 1', destinationNaptanId: '940GZZLUBXN',
        destinationName: 'Brixton Underground Station', timeToStation });
    const { json } = setup({
      [BRIXTON]: { body: [terminating(120), terminating(300), prediction({ platformName: 'Northbound - Platform 2', timeToStation: 30 })] },
    });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUBXN');
    expect(arrivals.map((a: any) => [a.minutes, a.destination])).toEqual([
      [1, 'Walthamstow Central'],
      [2, 'Check Front of Train'],
      [5, 'Check Front of Train'],
    ]);
  });

  it('shows a terminating train once, though TfL lists it on every platform it might use', async () => {
    const BRIXTON = '/StopPoint/940GZZLUBXN/Arrivals';
    const terminating = (vehicleId: string, platformName: string, timeToStation: number) =>
      prediction({ vehicleId, platformName, destinationNaptanId: '940GZZLUBXN',
        destinationName: 'Brixton Underground Station', timeToStation });
    const { json } = setup({
      [BRIXTON]: {
        body: [
          terminating('201', 'Northbound - Platform 1', 120),
          terminating('201', 'Northbound - Platform 2', 120),
          terminating('202', 'Northbound - Platform 1', 300),
          terminating('202', 'Northbound - Platform 2', 300),
          terminating('203', 'Northbound - Platform 2', 500),
        ],
      },
    });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUBXN');
    // Which platform the first two use isn't known yet, so they show none.
    expect(arrivals.map((a: any) => [a.minutes, a.bound, a.platform])).toEqual([
      [2, 'Northbound', ''],
      [5, 'Northbound', ''],
      [8, 'Northbound', 'Platform 2'],
    ]);
  });

  it.each([
    ['940GZZLUBNK', 'Bank', 'Westbound', 'Waterloo'],
    ['940GZZLUWLO', 'Waterloo', 'Eastbound', 'Bank'],
  ])('shows a Waterloo & City train at %s (%s) once, heading %s to %s', async (stopId, name, bound, destination) => {
    const { json } = setup({
      [`/StopPoint/${stopId}/Arrivals`]: {
        body: [
          // TfL's labels at the ends of this two-stop line follow the arriving train, and at Bank cover both platforms.
          ...['Westbound - Platform 7', 'Eastbound - Platform 8'].map((platformName) =>
            prediction({ lineId: 'waterloo-city', lineName: 'Waterloo & City', vehicleId: '201', platformName,
              destinationNaptanId: stopId, destinationName: `${name} Underground Station`, timeToStation: 126 })),
        ],
      },
    });
    const { arrivals } = await json(`/api/arrivals?stop=${stopId}`);
    expect(arrivals.map((a: any) => [a.minutes, a.bound, a.destination])).toEqual([[2, bound, destination]]);
  });

  it('decides end-of-line per line and direction, not for the whole station', async () => {
    const { json } = setup({
      [STOP]: {
        body: [
          // Victoria northbound: mostly through trains, so the one ending here is a short trip to drop.
          prediction({ timeToStation: 60 }),
          prediction({ timeToStation: 120 }),
          prediction({ timeToStation: 180, destinationNaptanId: '940GZZLUOXC' }),
          // Central eastbound: every train ends here, so they are the departures.
          prediction({ lineId: 'central', lineName: 'Central', platformName: 'Eastbound - Platform 1',
            destinationNaptanId: '940GZZLUOXC', timeToStation: 240 }),
        ],
      },
    });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUOXC');
    expect(arrivals.map((a: any) => [a.line, a.minutes])).toEqual([['victoria', 1], ['victoria', 2], ['central', 4]]);
  });

  it('drops trains ending at any station inside a hub', async () => {
    const { json } = setup({
      '/StopPoint/HUBPAD': { body: { id: 'HUBPAD', children: [{ id: '940GZZLUPAC', modes: ['tube'] }, { id: '940GZZLUPAH', modes: ['tube'] }] } },
      '/StopPoint/940GZZLUPAC/Arrivals': { body: [prediction({ destinationNaptanId: '940GZZLUPAH' })] },
      '/StopPoint/940GZZLUPAH/Arrivals': { body: [prediction({ destinationNaptanId: '940GZZLUWWL' })] },
    });
    const { arrivals } = await json('/api/arrivals?stop=HUBPAD');
    expect(arrivals).toHaveLength(1);
  });

  it('drops trains on lines that do not serve the station, as TfL sometimes mislabels them', async () => {
    const { json } = setup({
      '/StopPoint/940GZZLUWYP': {
        body: { id: '940GZZLUWYP', commonName: 'Wembley Park', lines: [{ id: 'jubilee', name: 'Jubilee' }, { id: 'metropolitan', name: 'Metropolitan' }] },
      },
      '/StopPoint/940GZZLUWYP/Arrivals': {
        body: [
          prediction({ lineId: 'metropolitan', lineName: 'Metropolitan' }),
          prediction({ lineId: 'hammersmith-city', lineName: 'Hammersmith & City', timeToStation: 900 }),
        ],
      },
    });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUWYP');
    expect(arrivals.map((a: any) => a.line)).toEqual(['metropolitan']);
  });

  it('keeps every train when the station lookup fails, rather than failing the board', async () => {
    const { get } = setup({
      '/StopPoint/940GZZLUWYP': { status: 500 },
      '/StopPoint/940GZZLUWYP/Arrivals': { body: [prediction({ lineId: 'hammersmith-city' })] },
    });
    const res = await get('/api/arrivals?stop=940GZZLUWYP');
    expect(res.status).toBe(200);
    expect((await res.json() as any).arrivals).toHaveLength(1);
  });

  it('looks up which lines serve a station once a day, not on every refresh', async () => {
    const { get, tfl, advance } = setup({
      '/StopPoint/940GZZLUWYP': { body: { id: '940GZZLUWYP', lines: [{ id: 'metropolitan', name: 'Metropolitan' }] } },
      '/StopPoint/940GZZLUWYP/Arrivals': { body: [] },
    });
    await get('/api/arrivals?stop=940GZZLUWYP');
    advance(31_000);
    await get('/api/arrivals?stop=940GZZLUWYP');
    expect(tfl.calls.filter((u) => u.pathname === '/StopPoint/940GZZLUWYP')).toHaveLength(1);
  });

  it('filters to one line when asked', async () => {
    const { json } = setup({
      [STOP]: { body: [prediction({}), prediction({ lineId: 'central', lineName: 'Central' })] },
    });
    const { arrivals } = await json('/api/arrivals?stop=940GZZLUOXC&line=central');
    expect(arrivals.map((a: any) => a.line)).toEqual(['central']);
  });

  it('resolves a hub to its tube stations and merges their arrivals', async () => {
    const { json, tfl } = setup({
      '/StopPoint/HUBPAD': {
        body: {
          id: 'HUBPAD',
          children: [
            { id: '490G00011111', modes: ['bus'] },
            { id: '940GZZLUPAC', modes: ['tube'] },
            { id: '940GZZLUPAH', modes: ['tube'] },
          ],
        },
      },
      '/StopPoint/940GZZLUPAC/Arrivals': { body: [prediction({ platformName: 'Platform A', timeToStation: 120 })] },
      '/StopPoint/940GZZLUPAH/Arrivals': { body: [prediction({ platformName: 'Platform B', timeToStation: 60 })] },
    });
    const { arrivals } = await json('/api/arrivals?stop=HUBPAD');
    expect(arrivals.map((a: any) => a.platform)).toEqual(['Platform B', 'Platform A']);
    expect(tfl.calls.map((u) => u.pathname)).not.toContain('/StopPoint/490G00011111/Arrivals');
  });

  it('remembers a hub lookup across arrivals refreshes', async () => {
    const { get, tfl, advance } = setup({
      '/StopPoint/HUBPAD': { body: { id: 'HUBPAD', children: [{ id: '940GZZLUPAC', modes: ['tube'] }] } },
      '/StopPoint/940GZZLUPAC/Arrivals': { body: [] },
    });
    await get('/api/arrivals?stop=HUBPAD');
    advance(31_000);
    await get('/api/arrivals?stop=HUBPAD');
    expect(tfl.calls.filter((u) => u.pathname === '/StopPoint/HUBPAD')).toHaveLength(1);
    expect(tfl.calls.filter((u) => u.pathname === '/StopPoint/940GZZLUPAC/Arrivals')).toHaveLength(2);
  });

  it('serves a line-filtered request from the same cached station data', async () => {
    const { get, tfl } = setup({ [STOP]: { body: [prediction({})] } });
    await get('/api/arrivals?stop=940GZZLUOXC');
    await get('/api/arrivals?stop=940GZZLUOXC&line=victoria');
    expect(tfl.calls.filter((u) => u.pathname === STOP)).toHaveLength(1);
  });

  it.each(['/api/arrivals', '/api/arrivals?stop=', '/api/arrivals?stop=../Line/victoria', '/api/arrivals?stop=940GZZLUOXC&line=../x'])(
    'rejects %s without calling TfL',
    async (path) => {
      const { get, tfl } = setup({});
      expect((await get(path)).status).toBe(400);
      expect(tfl.calls).toHaveLength(0);
    },
  );

  it('returns 404 for a stop TfL does not know', async () => {
    const { get } = setup({});
    expect((await get('/api/arrivals?stop=NOPE')).status).toBe(404);
  });
});

describe('GET /api/search', () => {
  it('searches tube and bus and returns simplified matches with clean names', async () => {
    const { json, tfl } = setup({
      "/StopPoint/Search/king's%20cross": {
        body: {
          matches: [
            { id: 'HUBKGX', name: "King's Cross & St Pancras International", modes: ['bus', 'tube'], lat: 1, lon: 2 },
            { id: '940GZZLUEMB', name: 'Embankment Underground Station', modes: ['tube'], towards: undefined },
          ],
        },
      },
    });
    expect(await json("/api/search?q=king's%20cross")).toEqual({
      stops: [
        { id: 'HUBKGX', name: "King's Cross & St Pancras International", modes: ['bus', 'tube'] },
        { id: '940GZZLUEMB', name: 'Embankment', modes: ['tube'] },
      ],
    });
    expect(tfl.calls[0]?.searchParams.get('modes')).toBe('tube,bus');
  });

  it('cannot escape the search path with a crafted query', async () => {
    const { get, tfl } = setup({});
    await get('/api/search?q=' + encodeURIComponent('../../Line/victoria/Status'));
    expect(tfl.calls[0]?.pathname.startsWith('/StopPoint/Search/')).toBe(true);
    expect(tfl.calls[0]?.pathname).not.toContain('/Line/');
  });

  it.each(['/api/search', '/api/search?q=', '/api/search?q=%20%20', `/api/search?q=${'x'.repeat(101)}`])(
    'rejects %s without calling TfL',
    async (path) => {
      const { get, tfl } = setup({});
      expect((await get(path)).status).toBe(400);
      expect(tfl.calls).toHaveLength(0);
    },
  );
});

describe('GET /api/station', () => {
  it('returns the station name and its tube lines in network order', async () => {
    const { json } = setup({
      '/StopPoint/HUBKGX': {
        body: {
          id: 'HUBKGX',
          commonName: "King's Cross & St Pancras International",
          lines: [
            { id: '17', name: '17' },
            { id: 'victoria', name: 'Victoria' },
            { id: 'great-northern', name: 'Great Northern' },
            { id: 'circle', name: 'Circle' },
            { id: 'northern', name: 'Northern' },
          ],
        },
      },
    });
    expect(await json('/api/station?stop=HUBKGX')).toEqual({
      id: 'HUBKGX',
      name: "King's Cross & St Pancras International",
      lines: [
        { id: 'circle', name: 'Circle' },
        { id: 'northern', name: 'Northern' },
        { id: 'victoria', name: 'Victoria' },
      ],
    });
  });

  it('cleans the station name', async () => {
    const { json } = setup({
      '/StopPoint/940GZZLUWYP': { body: { id: '940GZZLUWYP', commonName: 'Wembley Park Underground Station', lines: [] } },
    });
    expect((await json('/api/station?stop=940GZZLUWYP')).name).toBe('Wembley Park');
  });

  it('caches a station for longer than live data', async () => {
    const { get, tfl, advance } = setup({
      '/StopPoint/940GZZLUWYP': { body: { id: '940GZZLUWYP', commonName: 'Wembley Park', lines: [] } },
    });
    await get('/api/station?stop=940GZZLUWYP');
    advance(60 * 60 * 1000);
    await get('/api/station?stop=940GZZLUWYP');
    expect(tfl.calls).toHaveLength(1);
  });

  it.each(['/api/station', '/api/station?stop=../x'])('rejects %s without calling TfL', async (path) => {
    const { get, tfl } = setup({});
    expect((await get(path)).status).toBe(400);
    expect(tfl.calls).toHaveLength(0);
  });

  it('returns 404 for a station TfL does not know', async () => {
    const { get } = setup({});
    expect((await get('/api/station?stop=NOPE')).status).toBe(404);
  });
});

describe('GET /api/nearby', () => {
  const nearby = {
    stopPoints: [
      { id: '940GZZLUPRD', commonName: 'Preston Road Underground Station', distance: 1496.4,
        lines: [{ id: 'metropolitan', name: 'Metropolitan' }] },
      { id: '940GZZLUWYP', commonName: 'Wembley Park Underground Station', distance: 29.2,
        lines: [{ id: 'metropolitan', name: 'Metropolitan' }, { id: 'jubilee', name: 'Jubilee' }, { id: '83', name: '83' }] },
    ],
  };

  it('asks TfL for tube stations around the point and returns them nearest first', async () => {
    const { json, tfl } = setup({ '/StopPoint/': { body: nearby } });
    expect(await json('/api/nearby?lat=51.5636&lon=-0.2796')).toEqual({
      stations: [
        { id: '940GZZLUWYP', name: 'Wembley Park', distance: 29, lines: ['jubilee', 'metropolitan'] },
        { id: '940GZZLUPRD', name: 'Preston Road', distance: 1496, lines: ['metropolitan'] },
      ],
    });
    const params = tfl.calls[0]!.searchParams;
    expect(params.get('modes')).toBe('tube');
    expect(params.get('stopTypes')).toBe('NaptanMetroStation');
    expect(Number(params.get('lat'))).toBeCloseTo(51.564, 3);
    expect(Number(params.get('lon'))).toBeCloseTo(-0.28, 3);
  });

  it('shares one TfL lookup between points in the same ~100m cell', async () => {
    const { get, tfl } = setup({ '/StopPoint/': { body: nearby } });
    await get('/api/nearby?lat=51.5641&lon=-0.2801');
    await get('/api/nearby?lat=51.5644&lon=-0.2804');
    expect(tfl.calls).toHaveLength(1);
  });

  it.each([
    '/api/nearby',
    '/api/nearby?lat=51.5',
    '/api/nearby?lat=abc&lon=0',
    '/api/nearby?lat=91&lon=0',
    '/api/nearby?lat=51.5&lon=181',
    '/api/nearby?lat=Infinity&lon=0',
  ])('rejects %s without calling TfL', async (path) => {
    const { get, tfl } = setup({});
    expect((await get(path)).status).toBe(400);
    expect(tfl.calls).toHaveLength(0);
  });
});
