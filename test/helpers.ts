export type FakeResponse = { status?: number; body?: unknown };
export type Route = FakeResponse | (() => FakeResponse | Promise<FakeResponse>);

/** A stand-in for TfL: maps "/path" to a canned response and records every URL requested. */
export function fakeTfl(routes: Record<string, Route>) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = routes[url.pathname];
    if (!route) return new Response('not found', { status: 404 });
    const { status = 200, body = [] } = typeof route === 'function' ? await route() : route;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export const lineWith = (id: string, name: string, ...statuses: object[]) => ({
  id,
  name,
  lineStatuses: statuses,
});

export const prediction = (over: Record<string, unknown>) => ({
  lineId: 'victoria',
  lineName: 'Victoria',
  platformName: 'Northbound - Platform 5',
  direction: 'outbound',
  destinationNaptanId: '940GZZLUWWL',
  destinationName: 'Walthamstow Central Underground Station',
  towards: 'Walthamstow Central',
  timeToStation: 60,
  expectedArrival: '2026-11-06T10:00:00Z',
  currentLocation: 'Between Euston and Warren Street',
  ...over,
});

export const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

type Requester = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

/** Reads the signed login request out of the authorize page. */
export async function loginRequest(app: Requester, authorizeUrl: string): Promise<string> {
  const page = await app.request(authorizeUrl);
  const match = /name="request" value="([^"]+)"/.exec(await page.text());
  if (page.status !== 200 || !match) throw new Error(`authorize page failed: ${page.status}`);
  return match[1]!;
}

export function submitLogin(app: Requester, request: string, secret: string, headers: Record<string, string> = {}) {
  return app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ request, secret }).toString(),
  });
}

/** Runs registration, login and code exchange by hand; returns the token response. */
export async function connectOAuth(app: Requester, secret: string, verifier = 'v'.repeat(43)) {
  const { createHash } = await import('node:crypto');
  const registered = await app.request('/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }),
  });
  const { client_id } = await registered.json() as { client_id: string };
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' });
  const login = await submitLogin(app, await loginRequest(app, `/oauth/authorize?${query}`), secret);
  const code = new URL(login.headers.get('location')!).searchParams.get('code')!;
  const token = await app.request('/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id, code_verifier: verifier }).toString(),
  });
  return { client_id, ...(await token.json() as { access_token: string; refresh_token: string; expires_in: number }) };
}

export const NETWORK_STATUS = '/Line/Mode/tube,elizabeth-line,overground,dlr,tram,national-rail,cable-car/Status';
const good = { statusSeverity: 10, statusSeverityDescription: 'Good Service' };
/** A small slice of the network status response, one or two lines per mode. */
export const networkLines = () => [
  { ...lineWith('south-western-railway', 'South Western Railway', { statusSeverity: 0, statusSeverityDescription: 'Special Service', reason: 'Fewer trains between Surbiton and Waterloo.' }), modeName: 'national-rail' },
  { ...lineWith('elizabeth', 'Elizabeth line', good), modeName: 'elizabeth-line' },
  { ...lineWith('victoria', 'Victoria', good), modeName: 'tube' },
  { ...lineWith('dlr', 'DLR', good), modeName: 'dlr' },
  { ...lineWith('tram', 'Tram', good), modeName: 'tram' },
  { ...lineWith('jubilee', 'Jubilee', good), modeName: 'tube' },
  { ...lineWith('mildmay', 'Mildmay', good), modeName: 'overground' },
];

/** Request key shared by the fixture recorder and the replaying fake: path plus sorted query, without the key. */
export function fixtureKey(url: URL) {
  const params = [...url.searchParams.entries()].filter(([name]) => name !== 'app_key').sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname}${params.length ? `?${new URLSearchParams(params)}` : ''}`;
}

/**
 * Replays TfL responses recorded by scripts/record-fixtures.ts. An unrecorded request fails the test loudly
 * rather than reaching the network.
 */
export async function replayTfl(...names: string[]) {
  const { readFileSync } = await import('node:fs');
  const responses: Record<string, { status: number; body: unknown }> = {};
  for (const name of names) {
    Object.assign(responses, JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')).responses);
  }
  const calls: URL[] = [];
  const missing: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const recorded = responses[fixtureKey(url)];
    if (!recorded) {
      missing.push(fixtureKey(url));
      return new Response(JSON.stringify({ message: 'not recorded' }), { status: 599 });
    }
    return new Response(typeof recorded.body === 'string' ? recorded.body : JSON.stringify(recorded.body), { status: recorded.status });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, missing };
}
