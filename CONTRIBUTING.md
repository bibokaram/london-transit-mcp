# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so the approach can be
agreed before you write it.

## Before you open a pull request

```bash
npm install
npm run typecheck
npm test
npm run build
```

- Tests make no network calls. Add a fixture under `test/fixtures` (see `scripts/record-fixtures.ts`) rather than
  calling TfL from a test.
- Never commit a key, a token, `MCP_SECRET`, or an `owner.json`. Use made-up or well-known public postcodes in tests
  and examples.
- A change to a tool's name, parameters or description changes how models behave. Say in the pull request what you
  expect to change and how you checked it. `bench/` shows how earlier tool-design changes were tested.
- Rules that must hold (mode exclusions, input limits, the Realtime Trains request budget) belong in code, not in tool
  descriptions.

## Scope

The project is a single-owner server for London public transport. Multi-user accounts, a database, and maps or
driving directions are out of scope.
