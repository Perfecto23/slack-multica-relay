import {
  CONVERSATIONAL_SUBTYPES,
  findTargetMention,
  type MentionMatch,
  type SlackMessageEvent,
} from "./mentions.js";

export type TriggerSource =
  | "native_stop"
  | "implicit_thread"
  | "wake_pattern"
  | "edit_mention";

export type InboundOperation =
  | "dispatch"
  | "cancel"
  | "new_session"
  | "steer_ack"
  | "watchdog";

export interface InboundPolicyConfig {
  teamId: string;
  targetUserIds: ReadonlySet<string>;
  targetSubteamIds: ReadonlySet<string>;
  controlUserIds: ReadonlySet<string>;
  slackStatusToken?: string;
  allowedChannelIds: ReadonlySet<string>;
  allowAllChannels: boolean;
  blockedChannelIds: ReadonlySet<string>;
  allowedSenderIds: ReadonlySet<string>;
  allowAllSenders: boolean;
  blockedSenderIds: ReadonlySet<string>;
  cancelKeywords: ReadonlySet<string>;
  newSessionKeywords: ReadonlySet<string>;
  wakePatterns: readonly string[];
  implicitThreadFollowup: boolean;
  allowEditMentionWake: boolean;
}

export interface QueuedEventSummary {
  teamId: string;
  channelId: string;
  senderUserId: string;
  messageTs: string;
  threadTs: string;
  text: string;
  operation?: InboundOperation;
  trigger?: TriggerSource;
}

export interface NormalizedInboundCandidate {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  senderUserId: string;
  text: string;
  files?: unknown;
  rawForFingerprint: Record<string, unknown>;
  mention: MentionMatch;
  operation: "dispatch" | "cancel" | "new_session";
  trigger?: TriggerSource;
  requiresActiveThread: boolean;
}

export type InboundEvaluation =
  | { admitted: true; candidate: NormalizedInboundCandidate }
  | { admitted: false; reason: string; invalid?: boolean };

const BROADCAST_MENTION = /<!(?:channel|here|everyone)(?:\|[^>]+)?>/u;
const LEADING_USER_MENTION = /^\s*<@([A-Z0-9]+)(?:\|[^>]+)?>/u;
const LEADING_SUBTEAM_MENTION = /^\s*<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function extractSupplementalText(
  raw: Record<string, unknown>,
  baseText: string,
): string {
  const extras: string[] = [];
  if (Array.isArray(raw.attachments)) {
    for (const item of raw.attachments) {
      if (!isRecord(item)) continue;
      const shared =
        typeof item.text === "string" && item.text.trim()
          ? item.text.trim()
          : item.is_share === true &&
              typeof item.fallback === "string" &&
              item.fallback.trim()
            ? item.fallback.trim()
            : "";
      if (!shared || baseText.includes(shared)) continue;
      const quoted = shared
        .slice(0, 4096)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      extras.push(quoted);
      if (extras.length >= 3) break;
    }
  }
  return extras.length ? `${baseText}\n${extras.join("\n")}`.trim() : baseText;
}

export function matchesWakePattern(
  text: string,
  patterns: readonly string[],
): string | undefined {
  if (!patterns.length || !text) return undefined;
  const hay = text.toLowerCase();
  for (const raw of patterns) {
    const needle = raw.trim().toLowerCase();
    if (!needle) continue;
    if (/^[a-z0-9_-]+$/u.test(needle)) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      if (
        new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, "iu").test(text)
      ) {
        return raw.trim();
      }
    } else if (hay.includes(needle)) {
      return raw.trim();
    }
  }
  return undefined;
}

export function isAddressedToOtherUser(
  text: string,
  targetUserIds: ReadonlySet<string>,
): boolean {
  const match = LEADING_USER_MENTION.exec(text);
  return !!match && !targetUserIds.has(match[1]!);
}

/** Strip only leading target mentions / wake phrases so mid-sentence mentions remain intact. */
export function stripLeadingAddressingPrefix(
  text: string,
  config: Pick<
    InboundPolicyConfig,
    "targetUserIds" | "targetSubteamIds" | "wakePatterns"
  >,
): string {
  let rest = text.trim();
  for (let guard = 0; guard < 6 && rest; guard++) {
    const userMatch = LEADING_USER_MENTION.exec(rest);
    if (userMatch && config.targetUserIds.has(userMatch[1]!)) {
      rest = rest.slice(userMatch[0].length).replace(/^[,，:：\s]+/u, "");
      continue;
    }
    const subMatch = LEADING_SUBTEAM_MENTION.exec(rest);
    if (subMatch && config.targetSubteamIds.has(subMatch[1]!)) {
      rest = rest.slice(subMatch[0].length).replace(/^[,，:：\s]+/u, "");
      continue;
    }
    let matchedWake = false;
    for (const raw of config.wakePatterns) {
      const needle = raw.trim();
      if (!needle) continue;
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const boundary = /^[a-z0-9_-]+$/iu.test(needle)
        ? `^${escaped}(?=$|[^a-z0-9_])[,，:：\\s]*`
        : `^${escaped}[,，:：\\s]*`;
      const re = new RegExp(boundary, "iu");
      const m = re.exec(rest);
      if (m) {
        rest = rest.slice(m[0].length).trim();
        matchedWake = true;
        break;
      }
    }
    if (!matchedWake) break;
  }
  return rest;
}

