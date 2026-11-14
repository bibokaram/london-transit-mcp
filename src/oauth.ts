import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/**
 * A single-owner OAuth 2.1 authorization server for the MCP endpoint.
 *
 * The owner proves themselves by typing MCP_SECRET into a login page, so the secret never
 * appears in a URL. Everything is stateless: clients, codes and tokens are HMAC-signed with a
 * key derived from MCP_SECRET, so a restart keeps sessions and rotating the secret revokes all.
 * Single-use codes and refresh tokens are remembered in memory until they expire.
 */

export const ACCESS_TTL = 60 * 60;
export const REFRESH_TTL = 30 * 24 * 60 * 60;
const CODE_TTL = 2 * 60;
const LOGIN_TTL = 10 * 60;
const CLIENT_TTL = 10 * 365 * 24 * 60 * 60;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * 60 * 1000;
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
/** Exact OAuth callbacks of the hosted clients, so no other page on their hosts can receive a code. */
const HOSTED_CALLBACKS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
];

export type OAuthOptions = {
  secret: string;
  now: () => number;
  /** Public origin, e.g. https://tube.example. Falls back to the request origin. */
  publicUrl?: string;
  /** Exact https callback URLs (origin + path, any query) allowed besides loopback http. */
  redirectUris?: string[];
};

type Claims = Record<string, unknown> & { typ: string; exp: number };

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Shortest MCP_SECRET the server accepts. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Anyone can register a client and receive a value signed with a key derived from the secret, so a guessable secret
 * can be found offline without ever touching the login page. Only a long random secret is safe; a short one is refused.
 */
export function secretProblem(secret: string): string | undefined {
  if (secret.length < MIN_SECRET_LENGTH) return `MCP_SECRET must be at least ${MIN_SECRET_LENGTH} characters of random text (openssl rand -hex 32). /mcp stays disabled.`;
  if (new Set(secret).size < 8) return 'MCP_SECRET repeats too few characters to be random (openssl rand -hex 32). /mcp stays disabled.';
  return undefined;
}

export class OAuth {
  private readonly key: Buffer;
  private readonly secretDigest: Buffer;
  private readonly used = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly redirectUris: Set<string>;

  constructor(private readonly options: OAuthOptions) {
    // The salt is the project's first name. Changing it would revoke every client and token.
    this.key = Buffer.from(hkdfSync('sha256', options.secret, 'tube-status', 'oauth-signing-v1', 32));
    this.secretDigest = sha256(options.secret);
    this.redirectUris = new Set(options.redirectUris ?? HOSTED_CALLBACKS);
  }

  base(context: Context): string {
    return this.options.publicUrl ?? new URL(context.req.url).origin;
  }

  resource(context: Context): string {
    return `${this.base(context)}/mcp`;
  }

  resourceMetadataUrl(context: Context): string {
    return `${this.base(context)}/.well-known/oauth-protected-resource/mcp`;
  }

  /** Returns true when the request carries a valid, unexpired access token for this resource. */
  authorized(context: Context): boolean {
    const header = context.req.header('Authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    const claims = match ? this.verify(match[1]!, 'access') : undefined;
    return claims?.aud === this.resource(context);
  }

  seconds(): number {
    return Math.floor(this.options.now() / 1000);
  }

  sign(typ: string, ttl: number, claims: Record<string, unknown> = {}): string {
    const payload = b64(JSON.stringify({ ...claims, typ, exp: this.seconds() + ttl }));
    return `${payload}.${b64(createHmac('sha256', this.key).update(payload).digest())}`;
  }

  verify(token: string, typ: string): Claims | undefined {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return undefined;
    const expected = createHmac('sha256', this.key).update(payload).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
      return claims.typ === typ && typeof claims.exp === 'number' && claims.exp > this.seconds() ? claims : undefined;
    } catch {
      return undefined;
    }
  }

  /** Marks a single-use token as spent. Returns false when it was already spent. */
  useOnce(claims: Claims): boolean {
    const now = this.seconds();
    for (const [jti, exp] of this.used) if (exp <= now) this.used.delete(jti);
    const jti = String(claims.jti);
    if (this.used.has(jti)) return false;
    this.used.set(jti, claims.exp);
    return true;
  }

  checkSecret(supplied: string): boolean {
    return timingSafeEqual(this.secretDigest, sha256(supplied));
  }

