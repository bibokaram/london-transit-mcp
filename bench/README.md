# Tool-design tests

Five blind tests of how the MCP tools are shaped, 72 runs in all. Each folder has the harness (`server.mts`), the prompt or
scenarios given to the test agents, the scoring script, and a README with the method, the numbers and the limits.

| Folder | Question |
| --- | --- |
| `remember` | Three tools for saved places and preferences, or one with an action? |
| `merged-tools` | Fifteen tools or ten, on a harder script |
| `distractors` | The same comparison among about 100 unrelated tools |
| `no-anchor` | Does telling the model to read an operating manual first change anything? |
| `harder` | Five realistic conversations, with the manual on and off, graded blind |

The raw call logs and per-run score files are not published: they record full journey results for the test addresses. The
scoring scripts read `calls.jsonl`, which a harness writes when you run it. The postcodes in the prompts and scenarios were
replaced with well-known public ones after the runs, so a rerun plans different routes from the ones the READMEs describe.
Some harnesses write their log to an absolute path set at the top of `server.mts`; change it before running.
