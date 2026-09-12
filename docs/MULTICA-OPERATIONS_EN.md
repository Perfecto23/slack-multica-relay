# Multica Operations

**English** | [简体中文](MULTICA-OPERATIONS.md)

Use this document when operating the live Multica Workspace, Agent, Project, Issue, run, Skill, or Runtime connected to the Slack Relay. Ordinary code changes do not require it.

## Pin the target

1. Run `multica --help` and the target subcommand's `--help`; the installed CLI version is authoritative.
2. Use `list/get` to verify complete UUIDs, the Workspace, and related objects. The current directory, a same-named object, or an old message is not identity evidence.
3. Pass the verified `--workspace-id` explicitly on every call. When using `--server-url` or `--profile`, keep it fixed for the entire operation. Do not change global defaults for a one-off task.
4. Use `--output json` for structured reads. Follow the response's cursor, `has_more`, or offset contract for complete listings. Never parse truncated table IDs or mix stderr into JSON.

Diagnose a missing CLI, authentication failure, or unavailable capability before continuing. The browser is not the default configuration interface.

## Common reads

| Purpose | Command, with the verified Workspace arguments |
| --- | --- |
| Agent | `agent list` / `agent get <id>` |
| Project | `project list` / `project get <id>` |
| Issue | `issue list` / `issue get <id>` / `issue search <query>` |
| Issue comments | Locate with `issue comment list <issue-id> --roots-only --summary`, then read the selected root in full with `--thread <comment-id> --tail 0` |
| Execution history | `issue runs <issue-id>` |
| Messages from one execution | `issue run-messages <task-id>` |
| Runtime | `runtime list` |
| Agent, Skill, or Workspace configuration | Read the relevant `--help`, then use the command supported by the installed CLI |

An Issue is a task record; a run is one execution. `run-messages` accepts the execution task ID. The Agent name field is `name`; a Project uses `title`.

Lists may be arrays or paginated objects containing `issues`, `has_more`, and `offset`. Follow the actual JSON shape instead of treating an object as an empty list. Use `--summary` only for discovery; verify envelopes from complete target content. Attachment ownership requires `source_task_id`, so do not use `--compact` when checking that field.

## Verify Relay context

1. Read the Issue description for a first request. For a follow-up, locate the `relay-message` root comment and read its complete content. An Agent response is separate from the triggering comment.
2. Match the eventPayload team, channel, thread, and message timestamp to the Slack request. New events use `schemaVersion: 5`; retries of already frozen events may retain an older version.
3. For first mentions, check the complete current thread and the 30-minute / 12-root / 2-thread / 5-reply nearby scope. When an earlier persisted mention exists, check sinceTs, root, that mention, and every intervening message. Successful required recovery with no earlier mention omits sinceTs and reads from root. Late requests retain the original initialCutoffTs and exclude background roots/replies later than the current request.
4. Compact lines preserve text, author, and thread relationships. currentRequest references eventPayload without repeating its body. `restoredFrom: persisted_request` identifies a historical request restored rather than fetched from Slack in this read. A not_loaded attachment is not read content, and a missing-background marker is not complete history.
5. Verify read scope in relay_context and persistence in relay_dispatch, then inspect the run and original Slack reply independently. An existing Issue does not prove delivery of the current request.

`context_required_page_limit`, `context_required_unavailable`, and `context_request_too_large` reject dispatch because required context could not be delivered completely; the previous boundary remains. Temporary 429, 5xx, and timeout failures use bounded retries. Never clear Redis or delivery ledgers to force a resend. See [Slack Context Assembly](CONTEXT-ASSEMBLY-DESIGN_EN.md) for the full contract.

For footerOmitted messages, compare body sections in original Slack blocks rather than demanding equality with footer-bearing fallback text. replyContext.status=unavailable and the model in execution statistics are separate evidence. Investigate Worker request mode, upstream status, and identity validation before inferring execution failure. For style-read failures, verify the actual private styleGuide and SKILLS.md index paths.

## Updating Agent configuration

Recovery API failures and corrupt state do not fall back to “no previous mention.” Handle the actual error class instead of changing Agent configuration to bypass recovery failures.

1. Use `agent get` to pin the Agent and complete current configuration. Change only authorized fields.
2. `--instructions` replaces the entire document. Keep the complete candidate outside the repository and preserve current rules outside the requested scope.
3. Pass multiline content to the CLI through a program argument array rather than shell interpolation. Credentials never belong in instructions or argv.
4. Read back the target fields using the same server, Workspace, and Agent ID. If the write result is unknown, inspect current state before attempting another write.
5. Read back the complete Skill-binding list after a binding change. Model, reasoning effort, and service tier must be supported by the target Runtime.

Saved configuration, deployment readiness, Issue/comment persistence, Agent completion, and Slack reply delivery are separate states. A read-only verification must not trigger an Agent task.
