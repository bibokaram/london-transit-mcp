import { Hono } from 'hono';
import { TflClient, TflError, TUBE_LINE_IDS } from './tfl.js';
import { createMcpRoutes } from './mcp.js';
import { OAuth, createOAuthRoutes } from './oauth.js';
import { OwnerStore } from './store.js';
import { RttClient } from './rtt.js';

export type AppOptions = {
  fetch: typeof fetch;
  appKey?: string;
  mcpSecret?: string;
  /** Public origin (https://host) used for OAuth issuer and resource URLs behind a proxy. */
  publicUrl?: string;
  /** Realtime Trains API token (refresh or long-life access) for live National Rail; without it those trains are timetabled only. */
  rttToken?: string;
  /** Directory for the owner's saved places (owner.json). Without it they are kept in memory and lost on restart. */
  dataDir?: string;
  now?: () => number;
};

const STOP_ID = /^[A-Za-z0-9]{1,30}$/;
const LINE_ID = /^[a-z0-9-]{1,30}$/;
const MAX_QUERY_LENGTH = 100;

export function createApp({ fetch, appKey, mcpSecret, publicUrl, rttToken, dataDir, now = Date.now }: AppOptions): Hono {
  const tfl = new TflClient(fetch, appKey, now);
  const rtt = new RttClient(fetch, rttToken, now);
  const store = new OwnerStore(dataDir);
  const app = new Hono();
  const auth = mcpSecret ? new OAuth({ secret: mcpSecret, now, publicUrl }) : undefined;
  if (auth) app.route('/', createOAuthRoutes(auth));
  app.route('/mcp', createMcpRoutes(tfl, auth, now, { rtt, store }));

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.onError((err, c) => {
    if (err instanceof TflError) {
      if (err.status === 404) return c.json({ error: 'Not found at TfL' }, 404);
      return c.json({ error: 'TfL is unavailable' }, 502);
    }
    console.error(err instanceof Error ? err.name : 'Unknown error');
    return c.json({ error: 'Something went wrong' }, 500);
  });

  app.get('/api/status', async (c) => {
    const lines = (c.req.query('lines') ?? '').split(',').filter(Boolean);
    if (lines.length === 0 || !lines.every((line) => TUBE_LINE_IDS.has(line))) {
      return c.json({ error: 'lines must be a comma-separated list of tube line ids' }, 400);
    }
    return c.json({ lines: await tfl.status(lines) });
  });

  app.get('/api/arrivals', async (c) => {
    const stop = c.req.query('stop') ?? '';
    const line = c.req.query('line');
    if (!STOP_ID.test(stop) || (line !== undefined && !LINE_ID.test(line))) {
      return c.json({ error: 'stop is required; stop and line must be valid ids' }, 400);
    }
    return c.json({ arrivals: await tfl.arrivals(stop, line) });
  });

  app.get('/api/station', async (c) => {
    const stop = c.req.query('stop') ?? '';
    if (!STOP_ID.test(stop)) return c.json({ error: 'stop must be a valid id' }, 400);
    return c.json(await tfl.station(stop));
  });

  app.get('/api/nearby', async (c) => {
    const lat = Number(c.req.query('lat'));
    const lon = Number(c.req.query('lon'));
    const valid =
      c.req.query('lat') && c.req.query('lon') &&
      Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (!valid) return c.json({ error: 'lat and lon must be valid coordinates' }, 400);
    return c.json({ stations: await tfl.nearby(lat, lon) });
  });

  app.get('/api/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0 || q.length > MAX_QUERY_LENGTH) {
      return c.json({ error: `q is required, up to ${MAX_QUERY_LENGTH} characters` }, 400);
    }
    return c.json({ stops: await tfl.search(q) });
  });

  return app;
}
