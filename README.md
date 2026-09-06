# Slack → Multica Relay

A durable relay that accepts signed Slack Events API messages, persists them through QStash, and routes each Slack thread to a Multica Issue.

## Flow

```text
Slack
  → signature and admission checks
  → QStash durable delivery
  → Multica Issue or comment
  → configured Multica Agent
```

The relay acknowledges Slack only after QStash accepts the event. Queue consumers use Redis-backed thread mappings and message state to recover from retries without blindly repeating Multica writes.

## Admission rules

- Slack signature and timestamp must be valid.
- Team, channel and mention targets are explicit allowlists.
- Sender allowlisting is optional.
- Bot messages, edited messages and deleted messages are ignored.
- Queue consumption rechecks the current admission policy.

## Delivery behavior

- The first accepted message in a Slack thread creates a Multica Issue.
- Later messages append comments to the same Issue.
- Duplicate deliveries reuse persisted message state.
- Ambiguous Multica writes are reconciled by immutable markers before retrying.
- A successful HTTP response proves only the corresponding relay stage; downstream Agent execution and Slack delivery require separate verification.

## Local validation

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
```

Copy `.env.example` into a local environment file and provide credentials through your deployment platform's secret store. Never commit prompts, credentials, private deployment records or persona material.

The repository includes adapters for Vercel Functions and EdgeOne Cloud Functions. The shared behavior lives in `src/`.

## Source

Originally based on [winchesHe/slack-multica-relay](https://github.com/winchesHe/slack-multica-relay), with an independently maintained implementation and history.
