# Fifteen tools or ten

Compares the tool list before and after three merges, run 14 Nov 2026.

- before (commit 81a0db0, 14 tools without a Realtime Trains token): `track_journey`, `check_journey`, `end_journey`,
  `change_leg`, `build_journey`, `find_stop`, and `live_departures` taking only a stop ID.
- merged (10 tools): `follow_journey` (start, check, end), `change_journey` (replace_leg, insert_leg, remove_leg, set_legs),
  and `live_departures` taking a name, CRS code or ID.

`server.mts` serves both shapes side by side (the before shape from a git worktree of 81a0db0, whose path is hard-coded),
one isolated server per session, blind session IDs, every call logged to `calls.jsonl`. The tool list is paged so each
page fits in an agent's terminal. `prompt.txt` is the brief: ten user messages covering saving places and a preference,
a live board by name, planning, changing a leg and following it, checking progress, line status, a one-off exclusion,
ending, forgetting and reading back. Eight runs: two shapes, Opus and Sonnet, two repeats.

| | before | merged |
| --- | --- | --- |
| Correct final state | 4 of 4 | 4 of 4 |
| Rejected or invalid calls | 1 | 0 |
| Tool calls per run (mean) | 15.5 | 14.25 |
| Stop lookups before a live board | 7 across the runs | 0 |
| Leg change done by replacing one leg | 2 of 4 (Opus rebuilt the whole route twice) | 4 of 4 |
| Agent tokens per run (mean) | 107,845 | 108,556 |
| Agent wall time (mean) | 92 s | 88 s |
| Instructions and definitions | 42,333 chars | 38,546 chars |

Accuracy is the same and tokens are the same within noise; the merged shape makes fewer calls and steered every run to the
cheap leg change. Two repeats per cell is too few to read small gaps.

What the runs exposed, in both shapes:

- "I'm setting off now" follows the route at the plan's departure time, so a check says not started.
- A check keeps suggesting the route the user deliberately moved away from.
- Results for changed and followed journeys show nothing excluded although a saved preference exists.
- Nothing says whether a one-off exclusion mid-trip should change the journey being followed; the runs split four ways.
- The live board cannot be filtered by mode, so "no tube today" was applied by hand.
- Leg numbers were described as counting walking legs but follow `leg_plan`; one run hit it. Fixed in the description.
- "Offer to save" in the instructions contradicted "save when told" in the tool. Fixed.
