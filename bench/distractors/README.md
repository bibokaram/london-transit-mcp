# Does a crowd of other tools change anything?

Run 14 Nov 2026. The same ten-message script as `bench/merged-tools`, but the travel server's tools sit among 93 tools
from fifteen other connectors (`make_distractors.py`), fifth of sixteen servers in the list. The others include close
rivals: a maps server with transit directions and saved places, a notes app that says to use it "whenever the user asks
you to remember" an address, a general memory, rail tickets, and a city transit-alerts feed. Calls to them return an empty
stub and are logged. The brief does not say which connector to use, and the CLI is named `mcp`.

Eight runs: before (14 travel tools, 107 in all) and merged (10 travel tools, 103 in all), Opus and Sonnet, two repeats.

| | before, 107 tools | merged, 103 tools |
| --- | --- | --- |
| Correct final state | 4 of 4 | 4 of 4 |
| Calls to another connector | 0 | 0 |
| Rejected or invalid calls | 0 | 0 |
| Tool calls per run (mean) | 15.5 | 14.75 |
| Leg change done by replacing one leg | 2 of 4 without rebuilding the whole route | 4 of 4 |
| Agent tokens per run (mean) | 122,766 | 120,706 |
| Agent wall time (mean) | 90 s | 86 s |

Against the same script with no other tools (`bench/merged-tools`): calls per run were 15.5 and 14.25, so the crowd changed
nothing measurable. Tokens rose by about 13,000 in both shapes, which is the cost of reading the extra definitions.

Reading: at about a hundred tools, with these models and this script, there is no sign of an attention cost to having more
tools, in either shape. Not one of 122 calls went to a rival. Five runs said why without being asked about it directly: the
travel server's own instructions told them to call its operating instructions first and that saved places belong to it, and
they followed that over the rivals' descriptions. The only effect of merging that repeats across both tests is within the
server: with separate change and build tools, half the runs rebuilt a whole route to change one leg; with one tool, none did.

Limits: two repeats per cell; rival tools returned nothing, so a run that tried one would have come back; the agents read
every definition moments before acting, where a real client may defer or truncate tool lists; one script, Claude models only.
