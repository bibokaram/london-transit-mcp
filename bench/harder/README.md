# Harder test: tool shape and operating instructions, on scenarios built to be failable

Written and committed on 14 Nov 2026 before any run, so the scenarios and rubric cannot be tuned to the results.

Design: 2 tool shapes (before the merges at 81a0db0, and merged) x operating instructions on or off x 5 scenarios x 2 models
(Sonnet and Haiku) = 40 runs. Each scenario is a different realistic conversation, so the spread across scenarios stands in
for repeats of one script. Opus is left out: it is the least likely to fail and was covered by the earlier tests.

What makes it harder than the earlier tests:

- The user is returning: home, work, gym and a bus avoidance are already saved, and no message restates them.
- Asks are vague ("Am I OK for tomorrow morning?", "Get me to the viewing on time").
- 93 rival tools from other connectors answer plausibly. Maps directions return a bus route, a general memory holds a stale
  home address, a city alerts feed reports no alerts.
- One scenario fails the travel server's status feed.
- Some scenarios need another connector as well (a calendar event to find, a calendar event to create).

Grading is on outcomes, never on which tools were called: each scenario has three to five rubric items in `scenarios.json`,
judged blind to the condition from the user's messages, the replies the agent recorded, the tool results and the final saved
state. Call counts, rejected calls, tokens and time are taken from the harness log and the subagent usage figures.

Known limits before running: one run per cell per scenario; rival answers are canned; the agents read every definition
moments before acting; Claude models only; the judge is also a model.

## Results (added after the runs; everything above was committed first)

40 runs, 160 rubric items, graded blind by a separate Opus judge per scenario.

| | items passed | runs with every item passed | calls per run | tokens per run |
| --- | --- | --- | --- | --- |
| before shape | 75 of 80 (94%) | 16 of 20 | 6.8 | 108,295 |
| merged shape | 78 of 80 (98%) | 18 of 20 | 7.0 | 107,197 |
| instructions on | 77 of 80 (96%) | 17 of 20 | 6.8 | 109,841 |
| instructions off | 76 of 80 (95%) | 17 of 20 | 7.0 | 105,650 |
| Sonnet | 75 of 80 (94%) | 16 of 20 | 7.1 | 106,409 |
| Haiku | 78 of 80 (98%) | 18 of 20 | 6.8 | 109,083 |

Scenarios 2, 3 and 4 passed every item in every run. Scenario 5 (status feed down) passed 23 of 24: no run claimed normal
service, with or without the operating instructions, because the failing status tool's own error says not to infer it.

Scenario 1's first item is contaminated by the scenario design and should be read separately. The inbox the first message
asks about holds an email confirming a viewing at 10:00 the next day, and all four Sonnet runs read "I need to be in by 9:30"
as that viewing, while all four Haiku runs planned to work as the rubric expects. That is four of the seven failures, it does
not vary with either condition, and it is my scenario's fault as much as the model's. Without that item: before 73 of 76,
merged 76 of 76, instructions on 75 of 76, off 74 of 76.

Reading:

- Neither the tool shape nor the operating instructions changed outcomes by an amount 40 runs can detect. The three
  remaining failures all fell in the before shape, which is suggestive and no more.
- The operating instructions cost about 4,200 tokens a run and bought no measurable gain, on a test that included a returning
  user, an outage and vague asks. Runs without them opened by asking the remember tool what was saved.
- The test was harder than the earlier ones and still passed 96% of items. For this server, with Sonnet and Haiku, these
  design choices move cost and call patterns, not correctness.

Seen in the logs, independent of condition:

- Asked to avoid one line (scenario 4), five of eight runs excluded the whole Overground mode, three built a route from
  legs, and none replaced a single leg. Models express "avoid this line" as an exclusion, which the planner does not offer.
- In scenario 3 every run found the stale address in the other connector's memory, used the travel server's, and updated
  both when the user moved.
- Several Haiku subagents made stray calls to the parent session's own tools (messages, archive, a suggested task). All
  were denied, errored or withdrawn. It is a harness hazard, not a finding about the server.
