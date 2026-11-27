import { Buffer } from 'node:buffer';
import { readStoreKeys, type ThreadStore } from './thread-store.js';
import type { SlackThreadEvent } from './thread-router.js';

export const DIRECTORY_TTL_SECONDS = 24 * 60 * 60;
export const MAX_USER_LOOKUPS = 12;

const SKIPPABLE_USER_ERRORS = new Set(['user_not_found', 'user_not_visible', 'users_not_found']);

export type SlackChannelType = 'im' | 'mpim' | 'private' | 'public' | 'unknown';

export interface SlackChannelProfile {
  id: string;
  type: SlackChannelType;
  name?: string;
  imUserId?: string;
  memberCount?: number;
  topic?: string;
}

export interface SlackUserProfile {
  id: string;
  name?: string;
  displayName?: string;
  realName?: string;
  isBot?: boolean;
}

export interface SlackDirectoryResult {
  channel: SlackChannelProfile;
  users: Record<string, SlackUserProfile>;
  stats: {
    channelCacheHit: boolean;
    channelLookupCalls: number;
    userCacheHits: number;
    userLookupCalls: number;
    lookupMs: number;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clipUtf8(text: string, maxBytes: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const bytes = Buffer.byteLength(ch);
    if (used + bytes > maxBytes) break;
    out += ch;
    used += bytes;
  }
  return out;
}

function singleLine(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  return cleaned ? clipUtf8(cleaned, maxBytes) : undefined;
}

export function extractMentionedUserIds(texts: readonly string[]): string[] {
  const found = new Set<string>();
  const pattern = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/gu;
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

function channelCacheKey(teamId: string, channelId: string): string {
  return `relay:dir:v1:ch:${teamId}:${channelId}`;
}

function userCacheKey(teamId: string, userId: string): string {
  return `relay:dir:v1:user:${teamId}:${userId}`;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error('directory_response_too_large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function fallbackChannel(channelId: string): SlackChannelProfile {
  return {
    id: channelId,
    type: channelId.startsWith('D') ? 'im' : 'unknown',
  };
}

function parseCachedChannel(raw: string | null, channelId: string): SlackChannelProfile | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SlackChannelProfile>;
    if (!isObject(parsed) || parsed.id !== channelId || typeof parsed.type !== 'string') {
      return undefined;
    }
    return parsed as SlackChannelProfile;
  } catch {
    return undefined;
  }
}

function parseCachedUser(raw: string | null, userId: string): SlackUserProfile | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SlackUserProfile>;
    if (!isObject(parsed) || parsed.id !== userId) return undefined;
    return parsed as SlackUserProfile;
  } catch {
    return undefined;
  }
}

function formatUserLabel(displayName?: string, realName?: string, handle?: string): string | undefined {
  if (displayName && realName && displayName.toLowerCase() !== realName.toLowerCase()) {
    return clipUtf8(`${displayName} (${realName})`, 256);
  }
  const chosen = displayName || realName || handle;
  return chosen ? clipUtf8(chosen, 256) : undefined;
}

