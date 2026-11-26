export type MentionType = 'user' | 'subteam';

export interface MentionMatch {
  type: MentionType;
  id: string;
}

const USER_MENTION = /<@([A-Z0-9]+)(?:\|[^>]+)?>/gu;
const SUBTEAM_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|[^>]+)?>/gu;

export function findTargetMention(
  text: string,
  targetUserIds: ReadonlySet<string>,
  targetSubteamIds: ReadonlySet<string>,
): MentionMatch | undefined {
  for (const match of text.matchAll(USER_MENTION)) {
    if (targetUserIds.has(match[1]!)) return { type: 'user', id: match[1]! };
  }
  for (const match of text.matchAll(SUBTEAM_MENTION)) {
    if (targetSubteamIds.has(match[1]!)) return { type: 'subteam', id: match[1]! };
  }
  return undefined;
}

/** Allowlist of Slack message subtypes that represent conversational posts rather than channel housekeeping. */
export const CONVERSATIONAL_SUBTYPES: ReadonlySet<string> = new Set([
  '',
  'file_share',
  'thread_broadcast',
  'me_message',
  'bot_message',
]);

export function isSupportedMessage(event: SlackMessageEvent): boolean {
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';
  return (event.type === 'message' || event.type === 'app_mention')
    && typeof event.channel === 'string'
    && typeof event.ts === 'string'
    && typeof event.text === 'string'
    && CONVERSATIONAL_SUBTYPES.has(subtype);
}

export interface SlackMessageEvent {
  type?: unknown;
  team?: unknown;
  channel?: unknown;
  channel_type?: unknown;
  ts?: unknown;
  thread_ts?: unknown;
  user?: unknown;
  text?: unknown;
  subtype?: unknown;
  bot_id?: unknown;
  app_id?: unknown;
  files?: unknown;
  attachments?: unknown;
  blocks?: unknown;
  message?: unknown;
  previous_message?: unknown;
}

export function isCancelCommand(
  text: string,
  targetUserIds: ReadonlySet<string>,
  targetSubteamIds: ReadonlySet<string>,
  cancelKeywords: ReadonlySet<string>,
): boolean {
  if (!findTargetMention(text, targetUserIds, targetSubteamIds)) return false;
  const command = text
    .replace(USER_MENTION, (mention, id: string) => targetUserIds.has(id) ? '' : mention)
    .replace(SUBTEAM_MENTION, (mention, id: string) => targetSubteamIds.has(id) ? '' : mention)
    .trim()
    .toLowerCase();
  return cancelKeywords.has(command);
}

export function canCancelTask(senderUserId: string | undefined, targetUserIds: ReadonlySet<string>): boolean {
  return senderUserId !== undefined && targetUserIds.has(senderUserId);
}
