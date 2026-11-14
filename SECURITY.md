# Security

## Reporting a vulnerability

Report it privately through GitHub: Security tab → "Report a vulnerability". Please do not open a public issue for
anything that could expose a deployment's secret, tokens or saved places. Expect a first reply within a week.

## What a deployment protects

Each deployment is single-owner. `MCP_SECRET` is the only credential: anyone who knows it can use the MCP tools, read
and change the saved places, and spend the deployment's TfL and Realtime Trains allowance.

- Use a long random secret (`openssl rand -hex 32`) and serve the site over HTTPS only. The server refuses one under
  32 characters, because a guessable secret can be found offline from a signed client ID.
- Changing `MCP_SECRET` revokes every client and token.
- `DATA_DIR/owner.json` holds saved places, which can include a home address. It is written with mode 600; keep the
  directory off any shared or public path.
- The web app and its `/api` endpoints are public and unauthenticated by design. They expose Underground line status and
  departures only, and they spend your TfL allowance.

The README's "Login and security" section describes the OAuth implementation and its known limits, including that
used authorization codes and refresh tokens are remembered in memory only.
