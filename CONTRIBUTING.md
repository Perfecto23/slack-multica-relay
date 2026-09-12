# Contributing

**English** | [简体中文](CONTRIBUTING_ZH.md)

Thanks for improving Slack → Multica Relay. Changes should preserve the project's explicit boundaries between Slack admission, queue persistence, Multica writes, Agent execution, and final Slack delivery.

## Before you start

1. Read [AGENTS.md](AGENTS.md) for repository invariants and completion criteria.
2. Read [Configuration](docs/CONFIGURATION_EN.md) when changing environment variables, deployment, or trust boundaries.
3. Read [Slack Context Assembly](docs/CONTEXT-ASSEMBLY-DESIGN_EN.md) when changing context, envelopes, markers, recovery, presentation, footers, or the delivery ledger.
4. Open a focused issue or pull request. Keep unrelated refactors separate.

Never include credentials, private Slack content, prompts, persona material, or deployment records in an issue, fixture, log, commit, or pull request. Redact sensitive reproduction data.

## Development setup

```bash
git clone https://github.com/Perfecto23/slack-multica-relay.git
cd slack-multica-relay
pnpm install --frozen-lockfile
```

Python 3 is required for the local reply-adapter tests. Live Multica or Slack credentials are not required for the deterministic test suite.

## Making a change

- Preserve the existing owner for each behavior. Protocol changes must update implementation, types, contract documentation, and the smallest meaningful regression test together.
- Keep Relay-owned task protocol out of Agent personality instructions. Keep private Runtime configuration out of this repository.
- Classify retry behavior explicitly. A successful operation whose result is unknown must not be replayed without an idempotency contract or independent readback.
- Minimize Slack data before external persistence and keep message bodies, attachment content, private URLs, and tokens out of logs.
- Minimize optional background and presentation overhead first. The root, previous persisted mention, and every subsequent current-thread message are mandatory; do not filter them by count, author, or emoji. The [context contract](docs/CONTEXT-ASSEMBLY-DESIGN_EN.md) defines limits, failures, and legacy-format compatibility.
- Avoid new dependencies, compatibility layers, and abstractions unless the current contract requires them.

## Validation

Run before opening a pull request:

```bash
pnpm test
pnpm lint
git diff --check
```

Tests should cover the changed success path and the relevant failure, retry, truncation, concurrency, or privacy boundary. Offline tests prove code contracts; they do not prove a deployment, Agent run, or user-visible Slack delivery.

For context changes, check [interval tests](tests/context-interval.test.ts), [routing recovery tests](tests/thread-router.test.ts), and [presentation compatibility tests](tests/task-presentation.test.ts): long intervals retain every message, failures do not advance the boundary, out-of-order events do not move it backward; late events preceding the first persisted request preserve the background timestamp and exclude future roots/replies; failed recovery never means “no A.” Restored historical requests carry restoredFrom, and compact presentation recovers the same request and reply destination. Worker changes also run `pnpm build:cf`. Keep private real-world samples outside the repository or in ignored directories.

For footer or model-snapshot changes, check [body preservation tests](tests/slack-message-text.test.ts) and [workerd snapshot tests](tests/reply-context-runtime.test.ts). An ordinary fetch mock cannot prove that workerd supports a RequestInit option.

## Pull requests

A pull request should explain:

- the concrete trigger and previous behavior;
- the resulting behavior and owning module;
- contract or privacy implications;
- validation performed;
- live checks that remain unverified.

Do not report HTTP 200, deployment readiness, Issue persistence, Agent completion, or Slack delivery as interchangeable evidence.
