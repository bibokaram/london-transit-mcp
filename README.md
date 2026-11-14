# London Transit

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

London public transport for AI assistants, plus a departure-board web app, in one small Node server you host yourself.

- **An MCP server** at `/mcp` that gives Claude, ChatGPT or any MCP client journey planning, timetables, live departures and
  disruption for the Tube, Elizabeth line, Overground, DLR, tram, buses, river buses and National Rail. It remembers your
  places and the modes you avoid, follows a journey while you travel, and lets the model change one leg of a route.
- **A home-screen web app** that shows your saved Tube stations as a departure board.

It reads the [TfL Unified API](https://api.tfl.gov.uk) and, optionally, [Realtime Trains](https://www.realtimetrains.co.uk).
It is single-owner: one deployment serves one person, with no accounts and no database. This is an independent project, not
affiliated with or endorsed by Transport for London, Realtime Trains or Anthropic.

## What an assistant can do with it

| Ask | Tool |
| --- | --- |
| "Get me from home to Canary Wharf by 9, no buses" | `plan_journey`, `show_journey` (drawn as a card) |
| "Same route but Jubilee instead of the DLR" | `change_journey` |
| "I'm on my way, keep an eye on it" | `follow_journey` |
| "How often do trains run from London Bridge to East Croydon this afternoon?" | `timetable` |
| "Next trains from Clapham Junction to Waterloo" | `live_departures`, `train_service` |
| "Which of these 20 flats has the best commute?" | `plan_journeys_batch` |
| "Is the Northern line OK?" | `line_status` |
| "Remember my home is E20 2ST and I avoid buses" | `remember` |

It does not draw maps, route cars or bikes, search for places, know fares, or see your location, and it cannot push alerts:
it answers when the assistant asks. Planning covers the area TfL's journey planner covers.

## Quick start

Requires Node 22 or later.

```bash
git clone <this repo> && cd london-transit-mcp
npm install
export MCP_SECRET=$(openssl rand -hex 32)   # enables /mcp; you type this at the login page
npm run dev
```

The web app is at http://localhost:3000 and the MCP endpoint at http://localhost:3000/mcp. Without `TFL_APP_KEY`, TfL requests
are keyless and rate limited, which is enough to try it. The server reads environment variables from the process; it does not
load `.env` files.

## Configuration

| Variable | Needed | Effect |
| --- | --- | --- |
| `TFL_APP_KEY` | Recommended | TfL API key from https://api-portal.tfl.gov.uk (the "500 Requests per min" product). Never sent to the browser |
| `MCP_SECRET` | For MCP | Enables `/mcp` and is the secret typed at the OAuth login: at least 32 random characters (`openssl rand -hex 32`). Unset or too short, `/mcp` returns 404 |
| `PUBLIC_URL` | Off Railway | The public origin, e.g. `https://tube.example.com`, used in OAuth URLs. On Railway it is read from `RAILWAY_PUBLIC_DOMAIN` |
| `RTT_TOKEN` | Optional | Realtime Trains API token from https://api-portal.rtt.io: live departures for every National Rail operator, `calling_at` and `train_service` |
| `DATA_DIR` | Optional | A writable directory on persistent storage for `owner.json` (saved places, preferences, followed journeys). Unset, they live in memory and are lost on restart |
| `PORT` | Optional | Listening port, default 3000 |

## Deploy

Any host that runs Node 22 and gives you HTTPS works: `npm ci && npm run build && npm start`. There is no build step for the
web app or the journey card.

On Railway: create a service from your fork, set the variables above, add a volume and point `DATA_DIR` at its mount path
(for example `/data`). Pushes to the deployed branch redeploy.

## Connect an assistant

1. Add `https://<your-host>/mcp` as a custom connector in Claude or ChatGPT, with OAuth and no preset client ID or secret.
2. The assistant opens a login page on your server. Type `MCP_SECRET` there and press Connect.
3. Ask it to call `get_context`. It lists what is saved and, under `owner_setup_pending`, any optional setting still unset.

A conversation opened before a deploy keeps the tool list it started with; start a new one to see new tools.

To put the web app on an iPhone, open the URL in Safari, tap Share, then Add to Home Screen.

## Data sources and their terms

You bring your own keys, and each provider's terms apply to your deployment, not this licence.

- **Transport for London.** Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016 and Geomni UK
  Map data © and database rights 2019. See TfL's [open data terms](https://tfl.gov.uk/corporate/terms-and-conditions/transport-data-service).
- **Realtime Trains.** Their [API terms](https://www.realtimetrains.co.uk/legal/api/) (read 14 November 2026) allow free access
  for personal, non-commercial use only; anything commercial needs their written agreement. A token belongs to one person and
  must not be shared or shipped inside an app, which is why this server keeps it server-side and why every deployment needs
  its own. A public-facing use must credit [Realtime Trains](https://www.realtimetrains.co.uk) visibly, and the data may not
  be used to build a product that competes with theirs. The server stays inside the published allowance (10 requests a
  minute, 100 an hour, 1,000 a day) and never polls. Results that include their data are labelled `Realtime Trains` in `source`.
- **Station codes.** `src/data/crs.ts` is generated from DfT NaPTAN, published under the Open Government Licence v3.0.

Times are forecasts and timetables, not guarantees. Do not rely on this for anything safety-critical.

## Develop

```bash
npm test          # 300 tests, no network: TfL responses are replayed from test/fixtures
npm run typecheck
npm run build
```

Fixtures are recorded by `scripts/record-fixtures.ts`. `bench/` holds the harnesses, prompts and written results of five blind tests
of the tool design (split or merged tools, with and without an operating manual); see [bench/README.md](bench/README.md).
See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE).

# Reference

## Web app API

| Endpoint | Returns |
| --- | --- |
| `GET /api/status?lines=victoria,northern` | Status, severity level and reason per line |
| `GET /api/arrivals?stop=<id>&line=<optional>` | Every train soonest first, with direction, platform, clock time and current location |
| `GET /api/station?stop=<id>` | A station's name and its tube lines |
| `GET /api/nearby?lat=<lat>&lon=<lon>` | Up to 8 tube stations within 1.5 km, nearest first |
| `GET /api/search?q=<name>` | Matching tube and bus stops |

Home shows up to 5 saved stations: each station's lines with their status and the next 3 trains in each direction; Settings
can hide a line at one station. Each person's choices stay in their browser.
Live TfL responses are cached in memory for 30 seconds; station details and nearby lookups for a day.
Arrivals leave out trains that end their journey at the station, since nobody can board them there.

TfL search returns `HUB...` ids for interchanges such as King's Cross, and its arrivals endpoint returns
nothing for those. The server resolves a hub to its tube stations and merges their arrivals.

## MCP server

The same server exposes a Streamable HTTP MCP endpoint at `/mcp`, protected by OAuth 2.1. Every tool is read-only except
the three that store something for the owner: `remember`, `follow_journey` and `change_journey`.
It is disabled (404) when `MCP_SECRET` is unset. The public web app and its existing API are unchanged.
The MCP server uses the existing server-side `TFL_APP_KEY` and shares the app's TfL caches and departure-board corrections.

| Tool | Purpose |
| --- | --- |
| `get_context` | What the user has saved (places, avoided modes, followed journeys) and what is true now (London clock, feed state, lines disrupted). No instructions; read when a request leans on it |
| `remember` | One tool with an `action`: `show` what is saved, `save_place` / `forget_place` a labelled place (`home`, `work`) usable as `from`/`to`, `set_preferences` for modes the owner avoids by default |
| `follow_journey` | One tool with an `action`: `start` saves a chosen route while travelling, `check` reports how it is going against the plan, `end` deletes it |
| `change_journey` | One tool with an `action`: `replace_leg`, `insert_leg`, `remove_leg` on a planned or followed route, or `set_legs` to lay one out from nothing; reports the cost against TfL's first choice |
| `show_journey` | `plan_journey` drawn for the user as a journey card (an MCP App), with the status of the lines used |
| `train_service` | One National Rail train's calling points with live times and platforms; registered only when `RTT_TOKEN` is set |
| `timetable` | Every direct service between two stations in a window of up to 6 hours on a date, with per-hour counts by operator, the longest gap and a completeness report |
| `plan_journey` | One trip, departing at a time or arriving by a deadline; up to 3 routes; `exclude_modes` and `preference` |
| `plan_journeys_batch` | 1–25 origins to one destination at one time; one route each, concurrency 3; same route controls |
| `live_departures` | Tube, Elizabeth line, Overground, DLR, tram, Thameslink, bus and river bus departures by station or stop name, CRS code or stop ID, plus every other National Rail operator with `RTT_TOKEN`; optional line/route, direction and `calling_at`; up to 20 |
| `line_status` | Current status by line ID or mode, including National Rail operators; defaults to London rail |

Use `timetable` for frequency and "every train between" questions, `plan_journey` for one trip (with changes, or door to door),
and `live_departures` for the next few minutes.

### Mode control

`exclude_modes` (`bus`, `tube`, `national-rail`, `overground`, `elizabeth-line`, `dlr`, `tram`, `river-bus`, `cable-car`) keeps
modes out of `plan_journey`, `plan_journeys_batch` and `show_journey`. The server sends TfL's planner the remaining modes and then
drops any returned route that still uses an excluded one, so the exclusion does not depend on TfL or on the model; `bus` also
removes rail replacement buses. When nothing avoids the excluded modes the result is `no_journeys` with that reason, never a
route that uses them. `preference` is `fastest`, `fewest_changes` or `least_walking`.

The owner's saved travel preference (`remember` with `set_preferences`, e.g. `["bus"]`) applies to every planning call, and
`exclude_modes` adds to it: "no tube today" is `exclude_modes: ["tube"]` and buses stay out without being repeated.
`ignore_preference: true` lets the saved modes back in for one call, so an avoided mode is always reachable. `mode_filter`
reports `excluded`, `source` (`request`, `saved_preference`, `request_and_saved_preference` or `none`), the two parts when both
contributed, and `preference_ignored` when it was lifted. When the saved preference applied, the server also plans without it,
still honouring the call's own exclusions (one more cached planner call; not in the batch tool), and adds
`faster_with_avoided_modes` if a route using an avoided mode saves five minutes or more, or is the only route, so the preference
never silently hides a much faster trip.

### Following a journey

`follow_journey` with `start` plans a trip, saves the chosen alternative under a label (default `current`, up to 5) and draws the card.
`check` then reports on it: the leg under way by the clock, the rest of the saved route timed again on its own lines from
the next boarding point at the time the traveller reaches it, `expected_arrival` against `planned_arrival`, a `verdict` (`on_plan`
within two minutes, `later`, `earlier`, `route_broken` when one of its legs can no longer be timed, `arrived`, `unknown`),
`tfl_suggests` when TfL's own route from that point is five minutes or more faster or the saved route is broken, and the status of
the plan's lines.
`end` deletes it, and it drops by itself two hours after the planned arrival. The server cannot see the traveller: position
is assumed from the planned times and every result says so. The model reports when asked; nothing here can push an alert. The
card calls `follow_journey` with `check` itself every minute while it is open, dims the legs already done and marks the current one.

### Journeys as legs

TfL's planner chooses whole routes and has no way to prefer or avoid a line, so `src/legs.ts` holds a journey as a leg plan: an
ordered list of `{ to, by }`, where `by` is a line or route ID (`jubilee`, `thameslink`, `436`), a mode, or `walk`. It is timed
one planner call per leg, restricted to that leg's mode, each leg starting where and when the last one ended (the previous leg's
arrival stop ID), keeping the earliest option that is one direct service on the named line. Because the planner drops a train
another ties or beats (Hammersmith & City behind Circle at Farringdon), a named line that is missing is asked for twice more, each
time from a minute after the first departure offered. A leg that still cannot be timed returns `leg_failed` with the leg, the
reason and what TfL offered, and nothing is saved.

The normal path is plan once, then amend. `plan_journey` and `show_journey` make one planner call, and the server keeps each
returned route as a leg plan (in memory, for an hour, replaced by the next plan), so nothing has to be built leg by leg first.

- `change_journey` with `replace_leg`, `insert_leg` or `remove_leg` changes one leg of a route from the most recent plan (`journey: "plan"`, `route: n`) or of a
  followed journey (its label). Legs before the change keep the times they have; only the changed leg and those after it are
  timed, one request each. It reports `change` (arrival, walking and changes before and after, `legs_timed_again`) and
  `compared_with_tfl`. The amended route becomes route 1 of `"plan"`, so changes chain, and `follow_as` starts following it. A
  change that cannot be timed leaves the journey as it was.
- `change_journey` with `set_legs` lays out a whole route from nothing, one request per leg, compares it with TfL's first choice
  (`compared_with_tfl.this_route_arrives_minutes_later`), draws it, and with `follow_as` saves it as a followed journey.
- `follow_journey` stores the route it saves as a leg plan too, so `check` follows the traveller's own lines.

### Saved places

`remember` is the one tool for what the server keeps about its owner. `save_place` stores a label (`home`, `work`, up to 20,
lower-case, 1–20 characters) with a postcode, station, stop ID or coordinates and an optional note; `forget_place` removes one;
`set_preferences` replaces the list of avoided modes; `show` returns everything saved without touching TfL. Every result carries
`remembered`, the full saved state after the change, so no second call is needed to see it, and a field that belongs to another
action is rejected with the reason. A label passed as `from` or `to` to `plan_journey`, `show_journey` or `plan_journeys_batch`
is replaced by its place on the server, and `resolved.saved_place` in the result confirms it.
`get_context` lists the places, so a new conversation knows what "home" means. They are the model's to manage on
the user's word: there is no settings page. `src/store.ts` keeps them, with travel preferences and followed journeys, in
`DATA_DIR/owner.json` (written atomically, mode 600); without `DATA_DIR` they live in memory, and the storing tools and
`get_context` say so.

### National Rail live (Realtime Trains)

`src/rtt.ts` reads the Realtime Trains API (`data.rtt.io`, [specification](https://realtimetrains.github.io/api-specification/)).
`RTT_TOKEN` may be a refresh token or a long-life access token: the client asks `/api/get_access_token` first, keeps the 20-minute
access token it gets, and uses the token directly if that endpoint refuses it. Tokens come from https://api-portal.rtt.io.

- `live_departures` at a station with National Rail operators TfL has no live data for reads `/gb-nr/location` for the station's
  CRS code (at most two codes per board) and merges those trains in: operator as `line`/`lineName`, `platform`, `scheduled`,
  `expected`, `status` (`OnTime`, `Delayed`, `Cancelled`, `Scheduled` before the train has been seen, `NoReport`), `reason`,
  `coaches`, `service_id` and `source: realtime-trains`. Thameslink, Overground and Elizabeth line stay with TfL where TfL lists
  them. Trains that terminate, pass or call for operational reasons only are left out; `mode` is `replacement-bus` for a bus.
- `calling_at` (CRS code, 910G ID or exact name) sends `filterTo`, and the board is then Realtime Trains alone, all operators.
- `train_service` reads `/gb-nr/service` for a `service_id`.
- The allowance is 10 requests a minute, 100 an hour and 1,000 a day (October 2026). Boards and trains are cached for 60 seconds,
  a Tube line filter never spends a request, and after a 429 no request is sent until `Retry-After` has passed. A failed read
  keeps the TfL part of the board and says in `coverage_note` what is missing.

The parser follows the published OpenAPI document and its tests use responses built from it, not recorded ones. Against the
live API it has been checked by hand only (a station board with `calling_at`, and one train).

### Journey card (MCP App)

`show_journey` carries `_meta.ui.resourceUri = ui://london-transit-mcp/journey.html`; hosts that support MCP Apps read that resource
(`text/html;profile=mcp-app`, served from `apps/journey.html`) and render it beside the result. The card is one self-contained
file with no build step and no external requests. It speaks the MCP Apps postMessage protocol directly (`ui/initialize`,
`ui/notifications/tool-result`, `size-changed`, host theme and style variables), draws up to three routes as a timeline in line
colours with a countdown to departure, badges a leg whose line is disrupted, re-runs `show_journey` from its Refresh button, and
tells the model which route the user switched to (`ui/update-model-context`). All server text is set as text, never as markup.
In a host without MCP Apps the result reads as a `plan_journey` result.

`timetable` takes a station name, CRS code (`LBG`) or TfL stop/hub ID for each end, a date, `start_time`/`end_time`
(departures at or after start and before end, at most 6 hours) and an optional `operators` filter. It lists lines that call at
both stations and reads each from a pluggable source (`src/timetable.ts`), in order:

- **TfL Line Timetable** for the Tube, DLR, tram, buses, river buses and cable car: the standard timetable for that weekday,
  without engineering works or bank-holiday changes.
- **TfL Journey Planner, queried repeatedly** for National Rail, Elizabeth line and Overground, which have no Line Timetable.
  Each call returns at most 3 journeys, so a pass asks again from one minute after the last departure. The planner also hides
  a train that a later one beats or ties (London Bridge 14:10 to East Croydon via Norwood Junction arrives 14:28, as does the
  14:15 Thameslink), so extra passes force the route through one stop on each other corridor that TfL's route sequences list
  between the stations. Only single-train journeys count. Responses are cached for an hour; a rate-limited call is retried once.
  A via pass that finds nothing although the planner cut a matching train at the via stop (it preferred a faster change there)
  is retried once through another stop on that corridor (Saturday East Croydon to London Bridge needs Tulse Hill, not Selhurst).

A service counts only if one train calls at both stations: the planner leg's calling points must end at the arrival station
and TfL must name the train's terminus. Anything else is left out of `services` and the counts and listed under `unverified`.
When the planner gives a last calling point with no ID (the Elizabeth line at Liverpool Street), the leg's arrival stop or ICS
code must belong to the arrival station.
`schedule_basis` is `dated` (planner: this date, engineering works included) or `standard_weekly` (Line Timetable: the
weekday's standard timetable, labelled consistently as `Mon–Thu`, `Mon–Fri`, `Sat`, ...), or `mixed`.

The `completeness` field names the source per line, the planner calls (and how many came from cache) and passes, and any
caveat. `complete` is false if any pass stopped before `end_time` (call limit, rate limit, error), a route sequence could not
be read, a retried via pass still found nothing, or any train was left `unverified`. `operators_not_serving_both` lists named
lines that call at only one of the stations; `unknown_operators` are names matching no line at either. Each end's `matched_by` (`name`, `crs`, `stop_id`) shows how it was resolved. National Rail stations resolve to their
910G rail ID even when TfL files them under another record (Gatwick Airport is filed under the airport building 920GLGW0).
TfL gives no National Rail platforms in advance, so `platform` is null for those (the note appears only with planner services).
A date beyond the journey planner's range (about five weeks ahead) returns `invalid_travel_time`, not a TfL outage.
CRS codes map to TfL station IDs through `src/data/crs.ts`, generated from DfT NaPTAN by `scripts/make-crs-table.py`.

Journeys accept station/place names, UK postcodes, TfL stop/ICS IDs, HUB IDs or `latitude,longitude`.
A name that exactly matches a rail or Tube station (`London Bridge`) plans from that station's ICS code, and a HUB ID
becomes its interchange's ICS code; the result's `resolved` field shows the substitution.
Every tool takes names. `live_departures` resolves a station name or CRS code itself and returns candidates with their IDs when
several stops match (`src/live.ts`, `resolveLiveStop`); the planner returns candidate values when a place is ambiguous,
including rail stations and general places outside the stop-search scope. It never silently selects a candidate.
An empty result is not evidence of normal or suspended service. Batch failures stay attached to their origin.

Time parameters are `at` (an ISO timestamp **with offset**, e.g. `2026-11-10T08:00:00+00:00`)
and `time_is` (`departing` by default, or `arriving`). Omit `at` to depart now; arrive-by requires it.
The server converts the instant to Europe/London, including daylight saving, and sends TfL minute-precision times.
Returned TfL journey/leg times are London-local, not UTC; the response includes `timezone`.
`checked_at` is when the tool completed, **not** the underlying observation timestamp;
TfL responses may be cached for up to `cache_max_age_seconds` (30 seconds).
Future routes are plans, not guaranteed live departures. A station-to-station duration is not door-to-door:
use home/work postcodes to include endpoint walks. Route/leg/disruption caps expose truncation flags.

Coverage by tool:

- Journey planning, station search and line status cover the Tube, Elizabeth line, Overground, DLR, tram
  and National Rail operators (`south-western-railway`, `southern`, `thameslink`, `c2c`, ...).
  `line_status` makes one cached request for every rail line and the cable car (`london-cable-car`), defaults to London rail (Tube, Elizabeth line,
  Overground, DLR), accepts `lines` and/or `modes` (e.g. `["national-rail"]`), and lists unknown IDs back.
- Live departures cover the Tube, Elizabeth line, Overground, DLR, tram, Thameslink, buses and river buses. **TfL publishes
  no live departures for other National Rail operators** (its `/ArrivalDepartures` rejects every operator's line ID except
  `thameslink`) **or the cable car**. A station with such operators (London Bridge, Clapham Junction) gets a `coverage_note`
  naming them, a National Rail-only station says so instead of returning an empty board, and a cable car station points to
  `timetable`.
- Tube, DLR and tram come from TfL `/Arrivals` with the web board's corrections; DLR/tram copies of one train on both
  faces of a platform pair are merged, and other modes' predictions are dropped (`/Arrivals` at Farringdon's Thameslink
  station returns Elizabeth line guesses). Elizabeth line, Overground and Thameslink come from `/ArrivalDepartures`, one
  request per line the station itself serves, because `/Arrivals` invents trains at their starting stations. Those entries
  carry `scheduled`, `status` (OnTime, Delayed, Cancelled) and `reason`; `minutes` and `expected` are null when a delayed or cancelled train has no estimate: it is listed at its
  scheduled time until that passes, then after the live trains, and dropped 20 minutes later; a note counts any the limit hid.
  On every board `minutes` is worked out from `expected` against the server clock, departed trains are dropped, every entry
  carries `mode`, and `direction` filters only Tube platforms (other modes are kept and the note says so).
  Trains ending at the station are left out, and a train listed under two station records (Paddington) appears once.
- Buses and river buses come from `/Arrivals` as TfL gives them, with `mode`, the stop letter as `platform` and TfL's
  `towards` text. A bus stop cluster (`490G…`, what a stop search returns for buses) is read as its lettered stops, because `/Arrivals`
  returns nothing for a cluster; a bus predicted at two stops of one cluster or hub is shown once, at the first. A HUB board
  shows its rail lines and piers, and adds bus stops only when `line` names one of its bus routes.

`line_status` is not a future planned-closure calendar; future journey planning can include planned-work evidence.
The web app's own board and API stay Tube-only.
The tools cannot read anyone's browser-local saved stations, home address or office address.

### Login and security

How the login works: the server is its own single-owner OAuth 2.1 authorization server, with
protected resource metadata (RFC 9728) and authorization server metadata (RFC 8414) discovery,
dynamic client registration, PKCE S256 only, 1-hour access tokens and 30-day single-use refresh tokens.
The secret is typed only into the login page, so it is never in a URL, browser history or the connector list.

- There is no database. Client IDs, codes and tokens are HMAC-signed with a key derived from `MCP_SECRET`,
  so restarts keep sessions, and changing `MCP_SECRET` revokes every client and token.
- Used codes and refresh tokens are remembered in memory until they expire. A restart forgets them,
  so a code or refresh token stolen before a restart could be replayed once until it expires.
- Redirects are allowed only to the exact Claude (`claude.ai`/`claude.com` `/api/mcp/auth_callback`) and ChatGPT (`chatgpt.com/connector_platform_oauth_redirect`) callbacks and loopback `http` (local clients such as Claude Code),
  so a phishing link cannot send an authorization code anywhere else. The login page shows the client name and where it returns to.
- `MCP_SECRET` must be at least 32 characters of random text; a shorter one is refused at startup and `/mcp` stays off.
  Registering a client is open to anyone and returns a value signed with a key derived from the secret, so a guessable secret
  could be found offline without touching the login page. Length is the defence; the login rate limit is not.
- Wrong secrets are rate limited (10 failures per 15 minutes) per address, taken from the last `X-Forwarded-For` hop, which the
  nearest proxy sets. Without a proxy every client shares one bucket. The login page cannot be framed.
- Requests are capped at 64 KiB and cross-origin browser requests are rejected. CORS is not enabled.
- The stateless endpoint uses JSON POST responses; GET event streams and DELETE sessions return 405.

### Model experience

`src/mcp.ts` holds the server instructions, tool descriptions, schemas and errors; `src/context.ts` builds
`get_context`.

`get_context` returns only what tool descriptions cannot know, in about 2,700 characters on a disrupted day:

- `user`: saved places, avoided modes and any note with them, journeys being followed, and `not_durable` when the server has no
  storage directory.
- `clock`: London time with offset and the weekday.
- `feeds`: TfL (read by fetching network status) and `national_rail_live` (`not_configured`, `unverified`, `ok`, `degraded`,
  `rate_limited`, `failing`) with what each state means for answers, plus the Realtime Trains allowance.
- `network_now`: lines and operators not in good service.
- `owner_setup_pending`: `RTT_TOKEN` and `DATA_DIR` while they are unset, with where to set them.

It holds no routing or wording advice, and the server instructions no longer tell the model to call it first: they say what it
returns and when a request leans on it ("my commute", "tomorrow morning", "is everything OK"). Until 14 Nov 2026 it was a
12,000-character manual that every conversation was told to read first. Five blind tests (`bench/`) found that removing it
changed no outcome and saved about 4,000 tokens a conversation, including on a test with a returning user, a feed outage and
vague asks. What does the guiding instead:

- Tool descriptions support selection, and parameter descriptions explain how to compose a call.
- Guidance arrives in a result at the moment it applies: a failing status call says not to infer normal service, a plan
  names the faster route a saved preference hid, a leg that cannot be timed says what TfL offered.
- Anything that must hold is enforced in code: mode exclusions, saved labels, input validation, output caps, the Realtime
  Trains request budget.
