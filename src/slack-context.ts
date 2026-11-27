import { Buffer } from 'node:buffer';
import {
  clip,
  compareTs,
  projectFiles,
  timestampValid,
  type SceneMessage,
  type ThreadContext,
} from './context-envelope.js';
import { resolveSlackDirectory } from './slack-directory.js';
import { extractMessageContent, isRelayProgressMessage } from './slack-message-text.js';
import type { SlackThreadEvent } from './thread-router.js';
import type { ThreadStore } from './thread-store.js';

type RawMessage = Record<string, unknown>;

const PERMISSION_ERRORS = new Set([
  'missing_scope',
  'not_in_channel',
  'channel_not_found',
  'access_denied',
  'token_revoked',
  'invalid_auth',
  'account_inactive',
  'thread_not_found',
]);

const MAX_REPLY_PAGES = 10;
export const MAX_TURN1_REPLIES = 20;
export const MAX_FOLLOWUP_REPLIES = 30;
export const NEARBY_WINDOW_SECONDS = 600n;
export const MAX_NEARBY_ROOTS = 5;

const SLACK_PERMALINK_RE = /https:\/\/[^\s<>|]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{7,}/u;

function projectSceneMessage(raw: RawMessage, capText = false): SceneMessage {
  const extracted = extractMessageContent(raw);
  const fullText = extracted.text;
  const text = capText ? clip(fullText, 4096) : clip(fullText, 12_288);
  const maxFiles = capText ? 5 : 20;
  return {
    ts: String(raw.ts),
    authorId:
      typeof raw.user === 'string'
        ? raw.user
        : typeof raw.bot_id === 'string'
          ? raw.bot_id
          : '',
    origin: extracted.origin,
    ...(extracted.botName ? { botName: extracted.botName } : {}),
    text,
    files: projectFiles(raw.files, maxFiles),
    ...(Buffer.byteLength(fullText) > Buffer.byteLength(text) ? { textTruncated: true } : {}),
    ...(Array.isArray(raw.files) && raw.files.length > maxFiles ? { filesTruncated: true } : {}),
  };
}

async function readSlackJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('context_invalid_response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('context_response_too_large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('context_invalid_response');
  }
  return parsed as Record<string, unknown>;
}

export interface ContextReadOptions {
  sinceTs?: string;
  includeNearby?: boolean;
}

