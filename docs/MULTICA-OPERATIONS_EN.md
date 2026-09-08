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
| Execution history | `issue runs <issue-id>` |
| Messages from one execution | `issue run-messages <task-id>` |
| Runtime | `runtime list` |
| Agent, Skill, or Workspace configuration | Read the relevant `--help`, then use the command supported by the installed CLI |

An Issue is a task record; a run is one execution. `run-messages` accepts the execution task ID. The Agent name field is `name`; a Project uses `title`.

## Updating Agent configuration

1. Use `agent get` to pin the Agent and complete current configuration. Change only authorized fields.
2. `--instructions` replaces the entire document. Keep the complete candidate outside the repository and preserve current rules outside the requested scope.
3. Pass multiline content to the CLI through a program argument array rather than shell interpolation. Credentials never belong in instructions or argv.
4. Read back the target fields using the same server, Workspace, and Agent ID. If the write result is unknown, inspect current state before attempting another write.
5. Read back the complete Skill-binding list after a binding change. Model, reasoning effort, and service tier must be supported by the target Runtime.

Saved configuration, deployment readiness, Issue/comment persistence, Agent completion, and Slack reply delivery are separate states. A read-only verification must not trigger an Agent task.
