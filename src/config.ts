import type { ApiConfig } from "./multica-api.js";

export interface RelayConfig extends ApiConfig {
  signingSecret: string;
  teamId: string;
  targetUserIds: Set<string>;
  targetSubteamIds: Set<string>;
  cancelKeywords: Set<string>;
  newSessionKeywords: Set<string>;
  wakePatterns: string[];
  implicitThreadFollowup: boolean;
  implicitThreadMaxSilentTurns: number;
  implicitGroupHotWindowSeconds: number;
  selfDmChannelIds: Set<string>;
  allowEditMentionWake: boolean;
  controlUserIds: Set<string>;
  slackStatusToken?: string;
  allowedChannelIds: Set<string>;
  allowAllChannels: boolean;
  blockedChannelIds: Set<string>;
  allowedSenderIds: Set<string>;
  allowAllSenders: boolean;
  blockedSenderIds: Set<string>;
  slackReactionToken: string;
  slackContextToken: string;
  slackReactionName: string;
  /** Optional second reaction marking a message that waits behind an active run. */
  slackQueuedReactionName?: string;
  /** Optional reaction marking a steered follow-up waiting to be read by the running turn. */
  slackSteerPendingReactionName?: string;
  /** Optional reaction marking a steered follow-up after the running turn has read it. */
  slackSteerReadReactionName?: string;
  /** Optional reaction marking that the agent's local runtime is currently offline/asleep. */
  slackOfflineReactionName?: string;
  /** Optional reaction acknowledging a `!new` / thread reset command without prompt text. */
  slackResetReactionName?: string;
  /** Agent whose active runs make a new message wait: the assignee itself, or a squad's leader. */
  multicaQueueAgentId?: string;
  /** Optional QStash publish delay (0..15s) to coalesce rapid consecutive posts. */
  dispatchDelaySeconds: number;
  /** Optional watchdog delay (0..3600s) to clear stuck reactions if a local run fails or is cancelled. */
  watchdogDelaySeconds: number;
  /** Optional Slack channel/DM ID (e.g. owner Bot DM) to notify when the watchdog detects a failed run. */
  slackAlertChannelId?: string;
  kvRestApiUrl: string;
  kvRestApiToken: string;
  queueUrl: string;
  queueToken: string;
  queueCurrentSigningKey: string;
  queueNextSigningKey: string;
  consumerUrl: string;
}

