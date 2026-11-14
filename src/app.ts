import { Hono } from 'hono';
import { TflClient, TflError } from './tfl.js';
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

export function createApp({ fetch, appKey, mcpSecret, publicUrl, rttToken, dataDir, now = Date.now }: AppOptions): Hono {
  const tfl = new TflClient(fetch, appKey, now);
  const rtt = new RttClient(fetch, rttToken, now);
  const store = new OwnerStore(dataDir);
  const app = new Hono();
  const auth = mcpSecret ? new OAuth({ secret: mcpSecret, now, publicUrl }) : undefined;
  if (auth) app.route('/', createOAuthRoutes(auth));
  app.route('/mcp', createMcpRoutes(tfl, auth, now, { rtt, store }));

  app.onError((err, c) => {
    if (err instanceof TflError) {
      if (err.status === 404) return c.json({ error: 'Not found at TfL' }, 404);
      return c.json({ error: 'TfL is unavailable' }, 502);
    }
    console.error(err instanceof Error ? err.name : 'Unknown error');
    return c.json({ error: 'Something went wrong' }, 500);
  });

  app.get('/', (c) => c.text('London Transit MCP server. Connect an MCP client to /mcp.'));

  return app;
}