  /** Counts a failed login; returns false once the caller is over the limit. */
  allowAttempt(ip: string, failed: boolean): boolean {
    const now = this.options.now();
    let entry = this.failures.get(ip);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + FAILURE_WINDOW };
    if (failed) entry.count += 1;
    this.failures.set(ip, entry);
    return entry.count < MAX_FAILURES;
  }

  redirectAllowed(uri: string): boolean {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === 'https:') return url.port === '' && this.redirectUris.has(url.origin + url.pathname);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }

  /** The client id is itself a signed record of the registration. */
  client(clientId: string): { name: string; redirectUris: string[]; cid: string } | undefined {
    const claims = this.verify(clientId, 'client');
    if (!claims || !Array.isArray(claims.redirect_uris)) return undefined;
    return { name: String(claims.name ?? 'An MCP client'), redirectUris: claims.redirect_uris.map(String), cid: b64(sha256(clientId)) };
  }

  tokens(cid: string, aud: string) {
    return {
      access_token: this.sign('access', ACCESS_TTL, { cid, aud, jti: b64(randomBytes(12)) }),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: this.sign('refresh', REFRESH_TTL, { cid, aud, jti: b64(randomBytes(12)) }),
    };
  }
}

/**
 * The key for the wrong-secret limit. The last X-Forwarded-For hop is the one the nearest proxy appended, so a client
 * cannot choose it; earlier hops and X-Real-IP can be sent by anyone. With no proxy every client shares one bucket.
 */
function clientIp(context: Context): string {
  return context.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown';
}