export function loadRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  const allowedChannels = policyIds(required(env, "SLACK_ALLOWED_CHANNEL_IDS"));
  const blockedChannelIds = ids(env.SLACK_BLOCKED_CHANNEL_IDS);
  const allowedSenders = policyIds(env.SLACK_ALLOWED_SENDER_IDS || "all");
  const blockedSenderIds = ids(env.SLACK_BLOCKED_SENDER_IDS);
  const targetUserIds = ids(env.SLACK_TARGET_USER_IDS);
  const targetSubteamIds = ids(env.SLACK_TARGET_SUBTEAM_IDS);
  if (!targetUserIds.size && !targetSubteamIds.size)
    throw new Error("missing_mention_target");
  const type = env.MULTICA_ASSIGNEE_TYPE?.trim() || "agent";
  if (type !== "agent" && type !== "squad") throw new Error("invalid_assignee_type");
  const targetId = env.MULTICA_ASSIGNEE_ID?.trim() || (type === "agent" ? env.MULTICA_AGENT_ID?.trim() : undefined);
  if (!targetId) throw new Error("relay_not_configured");
  const legacy = env.MULTICA_LEGACY_AGENT_ID?.trim() || undefined;
  const scope = env.MULTICA_THREAD_SCOPE_ID?.trim() || undefined;
  const legacySquad = env.MULTICA_LEGACY_SQUAD_ID?.trim() || undefined;
  if (legacy && (type !== "squad" || scope !== legacy)) throw new Error("invalid_migration_scope");
  if (legacySquad && (type !== "agent" || (scope ?? targetId) !== targetId)) throw new Error("invalid_migration_scope");
  const queuedReaction = emojiName(env.SLACK_QUEUED_REACTION_NAME);
  const offlineReaction = emojiName(env.SLACK_OFFLINE_REACTION_NAME);
  return {
    signingSecret: required(env, "SLACK_SIGNING_SECRET"),
    teamId: required(env, "SLACK_TEAM_ID"),
    allowedChannelIds: allowedChannels.ids,
    allowAllChannels: allowedChannels.all,
    blockedChannelIds,
    allowedSenderIds: allowedSenders.ids,
    allowAllSenders: allowedSenders.all,
    blockedSenderIds,
    targetUserIds,
    targetSubteamIds,
    cancelKeywords: keywordSet(env.SLACK_CANCEL_KEYWORDS, ["cancel", "取消"]),
    newSessionKeywords: keywordSet(env.SLACK_NEW_SESSION_KEYWORDS, ["!new", "!fresh", "重开"]),
    wakePatterns: wakePatternList(env.SLACK_WAKE_PATTERNS),
    implicitThreadFollowup: boolFlag(env.SLACK_IMPLICIT_THREAD_FOLLOWUP, false),
    implicitThreadMaxSilentTurns: boundedInt(env.SLACK_IMPLICIT_THREAD_MAX_SILENT, 3, 0, 20),
    implicitGroupHotWindowSeconds: boundedInt(env.SLACK_IMPLICIT_GROUP_HOT_WINDOW_SECONDS, 0, 0, 86400),
    selfDmChannelIds: ids(env.SLACK_SELF_DM_CHANNEL_IDS),
    allowEditMentionWake: boolFlag(env.SLACK_EDIT_MENTION_WAKE, true),
    controlUserIds: env.SLACK_CONTROL_USER_IDS === undefined ? targetUserIds : ids(env.SLACK_CONTROL_USER_IDS),
    slackStatusToken: env.SLACK_STATUS_TOKEN?.trim() || undefined,
    multicaApiBaseUrl: https(required(env, "MULTICA_API_BASE_URL")),
    multicaApiToken: required(env, "MULTICA_API_TOKEN"),
    multicaWorkspaceId: required(env, "MULTICA_WORKSPACE_ID"),
    multicaProjectId: required(env, "MULTICA_PROJECT_ID"),
    multicaAssigneeType: type,
    multicaAssigneeId: targetId,
    multicaThreadScopeId: scope,
    multicaLegacyAgentId: legacy,
    multicaLegacySquadId: legacySquad,
    multicaCheckRuntimeOnline: Boolean(offlineReaction),
    slackReactionToken:
      env.SLACK_BOT_TOKEN?.trim() || required(env, "SLACK_USER_TOKEN"),
    slackContextToken: required(env, "SLACK_CONTEXT_TOKEN"),
    slackReactionName: required(env, "SLACK_REACTION_NAME").replace(
      /^:+|:+$/gu,
      "",
    ),
    slackQueuedReactionName: queuedReaction,
    slackSteerPendingReactionName:
      emojiName(env.SLACK_STEER_PENDING_REACTION_NAME) ?? queuedReaction,
    slackSteerReadReactionName: emojiName(env.SLACK_STEER_READ_REACTION_NAME),
    slackOfflineReactionName: offlineReaction,
    slackResetReactionName: emojiName(env.SLACK_RESET_REACTION_NAME) ?? "sparkles",
    multicaQueueAgentId: env.MULTICA_QUEUE_AGENT_ID?.trim() || (type === "agent" ? targetId : undefined),
    dispatchDelaySeconds: boundedInt(env.SLACK_DISPATCH_DELAY_SECONDS, 0, 0, 15),
    watchdogDelaySeconds: boundedInt(env.SLACK_WATCHDOG_DELAY_SECONDS, 0, 0, 3600),
    slackAlertChannelId: optionalSlackId(env.SLACK_ALERT_CHANNEL_ID),
    kvRestApiUrl: https(required(env, "KV_REST_API_URL")),
    kvRestApiToken: required(env, "KV_REST_API_TOKEN"),
    queueUrl: https(env.QSTASH_URL?.trim() || "https://qstash.upstash.io"),
    queueToken: required(env, "QSTASH_TOKEN"),
    queueCurrentSigningKey: required(env, "QSTASH_CURRENT_SIGNING_KEY"),
    queueNextSigningKey: required(env, "QSTASH_NEXT_SIGNING_KEY"),
    consumerUrl: https(required(env, "RELAY_CONSUMER_URL")),
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error("relay_not_configured");
  return value;
}

function ids(value: string | undefined): Set<string> {
  const values = (value ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (values.some((x) => !/^[A-Z][A-Z0-9]+$/u.test(x)))
    throw new Error("invalid_identifier");
  return new Set(values);
}

function optionalSlackId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Z][A-Z0-9]+$/u.test(trimmed)) throw new Error("invalid_identifier");
  return trimmed;
}

function policyIds(value: string): { ids: Set<string>; all: boolean } {
  const normalized = value.trim();
  if (normalized.toLowerCase() === "all") return { ids: new Set(), all: true };
  const parsed = ids(normalized);
  if (!parsed.size) throw new Error("invalid_allowlist");
  return { ids: parsed, all: false };
}

function https(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error("invalid_service_url");
  return value.replace(/\/+$/u, "");
}

function emojiName(value: string | undefined): string | undefined {
  const name = value?.trim().replace(/^:+|:+$/gu, "");
  return name && /^[a-z0-9_+-]+$/u.test(name) ? name : undefined;
}

function keywordSet(value: string | undefined, defaults: readonly string[]): Set<string> {
  if (value !== undefined && value.trim() === "none") return new Set();
  const keywords = (value ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return new Set(keywords.length ? keywords : defaults);
}

function wakePatternList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 64);
}

function boolFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "off") return false;
  return fallback;
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/u.test(trimmed)) throw new Error("invalid_integer_config");
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < min || parsed > max) throw new Error("invalid_integer_config");
  return parsed;
}
