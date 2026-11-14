import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { secretProblem } from './oauth.js';

const appKey = process.env.TFL_APP_KEY || undefined;
if (!appKey) console.warn('TFL_APP_KEY is not set: using keyless TfL requests, which are rate limited.');

// Behind Railway's proxy the request URL is plain http, so OAuth URLs need the public origin.
const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '')
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
const rttToken = process.env.RTT_TOKEN || undefined;
if (!rttToken) console.warn('RTT_TOKEN is not set: National Rail operators other than Thameslink have no live departures.');
if (!process.env.DATA_DIR) console.warn('DATA_DIR is not set: saved places are kept in memory and lost on restart.');
const secretRefused = process.env.MCP_SECRET ? secretProblem(process.env.MCP_SECRET) : undefined;
if (secretRefused) console.error(secretRefused);
const app = createApp({
  fetch: globalThis.fetch, appKey, mcpSecret: secretRefused ? undefined : process.env.MCP_SECRET || undefined, publicUrl,
  rttToken, dataDir: process.env.DATA_DIR || undefined,
});

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`London Transit listening on port ${port}`);
});