function loginPage(options: { client: string; host: string; request: string; error?: string }): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Connect to London Transit</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { width: min(24rem, calc(100% - 3rem)); }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; opacity: .8; }
  label { display: block; font-weight: 600; margin-bottom: .35rem; }
  input, button { box-sizing: border-box; width: 100%; font: inherit; padding: .7rem .8rem; border-radius: .5rem; }
  input { border: 1px solid GrayText; background: Field; color: FieldText; }
  button { margin-top: .9rem; border: 0; background: #0019a8; color: #fff; font-weight: 600; cursor: pointer; }
  .error { color: #d00; opacity: 1; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .error { color: #ff6b6b; } }
</style>
</head>
<body>
<main>
  <h1>Connect ${escape(options.client)}</h1>
  <p>It will get access to London Transit journey planning, departures and line status, and to the places and preferences it saves for you. After you connect, you return to <strong>${escape(options.host)}</strong>.</p>
  ${options.error ? `<p class="error" role="alert">${escape(options.error)}</p>` : ''}
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="request" value="${escape(options.request)}">
    <label for="secret">MCP secret</label>
    <input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Connect</button>
  </form>
</main>
</body>
</html>`;
}

export function createOAuthRoutes(auth: OAuth): Hono {
  const app = new Hono();

  // Scoped paths: this app is mounted at the root, so '*' would also cover every other route.
  for (const path of ['/oauth/*', '/.well-known/*']) {
    app.use(path, async (context, next) => {
      await next();
      context.header('Cache-Control', 'no-store');
      context.header('Referrer-Policy', 'no-referrer');
      context.header('X-Content-Type-Options', 'nosniff');
    });
  }
  app.use('/oauth/*', bodyLimit({ maxSize: 16 * 1024, onError: (context) => context.json({ error: 'invalid_request', error_description: 'Request too large' }, 413) }));

  const protectedResource = (context: Context) => context.json({
    resource: auth.resource(context),
    authorization_servers: [auth.base(context)],
    bearer_methods_supported: ['header'],
    resource_name: 'London Transit',
  });
  app.get('/.well-known/oauth-protected-resource', protectedResource);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  app.get('/.well-known/oauth-authorization-server', (context) => {
    const base = auth.base(context);
    return context.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  app.post('/oauth/register', async (context) => {
    const body = await context.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((uri) => typeof uri === 'string' && uri.length <= 500)) {
      return context.json({ error: 'invalid_redirect_uri', error_description: 'Provide 1–5 redirect_uris.' }, 400);
    }
    const rejected = uris.filter((uri) => !auth.redirectAllowed(uri));
    if (rejected.length > 0) {
      // Log origin and path (no query) so an unexpected client is diagnosable.
      console.warn('OAuth registration rejected redirect:', rejected.map((uri) => { try { const url = new URL(uri); return url.origin + url.pathname; } catch { return 'invalid'; } }).join(', '));
      return context.json({ error: 'invalid_redirect_uri', error_description: 'Redirects are limited to Claude, ChatGPT and local clients.' }, 400);
    }
    const name = typeof body?.client_name === 'string' ? body.client_name.slice(0, 100) : 'An MCP client';
    const clientId = auth.sign('client', CLIENT_TTL, { name, redirect_uris: uris });
    return context.json({
      client_id: clientId,
      client_id_issued_at: auth.seconds(),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }, 201);
  });

  const invalid = (context: Context, message: string) =>
    context.html(`<!doctype html><meta charset="utf-8"><title>Cannot connect</title><p>${escape(message)}</p>`, 400);

  app.get('/oauth/authorize', (context) => {
    const query = context.req.query();
    const client = auth.client(query.client_id ?? '');
    if (!client) return invalid(context, 'Unknown client. Remove the connector and add it again.');
    const redirectUri = query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) return invalid(context, 'The redirect address does not match this client.');

    const fail = (error: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (query.state !== undefined) url.searchParams.set('state', query.state);
      url.searchParams.set('iss', auth.base(context));
      return context.redirect(url.toString(), 302);
    };
    if (query.response_type !== 'code') return fail('unsupported_response_type', 'Only the code flow is supported.');
    if (query.code_challenge_method !== 'S256' || !PKCE.test(query.code_challenge ?? '')) return fail('invalid_request', 'PKCE with S256 is required.');
    if (query.resource !== undefined && query.resource !== auth.resource(context)) return fail('invalid_target', 'Unknown resource.');

    const request = auth.sign('login', LOGIN_TTL, {
      client_id: query.client_id, redirect_uri: redirectUri, state: query.state, code_challenge: query.code_challenge,
    });
    context.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    return context.html(loginPage({ client: client.name, host: new URL(redirectUri).host, request }));
  });

  app.post('/oauth/authorize', async (context) => {
    const form = await context.req.parseBody();
    const request = auth.verify(String(form.request ?? ''), 'login');
    if (!request) return invalid(context, 'This login page has expired. Start connecting again from your MCP client.');
    const client = auth.client(String(request.client_id));
    if (!client) return invalid(context, 'Unknown client. Remove the connector and add it again.');
    const redirectUri = String(request.redirect_uri);
    const ip = clientIp(context);

    context.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    if (!auth.allowAttempt(ip, false)) {
      return context.html(loginPage({ client: client.name, host: new URL(redirectUri).host, request: String(form.request), error: 'Too many attempts. Try again in 15 minutes.' }), 429);
    }
    if (!auth.checkSecret(String(form.secret ?? ''))) {
      auth.allowAttempt(ip, true);
      return context.html(loginPage({ client: client.name, host: new URL(redirectUri).host, request: String(form.request), error: 'That secret is not right.' }), 401);
    }

    const code = auth.sign('code', CODE_TTL, {
      cid: client.cid, redirect_uri: redirectUri, code_challenge: request.code_challenge, aud: auth.resource(context), jti: b64(randomBytes(12)),
    });
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (request.state !== undefined) url.searchParams.set('state', String(request.state));
    url.searchParams.set('iss', auth.base(context));
    return context.redirect(url.toString(), 303);
  });

  app.post('/oauth/token', async (context) => {
    const form = await context.req.parseBody();
    const field = (name: string) => (typeof form[name] === 'string' ? form[name] as string : '');
    const error = (code: string, description: string, status: 400 | 401 = 400) =>
      context.json({ error: code, error_description: description }, status);

    const client = auth.client(field('client_id'));
    if (!client) return error('invalid_client', 'Unknown client.', 401);

    if (field('grant_type') === 'authorization_code') {
      const code = auth.verify(field('code'), 'code');
      if (!code || code.cid !== client.cid || code.redirect_uri !== field('redirect_uri')) return error('invalid_grant', 'The code is invalid or expired.');
      const verifier = field('code_verifier');
      if (!PKCE.test(verifier) || b64(sha256(verifier)) !== code.code_challenge) return error('invalid_grant', 'PKCE verification failed.');
      if (!auth.useOnce(code)) return error('invalid_grant', 'The code was already used.');
      return context.json(auth.tokens(client.cid, String(code.aud)));
    }

    if (field('grant_type') === 'refresh_token') {
      const refresh = auth.verify(field('refresh_token'), 'refresh');
      if (!refresh || refresh.cid !== client.cid) return error('invalid_grant', 'The refresh token is invalid or expired.');
      if (!auth.useOnce(refresh)) return error('invalid_grant', 'The refresh token was already used.');
      return context.json(auth.tokens(client.cid, String(refresh.aud)));
    }

    return error('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  });

  return app;
}
