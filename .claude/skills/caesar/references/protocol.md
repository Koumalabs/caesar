# The contract, condensed

OACP — Orchestrator–Agent Contract Protocol, version `1`, documents `caesar.task/v1`,
`caesar.report/v1`, `caesar.event/v1`.

The contract rests on the **file system**, not on an SDK. No library is required: any program that
can read and write JSON can act as a sub-agent. That is deliberate — a standard that demands a
dependency is adopted only by the people who wrote it.

## The task directory

One directory per task, its path passed as `$CAESAR_TASK_DIR`:

| File | Meaning | Written by |
|---|---|---|
| `task.json` | the mission | orchestrator |
| `report.json` | the account of the work | agent |
| `events.jsonl` | progress stream, one JSON object per line, append-only | agent or adapter |
| `raw.log` | raw process output, for diagnosis | orchestrator |
| `questions/<id>.json` | a question asked through the optional back-channel | agent |
| `answers/<id>.json` | the answer to that question | orchestrator |

`questions/` and `answers/` exist only when the task uses the back-channel. Nothing is shared in
memory between the agent's process and the orchestrator's — the channel is these files.

## Environment

The minimal contract is **two variables**: `CAESAR_TASK_FILE` to read the mission, `CAESAR_REPORT_PATH`
to write the account. An agent that honours only those two is orchestrable.

The rest are conveniences: `CAESAR_TASK_DIR`, `CAESAR_EVENTS_PATH`, `CAESAR_TASK_ID`, `CAESAR_AGENT`,
`CAESAR_DEPTH` (delegation depth — `0` for the top-level agent; this is what makes `max_depth` apply
beyond the first level), `CAESAR_PROTOCOL_VERSION`.

## `task.json`

Carries `objective`, `context`, `constraints`, `acceptance_criteria`, plus the decisions already
taken: `mode` (`read-only` / `write`), `isolation` (`inplace` / `worktree`), `network`, `workspace`,
`base_ref` (in worktree isolation, the starting SHA), `deadline_ms`, `depth`, `report_path`,
`events_path`, and `channel` when the back-channel is available.

`network` is a **result, not a request**: the orchestrator has already reconciled what was asked with
what the chosen provider allows. At `false` it asserts the network is cut, and the brief tells the
agent so. A provider whose confinement the orchestrator does not control receives `true`, for lack of
being able to claim otherwise.

## `report.json`

Only three fields are required — `protocol`, `status`, `summary`. Everything else has a default: a
minimal report is valid.

```jsonc
{
  "protocol": "caesar.report/v1",
  "status": "success",          // success | partial | failed | blocked
  "summary": "Two files fixed, tests pass."
}
```

The optional fields are `task_id`, `details`, `changes`, `commands_run`, `findings`, `questions`,
`next_steps`, `artifacts`, `usage`.

Status meanings:

- **`success`** — the acceptance criteria are met.
- **`partial`** — part of the work is done; what remains is described in `next_steps`.
- **`failed`** — the agent did not get there and has no way forward.
- **`blocked`** — a decision outside its scope is required, and is stated in `questions`.

`changes` is the agent's declaration. When the task's workspace is a git repository — in `worktree`
and `inplace` isolation alike — the orchestrator reconciles it against the observed git state, **which
alone is authoritative**. Outside a git repository no reconciliation is possible and `changes` stays a
bare claim; the normalized report carries that distinction.

Two properties of the reconciliation, because the worktree is a workshop where the sub-agent installs,
runs and verifies:

- **The diff is taken against `base_ref`, never against `HEAD`.** An agent that commits its work would
  move `HEAD` onto its own commit, and a diff against `HEAD` would come back empty.
- **What the orchestrator placed itself is excluded** — paths materialized from `[worktree]`
  `copy`/`link`, with prefix semantics.

## `events.jsonl`

One JSON object per line, append-only, each line self-sufficient. Types: `started`, `thinking`,
`message`, `tool_use`, `file_changed`, `progress`, `question`, `answer`, `error`, `finished`.

Emitting events is **optional** — an agent that only writes its final report is perfectly conformant,
but it will be literally invisible while it works. For `tool_use`, emit the `started` event and not
only the outcome: a tool reported once finished teaches nothing while it runs, which is exactly when
someone is watching.

## How the report is recovered

Four tiers are attempted, from most to least reliable; the best one the agent can honour is kept:

1. **MCP back-channel** — the agent calls the `submit_report` tool, validated on the spot.
2. **Native schema** — the provider constrains its final answer (`codex --output-schema`,
   `agy --json-schema`).
3. **File contract** — the agent writes `$CAESAR_REPORT_PATH`. This is the universal tier, the one
   outside agents use.
4. **Degraded** — the orchestrator looks for a ```` ```json caesar:report ```` block in the output,
   failing that any JSON object declaring itself a report, and as a last resort synthesizes an account
   from `raw.log` and the git diff.

## The optional back-channel

When the task carries channel coordinates, an MCP server is reachable during execution and exposes
four tools: `get_task` (re-read the mission), `report_progress`, `ask_orchestrator` (ask a question and
**wait** for the answer), `submit_report`. A provider that cannot load an MCP server simply ignores the
field.

`ask_orchestrator` writes `questions/<id>.json` and polls for `answers/<id>.json`, for at most five
minutes by default and never beyond the task's remaining deadline. With no answer in that window the
call returns normally — not an error — inviting the agent to proceed on its best judgment rather than
wait forever. Answering an unknown or already-answered question fails explicitly rather than writing
silently.

## A conformant agent in ten lines

```bash
#!/usr/bin/env bash
objective=$(jq -r .objective "$CAESAR_TASK_FILE")

# … do the work …

jq -n --arg s "Handled: $objective" '{
  protocol: "caesar.report/v1",
  status: "success",
  summary: $s
}' > "$CAESAR_REPORT_PATH"
```

Declared under `[[agent]]` in `.caesar/config.toml`, it is orchestrable on the same footing as any
catalogue provider:

```toml
[[agent]]
id = "my-agent"
bin = "my-agent.sh"
args = ["{{prompt}}"]
```

The substituted tokens are `{{prompt}}`, `{{workspace}}`, `{{taskDir}}`, `{{reportPath}}` and
`{{model}}`. A token with no value removes its whole argument rather than leaving a residue;
`{{prompt}}` is mandatory, since without it the CLI never receives the objective. `cwd_mode`
(`process` / `flag`) says whether the workspace is the process's working directory or already carried
by a token in `args`. See `references/config.md` for the other fields.

## Executable schemas

The schemas are authoritative as code, and publishable as JSON Schema:

```bash
caesar protocol schema report          # JSON Schema of the report
caesar protocol schema report --strict # variant for native structured outputs
caesar protocol schema task
caesar protocol schema event
```

The `protocol` field carries each document's version. A reader that meets an unknown version must
refuse explicitly rather than interpret as best it can.