export function classifyCommand(
  text: string,
  config: Pick<
    InboundPolicyConfig,
    | "targetUserIds"
    | "targetSubteamIds"
    | "wakePatterns"
    | "cancelKeywords"
    | "newSessionKeywords"
  >,
): { operation: "dispatch" | "cancel" | "new_session"; effectiveText: string } {
  const body = stripLeadingAddressingPrefix(text, config);
  const lower = body.toLowerCase();
  if (config.cancelKeywords.has(lower)) {
    return { operation: "cancel", effectiveText: text };
  }
  const firstBreak = body.search(/[\s\n]/u);
  const firstToken = (
    firstBreak === -1 ? body : body.slice(0, firstBreak)
  ).toLowerCase();
  if (firstToken && config.newSessionKeywords.has(firstToken)) {
    const rest = firstBreak === -1 ? "" : body.slice(firstBreak).trim();
    return { operation: "new_session", effectiveText: rest };
  }
  return { operation: "dispatch", effectiveText: text };
}

function fallbackTargetMention(
  config: Pick<InboundPolicyConfig, "targetUserIds" | "targetSubteamIds">,
): MentionMatch | undefined {
  const firstUser = config.targetUserIds.values().next().value;
  if (typeof firstUser === "string") return { type: "user", id: firstUser };
  const firstSubteam = config.targetSubteamIds.values().next().value;
  if (typeof firstSubteam === "string")
    return { type: "subteam", id: firstSubteam };
  return undefined;
}

export function isChannelAndSenderAllowed(
  teamId: string,
  channelId: string,
  senderUserId: string,
  config: InboundPolicyConfig,
): boolean {
  return (
    teamId === config.teamId &&
    (config.allowAllChannels || config.allowedChannelIds.has(channelId)) &&
    !config.blockedChannelIds.has(channelId) &&
    (config.allowAllSenders || config.allowedSenderIds.has(senderUserId)) &&
    !config.blockedSenderIds.has(senderUserId)
  );
}

/** Single consumer-side policy re-check for queued events and internal callbacks. */
export function isQueuedEventAdmitted(
  event: QueuedEventSummary,
  config: InboundPolicyConfig,
): boolean {
  if (event.trigger === "native_stop") {
    return (
      Boolean(config.slackStatusToken) &&
      event.teamId === config.teamId &&
      (config.allowAllChannels ||
        config.allowedChannelIds.has(event.channelId)) &&
      !config.blockedChannelIds.has(event.channelId) &&
      config.controlUserIds.has(event.senderUserId) &&
      !config.blockedSenderIds.has(event.senderUserId)
    );
  }
  if (
    !isChannelAndSenderAllowed(
      event.teamId,
      event.channelId,
      event.senderUserId,
      config,
    )
  ) {
    return false;
  }
  if (event.operation === "steer_ack" || event.operation === "watchdog") {
    return true;
  }
  if (event.operation === "new_session") {
    return config.controlUserIds.has(event.senderUserId);
  }
  if (event.trigger === "implicit_thread") {
    return config.implicitThreadFollowup && event.threadTs !== event.messageTs;
  }
  if (event.trigger === "edit_mention" && !config.allowEditMentionWake) {
    return false;
  }
  if (event.trigger === "wake_pattern" || event.trigger === "edit_mention") {
    return (
      Boolean(
        findTargetMention(
          event.text,
          config.targetUserIds,
          config.targetSubteamIds,
        ),
      ) || Boolean(matchesWakePattern(event.text, config.wakePatterns))
    );
  }
  return Boolean(
    findTargetMention(
      event.text,
      config.targetUserIds,
      config.targetSubteamIds,
    ),
  );
}

