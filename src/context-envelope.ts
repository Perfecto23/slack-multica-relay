import { Buffer } from 'node:buffer';
import type { SlackReplyContext } from './multica-api.js';
import type { SlackChannelProfile, SlackUserProfile } from './slack-directory.js';
import type { SlackThreadEvent } from './thread-router.js';

export const SCHEMA_VERSION = 7;
export const MAX_VIEW_IMAGES = 6;
export const MAX_VIEW_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PREPARED_ENVELOPE_BYTES = 48 * 1024;

export interface ProjectedFile {
  id: string;
  name: string;
  mime: string;
  size?: number;
  contentStatus: 'not_loaded';
}

export interface SceneMessage {
  ts: string;
  authorId: string;
  origin: 'human' | 'agent_reply' | 'bot_or_app';
  botName?: string;
  text: string;
  files: ProjectedFile[];
  textTruncated?: boolean;
  filesTruncated?: boolean;
}

export interface ViewableImage {
  fileId: string;
  name: string;
  mime: string;
  size?: number;
  messageTs: string;
}

export interface ThreadContext {
  anchorTs: string;
  sinceTs?: string;
  cutoffTs: string;
  capturedAt: string;
  rootMessage?: SceneMessage;
  replies: SceneMessage[];
  omittedEarlierReplies: number;
  nearbyMessages: SceneMessage[];
  nearbyOmittedReason?: string;
  hasSlackLinks: boolean;
  directory?: {
    channel: SlackChannelProfile;
    users: Record<string, SlackUserProfile>;
  };
  readStats?: {
    slackCalls: number;
    rawMessages: number;
    messageReadMs: number;
    channelCacheHit?: boolean;
    channelLookupCalls?: number;
    userCacheHits?: number;
    userLookupCalls?: number;
    lookupMs?: number;
  };
}

export interface PreparedEnvelope {
  schemaVersion: typeof SCHEMA_VERSION;
  eventPayload: {
    teamId: string;
    channelId: string;
    channelType?: SlackChannelProfile['type'];
    channelName?: string;
    threadTs: string;
    messageTs: string;
    senderUserId: string;
    senderName?: string;
    text: string;
    mention: { type: 'user' | 'subteam'; id: string };
    files: ProjectedFile[];
    trigger?: SlackThreadEvent['trigger'];
    filesTruncated?: boolean;
  };
  scene: Omit<ThreadContext, 'readStats'>;
  ownerUserIds?: string[];
  replyContext?: SlackReplyContext;
}

export const timestampValid = (ts: unknown): ts is string =>
  typeof ts === 'string' && /^\d+\.\d{1,6}$/u.test(ts);

export function compareTs(a: string, b: string): number {
  const micro = (s: string) => {
    const [sec, fraction] = s.split('.');
    return BigInt(sec!) * 1_000_000n + BigInt(fraction!.padEnd(6, '0'));
  };
  return micro(a) < micro(b) ? -1 : micro(a) > micro(b) ? 1 : 0;
}

export function clip(text: string, bytes: number): string {
  let result = '';
  let used = 0;
  for (const char of text) {
    const n = Buffer.byteLength(char);
    if (used + n > bytes) break;
    result += char;
    used += n;
  }
  return result;
}

