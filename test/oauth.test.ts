import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { createApp } from '../src/app.js';
import { CALLBACK, connectOAuth, fakeTfl, loginRequest, NETWORK_STATUS, networkLines, submitLogin } from './helpers.js';

const SECRET = 'test-only-not-a-production-credential';
const START = Date.parse('2026-11-10T08:00:00Z');

function setup(options: { publicUrl?: string } = {}) {
  let time = START;
  const tfl = fakeTfl({ [NETWORK_STATUS]: { body: networkLines() } });
  const app = createApp({ fetch: tfl.fetch, mcpSecret: SECRET, now: () => time, ...options });
  const form = (path: string, fields: Record<string, string>) => app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
  });
  const listTools = (token?: string) => app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return { app, tfl, form, listTools, advance: (ms: number) => { time += ms; } };
}

class MemoryProvider implements OAuthClientProvider {
  info: any; saved: any; verifier = ''; authorizationUrl?: URL;
  get redirectUrl() { return CALLBACK; }
  get clientMetadata() {
    return { client_name: 'Claude', redirect_uris: [CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }
  clientInformation() { return this.info; }
  saveClientInformation(info: any) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens: any) { this.saved = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
}

describe('OAuth for the MCP endpoint', () => {
  it('lets the official SDK client discover, register, log in with the secret and call tools', async () => {
    const { app } = setup();
    const provider = new MemoryProvider();
    const fetchFn = async (url: string | URL, init?: RequestInit) => app.request(String(url), init);
    const transport = () => new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { authProvider: provider, fetch: fetchFn });

    await expect(new Client({ name: 'claude', version: '1' }).connect(transport())).rejects.toBeInstanceOf(UnauthorizedError);
    const authorizeUrl = provider.authorizationUrl!;
    expect(authorizeUrl.pathname).toBe('/oauth/authorize');
    expect(authorizeUrl.searchParams.get('resource')).toBe('http://localhost/mcp');
    expect(authorizeUrl.toString()).not.toContain(SECRET);

    const page = await app.request(authorizeUrl.pathname + authorizeUrl.search);
    const html = await page.text();
    expect(html).toContain('Connect Claude');
    expect(html).toContain('claude.ai');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    const login = await submitLogin(app, await loginRequest(app, authorizeUrl.pathname + authorizeUrl.search), SECRET);
    expect(login.status).toBe(303);
    const redirect = new URL(login.headers.get('location')!);
    expect(redirect.origin + redirect.pathname).toBe(CALLBACK);
    expect(redirect.searchParams.get('state')).toBe(authorizeUrl.searchParams.get('state'));
    expect(redirect.searchParams.get('iss')).toBe('http://localhost');

    const finishing = transport();
    await finishing.finishAuth(redirect.searchParams.get('code')!);
    expect(provider.saved.refresh_token).toBeTruthy();

    const client = new Client({ name: 'claude', version: '1' });
    await client.connect(transport());
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('line_status');
    const status = await client.callTool({ name: 'line_status', arguments: { lines: ['victoria'] } });
    expect(status.isError).toBeFalsy();
    await client.close();
  });

  it('challenges unauthenticated requests with protected resource metadata', async () => {
    const { app, listTools, tfl } = setup();
    const response = await listTools();
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"');
    const invalid = await listTools('not-a-token');
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(tfl.calls).toHaveLength(0);

    const metadata = await (await app.request('/.well-known/oauth-protected-resource/mcp')).json() as any;
    expect(metadata).toMatchObject({ resource: 'http://localhost/mcp', authorization_servers: ['http://localhost'] });
    const server = await (await app.request('/.well-known/oauth-authorization-server')).json() as any;
    expect(server).toMatchObject({ issuer: 'http://localhost', code_challenge_methods_supported: ['S256'], registration_endpoint: 'http://localhost/oauth/register' });
  });

  it('uses the configured public origin behind a proxy', async () => {
    const { app, listTools } = setup({ publicUrl: 'https://tube.example' });
    expect((await listTools()).headers.get('www-authenticate')).toContain('https://tube.example/.well-known/oauth-protected-resource/mcp');
    const server = await (await app.request('/.well-known/oauth-authorization-server')).json() as any;
    expect(server.token_endpoint).toBe('https://tube.example/oauth/token');
    const { access_token } = await connectOAuth(app, SECRET);
    expect((await listTools(access_token)).status).toBe(200);
    const crossOrigin = await app.request('/mcp', { method: 'POST', headers: { Origin: 'https://attacker.example', Authorization: `Bearer ${access_token}` } });
    expect(crossOrigin.status).toBe(403);
  });

  it('rejects a wrong secret, then rate limits repeated failures', async () => {
    const { app } = setup();
    const { client_id } = await connectOAuth(app, SECRET);
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: CALLBACK, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' });
    const request = await loginRequest(app, `/oauth/authorize?${query}`);
    const wrong = await submitLogin(app, request, 'guess', { 'X-Forwarded-For': '203.0.113.9' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('location')).toBeNull();
    expect(await wrong.text()).toContain('That secret is not right');
    // The proxy appends the real address last; whatever the client sends before it must not move it to a new bucket.
    for (let attempt = 0; attempt < 9; attempt++) await submitLogin(app, request, 'guess', { 'X-Forwarded-For': `10.0.0.${attempt}, 203.0.113.9`, 'X-Real-IP': `10.0.0.${attempt}` });
    expect((await submitLogin(app, request, SECRET, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(429);
    expect((await submitLogin(app, request, SECRET, { 'X-Forwarded-For': '198.51.100.1' })).status).toBe(303);
  });

  it('only registers redirects back to Claude, ChatGPT or a local client', async () => {
    const { app } = setup();
    const register = (redirect_uris: unknown) => app.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris }) });
    expect((await register(['https://attacker.example/callback'])).status).toBe(400);
    expect((await register(['http://claude.ai/api/mcp/auth_callback'])).status).toBe(400);
    expect((await register([])).status).toBe(400);
    expect((await register(['http://localhost:51234/callback'])).status).toBe(201);
    expect((await register(['https://claude.com/api/mcp/auth_callback'])).status).toBe(201);
    expect((await register(['https://chatgpt.com/connector_platform_oauth_redirect'])).status).toBe(201);
    expect((await register(['https://chatgpt.com.attacker.example/callback'])).status).toBe(400);
    expect((await register(['https://chatgpt.com/some/other/page'])).status).toBe(400);
    expect((await register(['https://claude.ai/share/anything'])).status).toBe(400);
    expect((await register(['https://claude.ai:8443/api/mcp/auth_callback'])).status).toBe(400);
  });

  it('refuses to redirect anywhere the client did not register, and requires PKCE S256', async () => {
    const { app } = setup();
    const { client_id } = await connectOAuth(app, SECRET);
    const authorize = (params: Record<string, string>) => app.request(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', ...params })}`);
    expect((await authorize({ redirect_uri: 'https://claude.ai/elsewhere' })).status).toBe(400);
    expect((await authorize({ client_id: 'forged.client', redirect_uri: CALLBACK })).status).toBe(400);
    const plain = await authorize({ redirect_uri: CALLBACK, code_challenge_method: 'plain', state: 's1' });
    expect(plain.status).toBe(302);
    const location = new URL(plain.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('s1');
    const wrongResource = await authorize({ redirect_uri: CALLBACK, resource: 'https://other.example/mcp' });
    expect(new URL(wrongResource.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('exchanges a code once, only with the right verifier, client and redirect', async () => {
    const { app, form } = setup();
    const verifier = 'w'.repeat(43);
    const registered = await (await app.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK] }) })).json() as any;
    const other = await connectOAuth(app, SECRET);
    const query = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: CALLBACK, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const login = await submitLogin(app, await loginRequest(app, `/oauth/authorize?${query}`), SECRET);
    const code = new URL(login.headers.get('location')!).searchParams.get('code')!;
    const exchange = (fields: Record<string, string>) => form('/oauth/token', { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: registered.client_id, code_verifier: verifier, ...fields });

    expect((await exchange({ code_verifier: 'x'.repeat(43) })).status).toBe(400);
    expect((await exchange({ client_id: other.client_id })).status).toBe(400);
    expect((await exchange({ redirect_uri: 'http://localhost/callback' })).status).toBe(400);
    expect((await exchange({ client_id: 'forged' })).status).toBe(401);
    const ok = await exchange({});
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(await (await exchange({})).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('expires codes and access tokens, and rotates single-use refresh tokens', async () => {
    const { app, form, listTools, advance } = setup();
    const tokens = await connectOAuth(app, SECRET);
    expect((await listTools(tokens.access_token)).status).toBe(200);
    advance(61 * 60 * 1000);
    expect((await listTools(tokens.access_token)).status).toBe(401);

    const refresh = (refresh_token: string) => form('/oauth/token', { grant_type: 'refresh_token', refresh_token, client_id: tokens.client_id });
    const rotated = await (await refresh(tokens.refresh_token)).json() as any;
    expect((await listTools(rotated.access_token)).status).toBe(200);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    expect((await refresh(rotated.access_token)).status).toBe(400);
    advance(31 * 24 * 60 * 60 * 1000);
    expect((await refresh(rotated.refresh_token)).status).toBe(400);
  });

  it('revokes everything when MCP_SECRET changes', async () => {
    const { app } = setup();
    const tokens = await connectOAuth(app, SECRET);
    const rotated = createApp({ fetch: fakeTfl({}).fetch, mcpSecret: 'a-new-secret', now: () => START });
    const response = await rotated.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect(response.status).toBe(401);
  });

  it('keeps the old secret-in-path URL and OAuth endpoints closed', async () => {
    const { listTools, app } = setup();
    const old = await app.request(`/mcp/${SECRET}`, { method: 'POST' });
    expect(old.status).toBe(404);
    const disabled = createApp({ fetch: fakeTfl({}).fetch });
    expect((await disabled.request('/.well-known/oauth-authorization-server')).status).toBe(404);
    expect((await disabled.request('/mcp', { method: 'POST' })).status).toBe(404);
    expect((await listTools()).status).toBe(401);
  });
});

describe('secret strength', () => {
  it('refuses a secret short enough to guess offline from a signed client ID', async () => {
    const { secretProblem } = await import('../src/oauth.js');
    expect(secretProblem('hunter2')).toMatch(/at least 32/);
    expect(secretProblem('a'.repeat(40))).toMatch(/random/);
    expect(secretProblem('3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3e')).toBeUndefined();
  });
});