export function evaluateInboundSlackEvent(
  teamId: unknown,
  rawEvent: Record<string, unknown>,
  config: InboundPolicyConfig,
): InboundEvaluation {
  if (typeof teamId !== "string" || !/^[A-Z][A-Z0-9]+$/u.test(teamId)) {
    return { admitted: false, reason: "invalid_event", invalid: true };
  }

  let effectiveEvent: Record<string, unknown> = rawEvent;
  let fromEdit = false;

  if (
    rawEvent.type === "message" &&
    rawEvent.subtype === "message_changed" &&
    config.allowEditMentionWake
  ) {
    const updated = rawEvent.message;
    const previous = rawEvent.previous_message;
    if (
      !isRecord(updated) ||
      !isRecord(updated.edited) ||
      typeof rawEvent.channel !== "string" ||
      typeof updated.ts !== "string" ||
      typeof updated.user !== "string" ||
      typeof updated.text !== "string"
    ) {
      return { admitted: false, reason: "ignored" };
    }
    const innerSubtype =
      typeof updated.subtype === "string" ? updated.subtype : "";
    if (!CONVERSATIONAL_SUBTYPES.has(innerSubtype)) {
      return { admitted: false, reason: "ignored" };
    }
    const prevText =
      isRecord(previous) && typeof previous.text === "string"
        ? previous.text
        : "";
    const hadAddress =
      Boolean(
        findTargetMention(
          prevText,
          config.targetUserIds,
          config.targetSubteamIds,
        ),
      ) || Boolean(matchesWakePattern(prevText, config.wakePatterns));
    if (hadAddress) {
      return { admitted: false, reason: "ignored" };
    }
    effectiveEvent = {
      ...updated,
      type: "message",
      channel: rawEvent.channel,
    };
    fromEdit = true;
  } else {
    const msg = rawEvent as SlackMessageEvent;
    const subtype = typeof msg.subtype === "string" ? msg.subtype : "";
    if (
      (msg.type !== "message" && msg.type !== "app_mention") ||
      typeof msg.channel !== "string" ||
      typeof msg.ts !== "string" ||
      typeof msg.text !== "string" ||
      !CONVERSATIONAL_SUBTYPES.has(subtype)
    ) {
      return { admitted: false, reason: "ignored" };
    }
  }

  const channelId = effectiveEvent.channel;
  const messageTs = effectiveEvent.ts;
  const senderUserId = effectiveEvent.user;
  const rawText = effectiveEvent.text;
  if (
    typeof channelId !== "string" ||
    !/^[A-Z][A-Z0-9]+$/u.test(channelId) ||
    typeof senderUserId !== "string" ||
    !/^[A-Z][A-Z0-9]+$/u.test(senderUserId) ||
    typeof messageTs !== "string" ||
    !/^\d+\.\d{1,6}$/u.test(messageTs) ||
    typeof rawText !== "string"
  ) {
    return { admitted: false, reason: "invalid_event", invalid: true };
  }
  const threadTs =
    typeof effectiveEvent.thread_ts === "string"
      ? effectiveEvent.thread_ts
      : messageTs;
  if (!/^\d+\.\d{1,6}$/u.test(threadTs)) {
    return { admitted: false, reason: "invalid_event", invalid: true };
  }

  const text = extractSupplementalText(effectiveEvent, rawText);
  const explicitMention = findTargetMention(
    text,
    config.targetUserIds,
    config.targetSubteamIds,
  );
  const wakeMatch = !explicitMention
    ? matchesWakePattern(text, config.wakePatterns)
    : undefined;

  if (fromEdit && !explicitMention && !wakeMatch) {
    return { admitted: false, reason: "not_addressed" };
  }

  if (explicitMention || wakeMatch) {
    if (
      !isChannelAndSenderAllowed(teamId, channelId, senderUserId, config)
    ) {
      return { admitted: false, reason: "not_allowed" };
    }
    const mention = explicitMention ?? fallbackTargetMention(config);
    if (!mention) return { admitted: false, reason: "not_addressed" };
    const classified = classifyCommand(text, config);
    if (
      (classified.operation === "cancel" ||
        classified.operation === "new_session") &&
      !config.controlUserIds.has(senderUserId)
    ) {
      return { admitted: false, reason: "cancel_not_allowed" };
    }
    const trigger: TriggerSource | undefined = fromEdit
      ? "edit_mention"
      : wakeMatch
        ? "wake_pattern"
        : undefined;
    return {
      admitted: true,
      candidate: {
        teamId,
        channelId,
        messageTs,
        threadTs,
        senderUserId,
        text: classified.effectiveText,
        files: effectiveEvent.files,
        rawForFingerprint: effectiveEvent,
        mention,
        operation: classified.operation,
        ...(trigger ? { trigger } : {}),
        requiresActiveThread: false,
      },
    };
  }

  const isThreadReply = threadTs !== messageTs;
  if (!config.implicitThreadFollowup || !isThreadReply) {
    return { admitted: false, reason: "not_addressed" };
  }
  if (!isChannelAndSenderAllowed(teamId, channelId, senderUserId, config)) {
    return { admitted: false, reason: "not_allowed" };
  }
  if (BROADCAST_MENTION.test(text)) {
    return { admitted: false, reason: "broadcast" };
  }
  if (isAddressedToOtherUser(text, config.targetUserIds)) {
    return { admitted: false, reason: "addressed_to_other" };
  }
  if (config.controlUserIds.has(senderUserId)) {
    return { admitted: false, reason: "owner_unaddressed" };
  }
  const mention = fallbackTargetMention(config);
  if (!mention) return { admitted: false, reason: "not_addressed" };

  return {
    admitted: true,
    candidate: {
      teamId,
      channelId,
      messageTs,
      threadTs,
      senderUserId,
      text,
      files: effectiveEvent.files,
      rawForFingerprint: effectiveEvent,
      mention,
      operation: "dispatch",
      trigger: "implicit_thread",
      requiresActiveThread: true,
    },
  };
}