export async function resolveSlackDirectory(
  event: Pick<SlackThreadEvent, 'teamId' | 'channelId' | 'senderUserId' | 'mention'>,
  texts: readonly string[],
  authorIds: readonly string[],
  options: {
    token: string;
    store?: ThreadStore;
    fetchImpl?: typeof fetch;
  },
): Promise<SlackDirectoryResult> {
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const candidateUserIds = [
    ...new Set([
      event.senderUserId,
      ...(event.mention.type === 'user' ? [event.mention.id] : []),
      ...authorIds,
      ...extractMentionedUserIds(texts),
    ]),
  ].filter((id) => /^[UW][A-Z0-9]+$/u.test(id));

  const chKey = channelCacheKey(event.teamId, event.channelId);
  const userKeys = candidateUserIds.map((id) => userCacheKey(event.teamId, id));

  let cachedValues: (string | null)[] = [];
  if (options.store) {
    try {
      cachedValues = await readStoreKeys(options.store, [chKey, ...userKeys]);
    } catch {
      cachedValues = [];
    }
  }

  let channel = parseCachedChannel(cachedValues[0] ?? null, event.channelId);
  const channelCacheHit = Boolean(channel);
  let channelLookupCalls = 0;

  const users: Record<string, SlackUserProfile> = {};
  const missingUserIds: string[] = [];
  let userCacheHits = 0;

  for (let i = 0; i < candidateUserIds.length; i++) {
    const uid = candidateUserIds[i]!;
    const hit = parseCachedUser(cachedValues[i + 1] ?? null, uid);
    if (hit?.name) {
      users[uid] = hit;
      userCacheHits++;
    } else {
      users[uid] = { id: uid };
      missingUserIds.push(uid);
    }
  }

  if (!channel) {
    channelLookupCalls++;
    channel = fallbackChannel(event.channelId);
    try {
      const params = new URLSearchParams({
        channel: event.channelId,
        include_num_members: 'true',
      });
      const response = await fetchImpl(`https://slack.com/api/conversations.info?${params}`, {
        headers: { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        const body = await readBoundedJson(response, 128 * 1024);
        if (isObject(body) && body.ok === true && isObject(body.channel) && body.channel.id === event.channelId) {
          const rawCh = body.channel;
          const type: SlackChannelType =
            rawCh.is_im === true
              ? 'im'
              : rawCh.is_mpim === true
                ? 'mpim'
                : rawCh.is_private === true
                  ? 'private'
                  : 'public';
          const name = singleLine(rawCh.name, 128);
          const imUserId =
            type === 'im' && typeof rawCh.user === 'string' && /^[UW][A-Z0-9]+$/u.test(rawCh.user)
              ? rawCh.user
              : undefined;
          const memberCount =
            typeof rawCh.num_members === 'number' && Number.isFinite(rawCh.num_members) && rawCh.num_members > 0
              ? Math.floor(rawCh.num_members)
              : undefined;
          const rawTopic = isObject(rawCh.topic) ? rawCh.topic.value : undefined;
          const rawPurpose = isObject(rawCh.purpose) ? rawCh.purpose.value : undefined;
          const topic = singleLine(rawTopic, 200) ?? singleLine(rawPurpose, 200);
          channel = {
            id: event.channelId,
            type,
            ...(name ? { name } : {}),
            ...(imUserId ? { imUserId } : {}),
            ...(memberCount !== undefined ? { memberCount } : {}),
            ...(topic ? { topic } : {}),
          };
          if (options.store) {
            await options.store
              .set(chKey, JSON.stringify(channel), DIRECTORY_TTL_SECONDS)
              .catch(() => {});
          }
        }
      }
    } catch {
      // Metadata enrichment is best-effort and never blocks task creation.
    }
  }

  if (channel.imUserId && !users[channel.imUserId]?.name) {
    let cachedImPeer: SlackUserProfile | undefined;
    if (!candidateUserIds.includes(channel.imUserId) && options.store) {
      try {
        const rawPeer = await options.store.get(userCacheKey(event.teamId, channel.imUserId));
        cachedImPeer = parseCachedUser(rawPeer, channel.imUserId);
      } catch {
        cachedImPeer = undefined;
      }
    }
    const existingIndex = missingUserIds.indexOf(channel.imUserId);
    if (existingIndex >= 0) missingUserIds.splice(existingIndex, 1);
    if (cachedImPeer?.name) {
      users[channel.imUserId] = cachedImPeer;
      userCacheHits++;
    } else {
      users[channel.imUserId] = { id: channel.imUserId };
      missingUserIds.unshift(channel.imUserId);
    }
  }

  const pendingUserIds = missingUserIds.slice(0, MAX_USER_LOOKUPS);
  const deadline = AbortSignal.timeout(3_000);
  let nextIndex = 0;
  let stopped = false;
  let userLookupCalls = 0;

  await Promise.all(
    Array.from({ length: Math.min(4, pendingUserIds.length) }, async () => {
      while (!stopped && !deadline.aborted && nextIndex < pendingUserIds.length) {
        const uid = pendingUserIds[nextIndex++]!;
        try {
          userLookupCalls++;
          const response = await fetchImpl(
            `https://slack.com/api/users.info?${new URLSearchParams({ user: uid })}`,
            {
              headers: { authorization: `Bearer ${options.token}` },
              signal: deadline,
            },
          );
          if (!response.ok) {
            stopped = true;
            continue;
          }
          const body = await readBoundedJson(response, 128 * 1024);
          if (!isObject(body) || body.ok !== true) {
            const code = isObject(body) && typeof body.error === 'string' ? body.error : '';
            if (!SKIPPABLE_USER_ERRORS.has(code)) stopped = true;
            continue;
          }
          if (!isObject(body.user) || body.user.id !== uid) continue;
          const rawProfile = isObject(body.user.profile) ? body.user.profile : {};
          const displayName = singleLine(rawProfile.display_name, 128);
          const realName =
            singleLine(rawProfile.real_name, 128) ?? singleLine(body.user.real_name, 128);
          const handle = singleLine(body.user.name, 128);
          const name = formatUserLabel(displayName, realName, handle);
          const isBot = typeof body.user.is_bot === 'boolean' ? body.user.is_bot : undefined;
          const resolved: SlackUserProfile = {
            id: uid,
            ...(name ? { name } : {}),
            ...(displayName ? { displayName } : {}),
            ...(realName ? { realName } : {}),
            ...(isBot !== undefined ? { isBot } : {}),
          };
          users[uid] = resolved;
          if (name && options.store) {
            await options.store
              .set(userCacheKey(event.teamId, uid), JSON.stringify(resolved), DIRECTORY_TTL_SECONDS)
              .catch(() => {});
          }
        } catch {
          stopped = true;
        }
      }
    }),
  );

  return {
    channel,
    users,
    stats: {
      channelCacheHit,
      channelLookupCalls,
      userCacheHits,
      userLookupCalls,
      lookupMs: Date.now() - startedAt,
    },
  };
}