export async function readContext(
  event: SlackThreadEvent,
  token: string,
  fetchImpl: typeof fetch = fetch,
  options: ContextReadOptions = {},
): Promise<ThreadContext> {
  const startedAt = Date.now();
  if (
    !timestampValid(event.threadTs) ||
    !timestampValid(event.messageTs) ||
    compareTs(event.threadTs, event.messageTs) > 0
  ) {
    throw new Error('invalid_context_scope');
  }
  if (
    options.sinceTs &&
    (!timestampValid(options.sinceTs) ||
      compareTs(options.sinceTs, event.threadTs) < 0 ||
      compareTs(options.sinceTs, event.messageTs) >= 0)
  ) {
    throw new Error('invalid_context_scope');
  }

  const deadline = AbortSignal.timeout(20_000);
  let slackCalls = 0;
  let rawMessages = 0;

  let rootMessage: SceneMessage | undefined;
  let replies: SceneMessage[] = [];
  let omittedEarlierReplies = 0;
  let nearbyMessages: SceneMessage[] = [];
  let nearbyOmittedReason: string | undefined;

  if (event.messageTs === event.threadTs) {
    rootMessage = projectSceneMessage({
      ts: event.messageTs,
      user: event.senderUserId,
      text: event.text,
      files: event.files,
    });

    if (options.includeNearby !== false) {
      const [seconds, fraction] = event.messageTs.split('.');
      const oldestSec = BigInt(seconds!) > NEARBY_WINDOW_SECONDS ? BigInt(seconds!) - NEARBY_WINDOW_SECONDS : 0n;
      const oldest = `${oldestSec}.${fraction}`;
      try {
        slackCalls++;
        const params = new URLSearchParams({
          channel: event.channelId,
          oldest,
          latest: event.messageTs,
          inclusive: 'true',
          limit: '15',
        });
        const response = await fetchImpl(`https://slack.com/api/conversations.history?${params}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: deadline,
        });
        if (response.status === 429) {
          nearbyOmittedReason = 'rate_limited';
        } else if (!response.ok) {
          nearbyOmittedReason = 'read_failed';
        } else {
          const body = await readSlackJson(response);
          if (body.ok !== true) {
            nearbyOmittedReason = typeof body.error === 'string' ? body.error : 'read_failed';
          } else if (!Array.isArray(body.messages)) {
            nearbyOmittedReason = 'invalid_response';
          } else {
            rawMessages += body.messages.length;
            const collected: SceneMessage[] = [];
            for (const item of body.messages) {
              if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
              const raw = item as RawMessage;
              if (!timestampValid(raw.ts)) throw new Error('context_invalid_response');
              if (raw.channel && raw.channel !== event.channelId) throw new Error('invalid_context_scope');
              if (compareTs(raw.ts, oldest) < 0 || compareTs(raw.ts, event.messageTs) >= 0) continue;
              if (raw.thread_ts && raw.thread_ts !== raw.ts) continue;
              if (isRelayProgressMessage(raw)) continue;
              if (
                raw.subtype &&
                !['bot_message', 'file_share', 'thread_broadcast', 'me_message'].includes(
                  String(raw.subtype),
                )
              ) {
                continue;
              }
              if (!collected.some((m) => m.ts === raw.ts)) {
                collected.push(projectSceneMessage(raw, true));
              }
            }
            collected.sort((a, b) => compareTs(a.ts, b.ts));
            if (collected.length > MAX_NEARBY_ROOTS) {
              nearbyMessages = collected.slice(-MAX_NEARBY_ROOTS);
            } else {
              nearbyMessages = collected;
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_context_scope') throw error;
        nearbyOmittedReason = 'read_failed';
      }
    }
  } else {
    const fetched: SceneMessage[] = [];
    let cursor = '';
    const seenCursors = new Set<string>();
    let reachedEnd = false;

    for (let page = 0; page < MAX_REPLY_PAGES; page++) {
      deadline.throwIfAborted();
      slackCalls++;
      const params = new URLSearchParams({
        channel: event.channelId,
        ts: event.threadTs,
        latest: event.messageTs,
        inclusive: 'true',
        limit: '200',
        ...(options.sinceTs ? { oldest: options.sinceTs } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const response = await fetchImpl(`https://slack.com/api/conversations.replies?${params}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: deadline,
      });
      if (response.status === 429) throw new Error('context_rate_limited');
      if (!response.ok) throw new Error('context_upstream_failed');
      const body = await readSlackJson(response);
      if (body.ok !== true) {
        if (typeof body.error === 'string' && PERMISSION_ERRORS.has(body.error)) {
          throw new Error('context_required_unavailable');
        }
        throw new Error('context_upstream_failed');
      }
      if (!Array.isArray(body.messages)) throw new Error('context_invalid_response');
      rawMessages += body.messages.length;

      for (const item of body.messages) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error('context_invalid_response');
        }
        const raw = item as RawMessage;
        if (!timestampValid(raw.ts)) throw new Error('context_invalid_response');
        if (raw.channel && raw.channel !== event.channelId) throw new Error('invalid_context_scope');
        if (raw.thread_ts && raw.thread_ts !== event.threadTs) throw new Error('invalid_context_scope');
        if (compareTs(raw.ts, event.threadTs) < 0 || compareTs(raw.ts, event.messageTs) > 0) continue;
        if (isRelayProgressMessage(raw)) continue;
        if (!fetched.some((m) => m.ts === raw.ts)) {
          fetched.push(projectSceneMessage(raw, false));
        }
      }

      const meta = body.response_metadata;
      cursor =
        meta && typeof meta === 'object' && typeof (meta as { next_cursor?: unknown }).next_cursor === 'string'
          ? ((meta as { next_cursor: string }).next_cursor.trim())
          : '';
      if (!cursor && body.has_more === true) throw new Error('context_invalid_cursor');
      if (!cursor) {
        reachedEnd = true;
        break;
      }
      if (seenCursors.has(cursor)) throw new Error('context_invalid_cursor');
      seenCursors.add(cursor);
    }

    if (!reachedEnd) throw new Error('context_required_page_limit');

    rootMessage = fetched.find((m) => m.ts === event.threadTs);
    if (!rootMessage && options.sinceTs) {
      deadline.throwIfAborted();
      slackCalls++;
      const rootParams = new URLSearchParams({
        channel: event.channelId,
        oldest: event.threadTs,
        latest: event.threadTs,
        inclusive: 'true',
        limit: '1',
      });
      const rootRes = await fetchImpl(`https://slack.com/api/conversations.history?${rootParams}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: deadline,
      });
      if (rootRes.status === 429) throw new Error('context_rate_limited');
      if (!rootRes.ok) throw new Error('context_upstream_failed');
      const rootBody = await readSlackJson(rootRes);
      if (rootBody.ok !== true) {
        if (typeof rootBody.error === 'string' && PERMISSION_ERRORS.has(rootBody.error)) {
          throw new Error('context_required_unavailable');
        }
        throw new Error('context_upstream_failed');
      }
      if (Array.isArray(rootBody.messages)) {
        rawMessages += rootBody.messages.length;
        const exact = rootBody.messages.find(
          (m): m is RawMessage =>
            Boolean(m) && typeof m === 'object' && (m as RawMessage).ts === event.threadTs,
        );
        if (exact) {
          if (exact.channel && exact.channel !== event.channelId) {
            throw new Error('invalid_context_scope');
          }
          rootMessage = projectSceneMessage(exact, false);
        }
      }
    }

    if (!rootMessage) throw new Error('context_required_unavailable');

    const candidates = fetched
      .filter((m) => m.ts !== event.threadTs && m.ts !== event.messageTs)
      .filter((m) => (!options.sinceTs ? true : compareTs(m.ts, options.sinceTs) > 0))
      .sort((a, b) => compareTs(a.ts, b.ts));

    const cap = options.sinceTs ? MAX_FOLLOWUP_REPLIES : MAX_TURN1_REPLIES;
    if (candidates.length > cap) {
      omittedEarlierReplies = candidates.length - cap;
      replies = candidates.slice(-cap);
    } else {
      replies = candidates;
    }
  }

  const allTexts = [
    event.text,
    ...(options.sinceTs ? [] : [rootMessage?.text ?? '']),
    ...replies.map((m) => m.text),
    ...nearbyMessages.map((m) => m.text),
  ];
  const hasSlackLinks = allTexts.some((t) => SLACK_PERMALINK_RE.test(t));

  return {
    anchorTs: event.threadTs,
    ...(options.sinceTs ? { sinceTs: options.sinceTs } : {}),
    cutoffTs: event.messageTs,
    capturedAt: new Date().toISOString(),
    ...(rootMessage ? { rootMessage } : {}),
    replies,
    omittedEarlierReplies,
    nearbyMessages,
    ...(nearbyOmittedReason ? { nearbyOmittedReason } : {}),
    hasSlackLinks,
    readStats: {
      slackCalls,
      rawMessages,
      messageReadMs: Date.now() - startedAt,
    },
  };
}

export async function enrichContextDirectory(
  event: SlackThreadEvent,
  context: ThreadContext,
  options: {
    token: string;
    store?: ThreadStore;
    fetchImpl?: typeof fetch;
  },
): Promise<ThreadContext> {
  const texts = [
    event.text,
    context.rootMessage?.text ?? '',
    ...context.replies.map((m) => m.text),
    ...context.nearbyMessages.map((m) => m.text),
  ];
  const authorIds = [
    context.rootMessage?.authorId ?? '',
    ...context.replies.map((m) => m.authorId),
    ...context.nearbyMessages.map((m) => m.authorId),
  ].filter(Boolean);

  const directory = await resolveSlackDirectory(event, texts, authorIds, options);
  return {
    ...context,
    directory: {
      channel: directory.channel,
      users: directory.users,
    },
    readStats: {
      ...(context.readStats ?? { slackCalls: 0, rawMessages: 0, messageReadMs: 0 }),
      channelCacheHit: directory.stats.channelCacheHit,
      channelLookupCalls: directory.stats.channelLookupCalls,
      userCacheHits: directory.stats.userCacheHits,
      userLookupCalls: directory.stats.userLookupCalls,
      lookupMs: directory.stats.lookupMs,
    },
  };
}