export function projectFiles(value: unknown, limit = 5): ProjectedFile[] {
  if (!Array.isArray(value)) return [];
  const cleanField = (rawVal: string, maxBytes: number) =>
    clip(rawVal.replace(/\s+/gu, ' ').trim(), maxBytes);
  return value
    .filter((x) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')
    .slice(0, limit)
    .map((raw) => {
      const x = raw as Record<string, unknown>;
      return {
        id: cleanField(String(x.id), 128),
        name: cleanField(typeof x.name === 'string' ? x.name : '', 256),
        mime: cleanField(
          typeof x.mime === 'string'
            ? x.mime
            : typeof x.mimetype === 'string'
              ? x.mimetype
              : '',
          128,
        ),
        ...(typeof x.size === 'number' && Number.isFinite(x.size) ? { size: x.size } : {}),
        contentStatus: 'not_loaded' as const,
      };
    });
}

// Escape platform routing syntax and HTML markers while preserving JSON round trips.
export function serializeEnvelope(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(
    /"(?:\\.|[^"\\])*"/gu,
    (token) =>
      token
        .replace(/[<>\[\]]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .replace(/mention:\/\//giu, (m) => `${m.slice(0, 7)}\\u003a//`),
  );
}

const isImageFile = (file: ProjectedFile): boolean =>
  file.mime ? file.mime.startsWith('image/') : /\.(png|jpe?g|gif|webp|heic|bmp)$/iu.test(file.name);

export function collectAttachmentsSummary(
  eventFiles: readonly ProjectedFile[],
  messageTs: string,
  scene: Pick<ThreadContext, 'rootMessage' | 'replies' | 'nearbyMessages'>,
  options?: { includeRoot?: boolean },
): {
  viewImages: ViewableImage[];
  skippedImages: number;
  otherFilesCount: number;
} {
  const includeRoot =
    options?.includeRoot !== false && Boolean(scene.rootMessage && scene.rootMessage.ts !== messageTs);
  const threadMessages = [
    ...scene.replies,
    ...(includeRoot && scene.rootMessage ? [scene.rootMessage] : []),
  ].sort((a, b) => compareTs(b.ts, a.ts));

  const candidates: { file: ProjectedFile; ts: string }[] = [
    ...eventFiles.map((file) => ({ file, ts: messageTs })),
    ...threadMessages.flatMap((m) => m.files.map((file) => ({ file, ts: m.ts }))),
  ];

  const viewImages: ViewableImage[] = [];
  const seen = new Set<string>();
  let skippedImages = 0;

  for (const { file, ts } of candidates) {
    if (!isImageFile(file) || seen.has(file.id)) continue;
    seen.add(file.id);
    if (
      (file.size !== undefined && file.size > MAX_VIEW_IMAGE_BYTES) ||
      viewImages.length >= MAX_VIEW_IMAGES
    ) {
      skippedImages++;
    } else {
      viewImages.push({
        fileId: file.id,
        name: file.name,
        mime: file.mime,
        ...(file.size !== undefined ? { size: file.size } : {}),
        messageTs: ts,
      });
    }
  }

  const allFileIds = new Set<string>([
    ...eventFiles.map((f) => f.id),
    ...(includeRoot && scene.rootMessage ? scene.rootMessage.files.map((f) => f.id) : []),
    ...scene.replies.flatMap((m) => m.files.map((f) => f.id)),
    ...scene.nearbyMessages.flatMap((m) => m.files.map((f) => f.id)),
  ]);
  for (const img of viewImages) allFileIds.delete(img.fileId);

  return {
    viewImages,
    skippedImages,
    otherFilesCount: Math.max(0, allFileIds.size - skippedImages),
  };
}

export function buildEnvelope(
  event: SlackThreadEvent,
  input: ThreadContext,
  replyContext?: SlackReplyContext,
  options?: { ownerUserIds?: ReadonlySet<string> },
): string {
  const cloned = structuredClone(input);
  delete cloned.readStats;
  if (event.messageTs === event.threadTs) {
    delete cloned.rootMessage;
  }

  const channel = cloned.directory?.channel;
  const senderName = cloned.directory?.users[event.senderUserId]?.name;
  const eventFiles = projectFiles(event.files, Number.MAX_SAFE_INTEGER);

  const result: PreparedEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    eventPayload: {
      teamId: event.teamId,
      channelId: event.channelId,
      ...(channel && channel.type !== 'unknown' ? { channelType: channel.type } : {}),
      ...(channel?.name ? { channelName: channel.name } : {}),
      threadTs: event.threadTs,
      messageTs: event.messageTs,
      senderUserId: event.senderUserId,
      ...(senderName ? { senderName } : {}),
      text: event.text,
      mention: { type: event.mention.type, id: event.mention.id },
      files: eventFiles,
      ...(event.trigger ? { trigger: event.trigger } : {}),
      ...(event.filesTruncated ? { filesTruncated: true } : {}),
    },
    scene: cloned,
    ...(options?.ownerUserIds?.size ? { ownerUserIds: [...options.ownerUserIds] } : {}),
    ...(replyContext ? { replyContext } : {}),
  };

  const shrink = (): boolean => {
    if (result.scene.nearbyMessages.length > 0) {
      result.scene.nearbyMessages.shift();
      result.scene.nearbyOmittedReason ??= 'byte_budget';
      return true;
    }
    if (result.scene.replies.length > 0) {
      result.scene.replies.shift();
      result.scene.omittedEarlierReplies += 1;
      return true;
    }
    const rootCap = event.messageTs === event.threadTs ? 0 : 1024;
    if (
      result.scene.rootMessage &&
      Buffer.byteLength(result.scene.rootMessage.text) > rootCap
    ) {
      result.scene.rootMessage.text = clip(result.scene.rootMessage.text, rootCap);
      result.scene.rootMessage.textTruncated = true;
      return true;
    }
    return false;
  };

  let serialized = serializeEnvelope(result);
  while (Buffer.byteLength(serialized) > MAX_PREPARED_ENVELOPE_BYTES) {
    if (!shrink()) throw new Error('context_request_too_large');
    serialized = serializeEnvelope(result);
  }
  return serialized;
}
