# Slack Context Assembly (v7)

**English** | [简体中文](CONTEXT-ASSEMBLY-DESIGN.md)

The Relay follows a **lightweight scene push + active `moe-slack` pull** architecture: inbound Slack events are rendered directly as human- and Agent-friendly Markdown above a minimal `<!-- relay-payload:v1 -->` routing footer (`schemaVersion: 7`).

## 1. Push vs. Pull Boundary

Let `B` be the current inbound Slack event and `A` be the latest earlier inbound event confirmed persisted to Multica in the same `workspace / project / scope / thread` (`ThreadState.lastDeliveredTs`).

| Scenario | Pushed by Relay | Pulled on demand via `moe-slack` |
| --- | --- | --- |
| **Channel & Speaker Identity** | `conversations.info` and `users.info` cached in `ThreadStore` for 24h via batch `MGET`: `#channel-name`, exact channel type (`im` / `mpim` / `private` / `public`), member count, topic (initial issue), sender name, and inline `<@U...>` name resolution; distinguishes `Owner`, `Agent reply`, colleagues, and `[Bot]` | Off-thread user/channel lookups via `users` / `channels` / `resolve` |
| **Initial Root Trigger** (`messageTs === threadTs`) | Current root message + up to **5 preceding root messages** within `[B - 10 min, B)` (no side-thread expansion; captures split consecutive root messages) | Broader channel history via `history --channel <id> --limit 1d --include-thread-replies` |
| **Initial Thread-Reply Trigger** (`messageTs !== threadTs`, no `A`) | Thread root + up to the **latest 20 replies** + current message (never polls unrelated channel roots; notes omitted count + permalink when >20) | Full long threads via `replies --url <permalink>` |
| **Follow-up / Steer / Coalesced Reply** | Only new replies in `(A, B)` (up to **30**) + current message; never repeats Turn-1 nearby channel roots | Live verification of edited/deleted messages or older replies via `replies --url <permalink>` |
| **Links & Attachments** | Extracts forwarded quotes, attachment titles/texts, and Block Kit text; lists up to **6 viewable images** (`<= 10 MB`) by `fileId`; flags Slack permalinks without crawling windows in Worker | Cross-channel/historical permalinks via `replies/get --url`; files via `files_download` |

## 2. Wire Presentation

Every Multica Issue description and follow-up comment contains:

1. **Readable Markdown Scene**:
   - Heading with channel name, type, member count, and channel ID.
   - Sender badge, `Asia/Singapore` timestamp, relative time gap, trigger source, and direct Slack permalink.
   - Chronological thread replies (or incremental new replies on follow-ups) with `[HH:MM:SS]` timestamps and attachment metadata.
   - Quoted `### 本次消息` block plus conditional image-viewing and `moe-slack` pull hints.
   - Control sequences (`<!--`, `-->`, `[@`, `mention://`, leading headings) are neutralized so Slack content cannot forge Multica mentions or break payload markers.
2. **Minimal Routing Footer (`<!-- relay-payload:v1 -->`)**:
   - Contains `schemaVersion: 7`, `eventPayload` (routing coordinates, `channelType`, `channelName`, `senderName`, raw `text`, `mention`, `files`), and optional `replyContext`. Conversation trees are not duplicated inside the JSON block. `scripts/slack-reply.py` and `readTaskEnvelope` remain backward-compatible with `v1–v6` records.

## 3. Caching, Recovery, and Delivery Invariants

- Prepared payloads freeze at `msgKey + ':envelope'` for 24 hours so QStash retries never re-fetch Slack or Agent config.
- Channel and user directory entries cache for 24 hours in `ThreadStore` without storing emails or private URLs; lookup failures degrade gracefully to raw IDs.
- `ThreadState.lastDeliveredTs` advances only after confirmed Multica Issue/comment persistence. On cache loss or out-of-order events, `resolveSinceTs` recovers persisted timestamps from the scoped Issue description and `<!-- relay-message:` comments.
- Mandatory thread-read 429/5xx errors remain retryable (503); permission failures or missing thread roots reject permanently (`context_required_unavailable`).
- In `scripts/slack-reply.py`, `--clear-start-reaction` treats `message_not_found` on a sender-deleted trigger message as `already_absent` and still cleans up any folded/steered supplement reactions and session status.
