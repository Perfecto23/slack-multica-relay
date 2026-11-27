import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  SCHEMA_VERSION,
  clip,
  collectAttachmentsSummary,
  compareTs,
  projectFiles,
  serializeEnvelope,
  type PreparedEnvelope,
  type ProjectedFile,
  type SceneMessage,
  type ThreadContext,
} from './context-envelope.js';
import type { SlackChannelProfile, SlackUserProfile } from './slack-directory.js';
import type { SlackThreadEvent } from './thread-router.js';

const PAYLOAD_START = '<!-- relay-payload:v1 -->';
const PAYLOAD_END = '<!-- /relay-payload -->';

const REPLY_HINT =
  '**回复方式**：需要回复时用 `multica-final-reply`（`--current-run`）发回 Slack 原线程，只写 Multica 评论对方看不到。';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeSlackEntities(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

export function formatTaskTitle(event: SlackThreadEvent, scope: string): string {
  const pr = event.text.match(
    /https:\/\/github\.com\/[^/\s<>|]+\/([^/\s<>|]+)\/pull\/(\d+)(?=[/?#\s<>|]|$)/u,
  );
  const summary = decodeSlackEntities(
    event.text
      .replace(/<@[^>]+>|<!subteam\^[^>]+>/gu, '')
      .replace(/<https?:\/\/[^>]+>|https?:\/\/\S+/gu, ''),
  )
    .replace(/^\s*cc\b\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const label = summary || (pr ? `${pr[1]} #${pr[2]}` : '自动任务');
  const identity = createHash('sha256')
    .update(`${scope}:${event.teamId}:${event.channelId}:${event.threadTs}`)
    .digest('hex')
    .slice(0, 16);
  const chars = Array.from(label);
  return `Slack mention · ${chars.slice(0, 80).join('')}${chars.length > 80 ? '...' : ''} · [${identity}]`;
}

function formatSgtParts(ts: string): { date: string; time: string; full: string } | undefined {
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms)) return undefined;
  const formatted = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
  const [date = '', time = ''] = formatted.split(' ');
  return { date, time, full: `${formatted}（Asia/Singapore）` };
}

function formatMessageTime(ts: string, referenceDate?: string): string {
  const parts = formatSgtParts(ts);
  if (!parts) return ts;
  return referenceDate && parts.date === referenceDate ? parts.time : `${parts.date} ${parts.time}`;
}

function formatDurationGap(earlierTs: string, laterTs: string): string | undefined {
  const deltaSec = Math.round(Number(laterTs) - Number(earlierTs));
  if (!Number.isFinite(deltaSec) || deltaSec < 1) return undefined;
  if (deltaSec < 60) return `${deltaSec} 秒`;
  const minutes = Math.floor(deltaSec / 60);
  const seconds = deltaSec % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 48) return remMin ? `${hours} 小时 ${remMin} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天`;
}

function buildSlackPermalink(channelId: string, messageTs: string, threadTs: string): string {
  const [sec = '0', frac = '0'] = messageTs.split('.');
  const p = `p${sec}${frac.padEnd(6, '0').slice(0, 6)}`;
  const base = `https://slack.com/archives/${channelId}/${p}`;
  if (messageTs !== threadTs) {
    return `${base}?thread_ts=${threadTs}&cid=${channelId}`;
  }
  return base;
}

function formatBytes(size?: number): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function neutralizeControlMarkup(text: string): string {
  return text
    .replace(/<!--/gu, '&lt;!--')
    .replace(/-->/gu, '--&gt;')
    .replace(/\\*\[@([^\]]*)\]/gu, '\\[@$1\\]')
    .replace(/\\*\[@/gu, '\\[@')
    .replace(/mention:\/\//giu, 'mention\\://');
}

function sanitizeInlineLabel(text: string): string {
  return neutralizeControlMarkup(text.replace(/[\r\n]+/gu, ' ').replace(/`/gu, "'").trim());
}

function sanitizeCodeToken(text: string): string {
  return text.replace(/[\r\n`]+/gu, '').trim();
}

function renderSlackText(
  rawText: string,
  users: Record<string, SlackUserProfile>,
  ownerSet: ReadonlySet<string>,
): string {
  const withTokens = rawText
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/gu, (_m, uid: string, fallback?: string) => {
      const resolved = users[uid]?.name || fallback?.trim();
      const ownerSuffix = ownerSet.has(uid) ? ' · 本人' : '';
      return resolved ? `@${resolved} (${uid}${ownerSuffix})` : `@${uid}`;
    })
    .replace(/<#([CDG][A-Z0-9]+)(?:\|([^>]+))?>/gu, (_m, cid: string, label?: string) =>
      label?.trim() ? `#${label.trim()} (${cid})` : `#${cid}`,
    )
    .replace(/<!subteam\^([A-Z0-9]+)(?:\|@?([^>]+))?>/gu, (_m, sid: string, label?: string) =>
      label?.trim() ? `@${label.trim()} (${sid})` : `@subteam:${sid}`,
    )
    .replace(/<!(channel|here|everyone)(?:\|[^>]+)?>/gu, (_m, range: string) => `@${range}`)
    .replace(/<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/gu, (_m, url: string, label?: string) => {
      const cleanLabel = label?.trim() ?? '';
      if (!cleanLabel) return url;
      const strippedUrl = url.replace(/^https?:\/\//iu, '').replace(/\/$/u, '');
      const strippedLabel = cleanLabel.replace(/^https?:\/\//iu, '').replace(/\/$/u, '');
      if (strippedLabel === strippedUrl || cleanLabel.endsWith('…') || cleanLabel.endsWith('...')) {
        return url;
      }
      return `[${cleanLabel}](${url})`;
    });

  return neutralizeControlMarkup(decodeSlackEntities(withTokens));
}

function formatAuthorBadge(
  authorId: string,
  origin: SceneMessage['origin'],
  botName: string | undefined,
  users: Record<string, SlackUserProfile>,
  ownerSet: ReadonlySet<string>,
): string {
  if (origin === 'agent_reply') {
    return '**小 p (Agent 已回复)**';
  }
  const safeId = sanitizeCodeToken(authorId);
  if (origin === 'bot_or_app') {
    const label = sanitizeInlineLabel(botName || users[authorId]?.name || 'Bot') || 'Bot';
    return safeId ? `**[Bot] ${label}** (\`${safeId}\`)` : `**[Bot] ${label}**`;
  }
  if (!safeId) return '**未知发送者**';
  const rawName = users[authorId]?.name;
  const name = rawName ? sanitizeInlineLabel(rawName) : undefined;
  const isOwner = ownerSet.has(authorId);
  if (isOwner) {
    return name ? `**${name} · 本人** (\`${safeId}\`)` : `**本人** (\`${safeId}\`)`;
  }
  return name ? `**${name}** (\`${safeId}\`)` : `\`${safeId}\``;
}

function formatChannelHeader(
  channel: SlackChannelProfile | undefined,
  channelId: string,
  users: Record<string, SlackUserProfile>,
  ownerSet: ReadonlySet<string>,
): string {
  const safeChannelId = sanitizeCodeToken(channelId);
  if (!channel || channel.type === 'unknown') {
    return `会话 \`${safeChannelId}\``;
  }
  if (channel.type === 'im') {
    const peerId = channel.imUserId;
    const safePeerId = peerId ? sanitizeCodeToken(peerId) : '';
    if (peerId && ownerSet.has(peerId)) {
      const selfName = sanitizeInlineLabel(users[peerId]?.name ?? '本人') || '本人';
      return `1v1 自聊 · ${selfName} (\`${safeChannelId}\`)`;
    }
    if (peerId && safePeerId) {
      const rawPeerName = users[peerId]?.name;
      const peerName = rawPeerName ? sanitizeInlineLabel(rawPeerName) : undefined;
      return peerName
        ? `1v1 私聊 · 对方：${peerName} (\`${safePeerId}\` · \`${safeChannelId}\`)`
        : `1v1 私聊 · 对方 \`${safePeerId}\` (\`${safeChannelId}\`)`;
    }
    return `1v1 私聊 (\`${safeChannelId}\`)`;
  }
  const countPart = channel.memberCount ? ` · ${channel.memberCount} 人` : '';
  const safeChannelName = channel.name ? sanitizeInlineLabel(channel.name) : '';
  if (channel.type === 'mpim') {
    const label = safeChannelName ? `\`#${safeChannelName}\` · ` : '';
    return `多人私聊（${label}${channel.memberCount ? `${channel.memberCount} 人 · ` : ''}\`${safeChannelId}\`）`;
  }
  const typeLabel = channel.type === 'private' ? '私有频道' : '公共频道';
  const namePart = safeChannelName ? `#${safeChannelName}` : `\`${safeChannelId}\``;
  return `${namePart}（${typeLabel}${countPart} · \`${safeChannelId}\`）`;
}

function formatFilesInline(files: readonly ProjectedFile[]): string {
  if (!files.length) return '';
  const items = files.map((f) => {
    const size = formatBytes(f.size);
    const safeMime = sanitizeInlineLabel(f.mime || 'file') || 'file';
    const safeId = sanitizeInlineLabel(f.id);
    const safeName = sanitizeInlineLabel(f.name || f.id) || safeId || 'file';
    const meta = [safeMime, size, `fileId=${safeId}`].filter(Boolean).join(', ');
    return `\`${safeName}\` (${meta})`;
  });
  return `[附件: ${items.join('；')}]`;
}

function renderMessageLine(
  message: SceneMessage,
  users: Record<string, SlackUserProfile>,
  ownerSet: ReadonlySet<string>,
  referenceDate: string | undefined,
  roleTag?: string,
): string {
  const time = formatMessageTime(message.ts, referenceDate);
  const author = formatAuthorBadge(message.authorId, message.origin, message.botName, users, ownerSet);
  const tag = roleTag ? ` [${roleTag}]` : '';
  const rendered = renderSlackText(message.text, users, ownerSet).trim();
  const filesNote = formatFilesInline(message.files);
  const filesTruncNote = message.filesTruncated ? '*(部分附件已省略)*' : '';
  const truncNote = message.textTruncated ? '*(正文过长已截断)*' : '';
  const lines = rendered ? rendered.split(/\r?\n/u) : [];
  const firstLine = lines[0] ? lines[0].replace(/^#/u, '\\#') : filesNote ? '' : '*(空消息)*';
  const rest = lines
    .slice(1)
    .map((line) => `  ${line.replace(/^#/u, '\\#')}`)
    .join('\n');
  const tail = [filesNote, filesTruncNote, truncNote].filter(Boolean).join(' ');
  const head = `- \`[${time}]\` ${author}${tag}: ${firstLine}${!rest && tail ? (firstLine ? ' ' : '') + tail : ''}`.trimEnd();
  if (!rest) return head;
  return `${head}\n${rest}${tail ? `\n  ${tail}` : ''}`;
}

function formatTriggerLabel(trigger: SlackThreadEvent['trigger']): string {
  switch (trigger) {
    case 'implicit_thread':
      return '活跃线程免 @ 跟帖';
    case 'wake_pattern':
      return '称呼唤醒';
    case 'edit_mention':
      return '编辑消息补 @ 唤醒';
    default:
      return '显式 @ 提及';
  }
}

function renderModernDescription(
  payload: PreparedEnvelope,
  marker: string,
  followup: boolean,
): string {
  const event = payload.eventPayload;
  const scene = structuredClone(payload.scene);
  const users = scene.directory?.users ?? {};
  const channel = scene.directory?.channel;
  const ownerSet = new Set(payload.ownerUserIds ?? []);

  const wirePayload: Record<string, unknown> = {
    schemaVersion: payload.schemaVersion,
    eventPayload: payload.eventPayload,
    ...(payload.replyContext ? { replyContext: payload.replyContext } : {}),
  };
  const wireJson = serializeEnvelope(wirePayload);
  const fence = '`'.repeat(
    (wireJson.match(/`+/gu) ?? []).reduce((n, run) => Math.max(n, run.length + 1), 3),
  );

  const buildMarkdown = (): string => {
    const channelHeader = formatChannelHeader(channel, event.channelId, users, ownerSet);
    const heading = `${followup ? '## Slack 线程追问' : '## Slack 请求'} · ${channelHeader}`;

    const sgt = formatSgtParts(event.messageTs);
    const refDate = sgt?.date;
    const senderBadge = formatAuthorBadge(event.senderUserId, 'human', undefined, users, ownerSet);
    const isRootMessage = event.messageTs === event.threadTs;
    const prevTs =
      scene.replies.at(-1)?.ts ??
      (followup
        ? (scene.sinceTs ?? scene.rootMessage?.ts)
        : !isRootMessage
          ? scene.rootMessage?.ts
          : scene.nearbyMessages.at(-1)?.ts);
    const gap = prevTs ? formatDurationGap(prevTs, event.messageTs) : undefined;
    const locationDesc = isRootMessage
      ? `会话根消息（\`${event.messageTs}\`）`
      : `线程回复（根 \`${event.threadTs}\` · 当前 \`${event.messageTs}\`${gap ? ` · 距上一条 ${gap}` : ''}）`;
    const permalink = buildSlackPermalink(event.channelId, event.messageTs, event.threadTs);

    const metaLines = [
      `- **发送者**：${senderBadge}`,
      `- **时间**：${sgt?.full ?? event.messageTs} · ${locationDesc}`,
      `- **触发与定位**：${formatTriggerLabel(event.trigger)} · [Slack 原消息](${permalink})`,
    ];
    if (!followup && channel?.topic) {
      metaLines.push(`- **频道说明**：${neutralizeControlMarkup(channel.topic)}`);
    }

    const sections: string[] = [heading, metaLines.join('\n')];

    if (!isRootMessage) {
      const historyLines: string[] = [];
      if (!followup && scene.rootMessage) {
        historyLines.push(renderMessageLine(scene.rootMessage, users, ownerSet, refDate, '线程根'));
      }
      if (scene.omittedEarlierReplies > 0) {
        historyLines.push(
          `- *…中间省略 ${scene.omittedEarlierReplies} 条较早回复；如需完整上下文请用 \`moe-slack\` 执行 \`replies --url "${permalink}"\`*`,
        );
      }
      for (const reply of scene.replies) {
        historyLines.push(renderMessageLine(reply, users, ownerSet, refDate));
      }
      if (historyLines.length > 0) {
        const title = followup ? '### 上次触发后的本线程新消息' : '### 当前线程前序对话';
        sections.push(`${title}\n\n${historyLines.join('\n')}`);
      }
    } else if (!followup && scene.nearbyMessages.length > 0) {
      const nearbyLines = scene.nearbyMessages.map((msg) =>
        renderMessageLine(msg, users, ownerSet, refDate),
      );
      sections.push(
        `### 触发前会话紧邻消息（近 10 分钟，仅供识别连发上下文）\n\n${nearbyLines.join('\n')}`,
      );
    }

    const clippedRaw = clip(event.text, 8192);
    const renderedRequest = renderSlackText(clippedRaw, users, ownerSet).trim();
    const quoteLines = (renderedRequest || '*(无文字正文)*')
      .split(/\r?\n/u)
      .map((line) => `> ${line}`)
      .join('\n');
    const truncSuffix =
      clippedRaw !== event.text ? '\n> *(展示已截断，完整原文见下方 eventPayload.text)*' : '';
    const reqFilesTail = [
      event.files.length ? formatFilesInline(event.files) : '',
      event.filesTruncated ? '*(部分附件已省略)*' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const reqAttachments = reqFilesTail ? `\n\n- ${reqFilesTail}` : '';
    sections.push(`### 本次消息\n\n${quoteLines}${truncSuffix}${reqAttachments}`);

    const includeRootAssets = !followup || !scene.sinceTs;
    const attachments = collectAttachmentsSummary(event.files, event.messageTs, scene, {
      includeRoot: includeRootAssets,
    });
    const guidanceLines = [REPLY_HINT];
    if (attachments.viewImages.length > 0) {
      const imgList = attachments.viewImages
        .map(
          (img) =>
            `\`${sanitizeCodeToken(img.fileId)}\` (${sanitizeInlineLabel(img.name || 'image') || 'image'})`,
        )
        .join('、');
      guidanceLines.push(
        `**必看图片（${attachments.viewImages.length} 张）**：判断意图前先用 \`moe-slack\` 下载查看：\`files_download --file-id <fileId> --types image --out <任务目录>\`，再逐张查看（${imgList}）。`,
      );
    }
    const anyFilesTruncated =
      Boolean(event.filesTruncated) ||
      Boolean(includeRootAssets && scene.rootMessage?.filesTruncated) ||
      scene.replies.some((m) => m.filesTruncated) ||
      scene.nearbyMessages.some((m) => m.filesTruncated);
    if (
      scene.hasSlackLinks ||
      scene.omittedEarlierReplies > 0 ||
      attachments.skippedImages > 0 ||
      attachments.otherFilesCount > 0 ||
      anyFilesTruncated
    ) {
      guidanceLines.push(
        `**按需主动补读**：涉及 Slack 消息链接、更早频道/线程讨论或未下载文件时，用 \`moe-slack\`（\`replies/get --url\`、\`history --channel ${sanitizeCodeToken(event.channelId)}\`、\`files_download\`）按需读取。`,
      );
    }
    sections.push(guidanceLines.join('\n\n'));
    sections.push(PAYLOAD_START, `${fence}json\n${wireJson}\n${fence}`, PAYLOAD_END);

    return `${marker}\n${sections.join('\n\n')}`;
  };

  let body = buildMarkdown();
  while (Buffer.byteLength(body) > 64 * 1024) {
    if (scene.nearbyMessages.length > 0) {
      scene.nearbyMessages.shift();
    } else if (scene.replies.length > 0) {
      scene.replies.shift();
      scene.omittedEarlierReplies += 1;
    } else {
      throw new Error('task_presentation_too_large');
    }
    body = buildMarkdown();
  }
  return body;
}

function quoteLegacyMessage(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/[\\`*_[\]{}()!#|~]/gu, '\\$&')
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join('\n');
}

export function formatTaskDescription(
  envelope: string,
  marker: string,
  followup = false,
): string {
  const payload = JSON.parse(envelope) as Record<string, unknown>;
  if (Number(payload.schemaVersion) >= SCHEMA_VERSION && isObject(payload.scene)) {
    return renderModernDescription(payload as unknown as PreparedEnvelope, marker, followup);
  }
  const event = payload.eventPayload as SlackThreadEvent;
  const raw = clip(event.text, 4096);
  const quote =
    quoteLegacyMessage(decodeSlackEntities(raw)) +
    (raw !== event.text ? '\n> （展示已截断，完整请求见数据区）' : '');
  const sgt = formatSgtParts(event.messageTs)?.full ?? '未知';
  const link = buildSlackPermalink(event.channelId, event.messageTs, event.threadTs);
  const json = serializeEnvelope(payload);
  const fence = '`'.repeat(
    (json.match(/`+/gu) ?? []).reduce((n, run) => Math.max(n, run.length + 1), 3),
  );
  const body = [
    `${marker}\n${followup ? '## Slack thread 后续消息' : '## Slack 原始消息'}`,
    REPLY_HINT,
    quote,
    `[原会话](${link}) · ${sgt}`,
    PAYLOAD_START,
    `${fence}json\n${json}\n${fence}`,
    PAYLOAD_END,
  ].join('\n\n');
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('task_presentation_too_large');
  return body;
}

export function readTaskEnvelope(
  description: string,
): { eventPayload: SlackThreadEvent; [key: string]: unknown } {
  const body = description.slice(description.indexOf('\n') + 1).replace(/\r\n/gu, '\n');
  let json = body;
  const lines = body.split('\n');
  const starts = lines.filter((line) => line === PAYLOAD_START);
  const ends = lines.filter((line) => line === PAYLOAD_END);
  if (starts.length || ends.length) {
    if (starts.length !== 1 || ends.length !== 1) throw new Error('invalid_thread_state');
    const start = lines.indexOf(PAYLOAD_START);
    const end = lines.indexOf(PAYLOAD_END);
    const block = lines
      .slice(start + 1, end)
      .join('\n')
      .trim();
    const match = block.match(/^(`{3,})json\n([\s\S]*)\n\1$/u);
    if (end < start || !match) throw new Error('invalid_thread_state');
    json = match[2]!;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('invalid_thread_state');
  }
  const event = isObject(parsed) ? parsed.eventPayload : undefined;
  if (
    !isObject(event) ||
    !['teamId', 'channelId', 'threadTs', 'messageTs'].every(
      (key) => typeof event[key] === 'string' && (event[key] as string).length > 0,
    ) ||
    !/^\d+\.\d+$/u.test(event.threadTs as string) ||
    !/^\d+\.\d+$/u.test(event.messageTs as string)
  ) {
    throw new Error('invalid_thread_state');
  }
  if (isObject(parsed) && Number(parsed.schemaVersion) >= 5 && Number(parsed.schemaVersion) < 7 && isObject(parsed.context)) {
    const restore = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(restore);
        return;
      }
      if (!isObject(value)) return;
      if (typeof value.ts === 'string' && typeof value.authorId === 'string') {
        value.origin ??= 'unknown';
        value.files ??= [];
        if (value.currentRequest === true) value.text ??= '';
      }
      Object.values(value).forEach(restore);
    };
    restore(parsed.context);
  }
  return parsed as { eventPayload: SlackThreadEvent; [key: string]: unknown };
}
