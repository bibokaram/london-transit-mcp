# Does the "call my instructions first" rule keep the model on this server?

Run 14 Nov 2026. `bench/distractors` found that 93 rival tools pulled no calls away, and several agents credited the travel
server's instructions. This run removes them: the operating-instructions tool is hidden, every mention of it is scrubbed from
the other descriptions, and the server's instructions are one line like every rival's ("Journey planning, timetables, live
departures and line status for London public transport."). Same 93 rivals, same ten messages, eight runs.

| | before shape, no anchor | merged shape, no anchor |
| --- | --- | --- |
| Correct final state | 4 of 4 | 4 of 4 |
| Calls to another connector | 0 | 0 |
| Rejected or invalid calls | 0 | 0 |
| Tool calls per run (mean) | 16.25 | 13.75 |
| Leg change done without rebuilding the route | 3 of 4 | 4 of 4 |
| Agent tokens per run (mean) | 117,260 | 115,932 |
| Agent wall time (mean) | 92 s | 84 s |

With the anchor (`bench/distractors`) the same cells were 15.5 and 14.75 calls and 122,766 and 120,706 tokens.

Reading: the anchor explanation was wrong. Without it, still not one of 119 calls went to a rival, and every run finished
correctly. Asked why, the agents said the travel server's remember tool is the one whose labels feed its planning tools: the
tool descriptions were enough. Removing the operating instructions also saved about 5,000 tokens a run and cost nothing this
script could detect.

What that does not show: the script starts with nothing saved and never needs what the operating instructions uniquely carry
(what is already saved, which feed is down, what is disrupted now). Three planning calls hit an ambiguous saved place in this
run against none with the anchor, which may or may not be related. A returning-user script is the fair test of the
instructions' value. Two repeats per cell; Claude models only.
