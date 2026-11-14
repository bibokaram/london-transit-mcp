# Remember tools: three tools or one

Compares `REMEMBER_TOOLS=split` (`save_place`, `forget_place`, `set_travel_preferences`) with `combined` (one `remember` tool
with an `action`). Run 14 Nov 2026.

- `server.mts` stands in for an MCP client connection: one isolated server per session, variant chosen by `sessions.json`
  (session IDs are opaque so the agent cannot tell which variant it has), TfL responses shared for ten minutes, every call
  logged to `calls.jsonl`. Start it from the repo root with `NODE_USE_ENV_PROXY=1 npx tsx bench/remember/server.mts`.
- `tube <session> list` and `tube <session> call <tool> '<json>'` are what a test agent uses.
- `score.py` reads the log and the final stored state.

Each agent handled the same eight user messages in order (save home and work, avoid buses, "what have you got saved", move
home, a one-off "no tube today" trip, forget work, "buses fine, no cable car", save the gym and plan to it). Eight runs: two
variants, Opus and Sonnet, two repeats.

| | split | combined |
| --- | --- | --- |
| Correct final state | 4 of 4 | 4 of 4 |
| Wrong or rejected remember calls | 0 | 0 |
| Tool calls per run | 10 to 12 | 11 to 12 |
| Agent tokens per run (mean) | 98,851 | 97,269 |
| Agent wall time (mean) | 54 s | 52 s |
| Definitions of the remember tools | 3,758 chars | 3,192 chars |

No difference the test can see: the script was too easy to separate them, and two repeats per cell is too few to read the
small gaps. Known flaw: the tool list was longer than the agents' terminal showed, so seven read it from the saved output
file and one guessed the argument names.

What all eight runs did show, independent of the variant:

- An explicit `exclude_modes` replaces the saved preference, so every agent re-added the saved mode by hand, and every one
  flagged it as unclear.
- There is no light way to read back what is saved; six runs re-read the whole operating instructions (about 11,600
  characters) to answer "what have you got saved".
- "How do I get there, leaving now" was planned by six runs and tracked by two; the guidance does not separate them.
- Three of four Opus runs carried "no tube today" into a 6pm trip the same day.
- A place saved as "Liverpool Street station" was ambiguous when later used; saving does not check that a place resolves.

## Outcome

Combined was adopted on 14 Nov 2026 and the split tools and the `REMEMBER_TOOLS` switch were removed, so this harness now only
runs the combined variant; commit 22de2c8 has both. The first two gaps were fixed in the same change: `exclude_modes` adds to
the saved preference (with `ignore_preference` to lift it once), and `remember` gained a `show` action and returns the full
saved state with every result.
