# Configuration

The Relay and the Multica Agent runtime are separate trust domains. Relay variables belong to Vercel or EdgeOne. Agent runtime variables belong to the machine or Pod that executes the configured Multica Agent. Do not copy one environment wholesale into the other.

## Relay environment

Configure these values in the deployment platform. Put credentials and tokens in its secret store. Slack IDs and service URLs are configuration values, although storing them as secrets is also acceptable.

Slack IDs are comma-separated uppercase identifiers. `SLACK_TARGET_USER_IDS` and `SLACK_TARGET_SUBTEAM_IDS` may each be empty, but at least one of them must contain a target. Blocklists always take precedence over allowlists.

| Variable | Required | Value and source |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | Yes | Slack App → Basic Information → App Credentials → Signing Secret. |
| `SLACK_TEAM_ID` | Yes | Slack workspace ID, normally beginning with `T`. |
| `SLACK_TARGET_USER_IDS` | Conditional | User IDs whose explicit mention triggers the Relay. |
| `SLACK_TARGET_SUBTEAM_IDS` | Conditional | User Group IDs whose explicit mention triggers the Relay. |
| `SLACK_ALLOWED_CHANNEL_IDS` | Yes | Comma-separated channel IDs. Use `all` only when every channel is intentionally allowed. Missing or empty values fail closed. |
| `SLACK_BLOCKED_CHANNEL_IDS` | No | Comma-separated channel IDs that must never trigger, including when the allowlist is `all`. |
| `SLACK_ALLOWED_SENDER_IDS` | No | Comma-separated user IDs allowed to trigger. Missing or empty values mean `all`; owner-only deployments should set the exact owner ID. |
| `SLACK_BLOCKED_SENDER_IDS` | No | Comma-separated user IDs that must never trigger. |
| `SLACK_REACTION_TOKEN` | Yes | Slack user token authorized to add the acknowledgement reaction. Keep it out of Git and logs. |
| `SLACK_REACTION_NAME` | Yes | Slack emoji shortcode without colons, for example `eyes`. The reaction acknowledges Relay persistence; it does not prove Agent completion. |

The Slack App Request URL is `https://<deployment-host>/api/slack/events`. Subscribe only to the message events needed by the chosen channel types and install the App in private channels when required.

| Variable | Required | Value and source |
| --- | --- | --- |
| `MULTICA_API_BASE_URL` | Yes | HTTPS base URL of the target Multica Server, without a path suffix, query, or fragment. |
| `MULTICA_API_TOKEN` | Yes | Dedicated Multica PAT with access to the target Workspace, Project, and Agent. |
| `MULTICA_WORKSPACE_ID` | Yes | UUID of the Workspace that owns the Relay Project. |
| `MULTICA_PROJECT_ID` | Yes | UUID of the dedicated Project in which Relay Issues are created. |
| `MULTICA_AGENT_ID` | Yes | UUID of the Agent assigned to Relay Issues. The Agent must belong to the same Workspace and be bound to a Runtime. |

The Relay calls ordinary Issue and Comment APIs. It does not require a Multica Autopilot or webhook URL.

| Variable | Required | Value and source |
| --- | --- | --- |
| `KV_REST_API_URL` | Yes | HTTPS REST URL of a dedicated Upstash Redis database. |
| `KV_REST_API_TOKEN` | Yes | REST token for the same Redis database. |
| `QSTASH_URL` | No | QStash API base URL. Defaults to `https://qstash.upstash.io`. |
| `QSTASH_TOKEN` | Yes | QStash publish token. |
| `QSTASH_CURRENT_SIGNING_KEY` | Yes | Current QStash signing key used to verify deliveries. |
| `QSTASH_NEXT_SIGNING_KEY` | Yes | Next QStash signing key used during key rotation. |
| `RELAY_CONSUMER_URL` | Yes | Exact public URL `https://<deployment-host>/api/queue/consume`. It must match the URL used by QStash signature verification. |

Use a Redis database dedicated to this Relay. It stores thread mappings, locks, and write-confirmation state. QStash stores queued Slack payloads and retries failed consumers, so configure access and retention for the sensitivity of Slack message content.

## Multica Agent runtime

The Relay does not read these variables. Configure them only on the Runtime or Agent when its instructions and Slack skill require them.

| Variable | Purpose |
| --- | --- |
| `RELAY_OWNER_SLACK_USER_ID` | Identifies the owner for authorization decisions. Derive it from the verified Slack event author, not a display name. |
| `RELAY_SKILL_ROOT` | Absolute path to the approved local skill directory. It is machine-specific and does not belong in this repository. |
| `SLACK_SKILL_ALLOWED_CHANNELS` | Channel allowlist enforced by the Slack skill when it reads or replies. Keep it aligned with the Relay policy. |
| `SLACK_USER_TOKEN` | Owner user token used by the Agent's Slack skill. |
| `SLACK_TOKEN` | Compatibility variable when the Slack skill requires it. Use the intended owner identity explicitly. |
| `SLACK_BOT_TOKEN` | Leave empty when Agent replies must use the owner user identity; otherwise the Slack skill may select the Bot token first. |

The Agent does not need a separate `RELAY_ALLOWED_CHANNEL_ID`. The Relay validates Team, channel, sender, and mention policy before enqueueing and repeats the same check before consumption. Agent-side Slack access remains bounded by `SLACK_SKILL_ALLOWED_CHANNELS` and the verified event destination.

## Deployment checks

1. Run `pnpm install --frozen-lockfile`, `pnpm test`, and `pnpm lint`.
2. Deploy the same immutable commit that was tested.
3. Confirm `/api/health` responds on the production domain.
4. Confirm the Slack Request URL is verified.
5. Send one authorized Slack event and verify QStash acceptance, Multica Issue creation, the configured reaction author, Agent execution, and the final Slack thread reply as separate states.
6. Verify a blocked channel and blocked sender cause no QStash or Multica side effect.

Do not treat HTTP 200, an acknowledgement reaction, Issue creation, or a completed deployment as proof that the entire Agent reply path succeeded.
