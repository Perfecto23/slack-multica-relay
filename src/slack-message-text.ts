import { Buffer } from 'node:buffer';
import { extractSupplementalText } from './inbound-policy.js';

function object(value: unknown): value is Record<string, unknown> {
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

/** Recognize transient `--progress` status cards so they never self-trigger or pollute context. */
export function isRelayProgressMessage(raw: Record<string, unknown>): boolean {
  const blocks = raw.blocks;
  if (!Array.isArray(blocks) || blocks.length < 2 || !blocks.every(object)) return false;
  const last = blocks.at(-1)!;
  return (
    last.type === 'context' &&
    typeof last.block_id === 'string' &&
    /^relay-progress-[a-f0-9]{64}$/u.test(last.block_id)
  );
}

/** Recognize the Relay adapter's signed delivery block layout and extract body without footer. */
export function agentBody(raw: Record<string, unknown>, allowUserToken = false): string | undefined {
  if (!allowUserToken && !raw.bot_id && !raw.app_id) return undefined;
  const blocks = raw.blocks;
  if (!Array.isArray(blocks) || blocks.length < 2 || !blocks.every(object)) return undefined;
  const last = blocks.at(-1)!;
  if (
    last.type !== 'context' ||
    typeof last.block_id !== 'string' ||
    !/^relay-delivery-[a-f0-9]{64}$/u.test(last.block_id)
  ) {
    return undefined;
  }
  let split = blocks.length;
  while (split > 0) {
    const candidate = blocks[split - 1]!;
    if (
      candidate.type !== 'context' ||
      !Array.isArray(candidate.elements) ||
      candidate.elements.length !== 1 ||
      !object(candidate.elements[0]) ||
      candidate.elements[0].type !== 'mrkdwn' ||
      typeof candidate.elements[0].text !== 'string'
    ) {
      break;
    }
    split--;
  }
  if (split < 1 || split >= blocks.length) return undefined;
  const bodyBlocks = blocks.slice(0, split);
  let text: string | undefined;
  if (bodyBlocks.every((block) => block.type === 'section')) {
    const parts: string[] = [];
    for (const section of bodyBlocks) {
      if (
        section.fields !== undefined ||
        section.accessory !== undefined ||
        !object(section.text) ||
        section.text.type !== 'mrkdwn' ||
        typeof section.text.text !== 'string'
      ) {
        return undefined;
      }
      parts.push(section.text.text);
    }
    const isAdapterChunked =
      parts.length > 1 && parts.slice(0, -1).every((chunk) => Array.from(chunk).length === 3000);
    text = parts.join(isAdapterChunked ? '' : '\n\n');
  } else {
    const parts: string[] = [];
    for (const block of bodyBlocks) {
      const part = markdownPart(block);
      if (part === undefined) return undefined;
      parts.push(part);
    }
    text = parts.join('\n').replace(/\n{3,}/gu, '\n\n');
  }
  return text.trim() ? text : undefined;
}

/** Extract human-readable text + role from any Slack message, including Block Kit cards and forwards. */
export function extractMessageContent(raw: Record<string, unknown>): {
  text: string;
  origin: 'human' | 'agent_reply' | 'bot_or_app';
  botName?: string;
} {
  const selfBody = agentBody(raw, true);
  if (selfBody !== undefined) {
    return { text: selfBody, origin: 'agent_reply' };
  }
  let base = typeof raw.text === 'string' ? raw.text : '';
  if (!base.trim() && Array.isArray(raw.blocks)) {
    const renderedBlocks = renderLooseBlocks(raw.blocks);
    if (renderedBlocks) base = renderedBlocks;
  }
  const combined = extractSupplementalText(raw, base);
  const isBot = Boolean(raw.bot_id || raw.app_id || raw.subtype === 'bot_message');
  let botName: string | undefined;
  if (isBot) {
    const profileName = object(raw.bot_profile) && typeof raw.bot_profile.name === 'string'
      ? raw.bot_profile.name.trim()
      : '';
    const username = typeof raw.username === 'string' ? raw.username.trim() : '';
    const picked = profileName || username;
    if (picked) botName = clipUtf8(picked.replace(/\s+/gu, ' '), 80);
  }
  return {
    text: combined,
    origin: isBot ? 'bot_or_app' : 'human',
    ...(botName ? { botName } : {}),
  };
}

function renderLooseBlocks(blocks: unknown[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (!object(block)) continue;
    const part = markdownPart(block);
    if (part !== undefined && part.trim()) {
      out.push(part.trim());
      continue;
    }
    if (block.type === 'section') {
      const pieces: string[] = [];
      if (object(block.text) && typeof block.text.text === 'string' && block.text.text.trim()) {
        pieces.push(block.text.text.trim());
      }
      if (Array.isArray(block.fields)) {
        for (const field of block.fields) {
          if (object(field) && typeof field.text === 'string' && field.text.trim()) {
            pieces.push(field.text.trim());
          }
        }
      }
      if (pieces.length) out.push(pieces.join('\n'));
    }
  }
  return out.join('\n\n').trim();
}

function inline(elements: unknown): string {
  if (!Array.isArray(elements)) return '';
  return elements
    .map((element) => {
      if (!object(element)) return '';
      switch (element.type) {
        case 'text': {
          const text = typeof element.text === 'string' ? element.text : '';
          const style = object(element.style) ? element.style : {};
          if (style.code) return '`' + text + '`';
          let formatted = text;
          if (style.bold) formatted = `**${formatted}**`;
          if (style.italic) formatted = `*${formatted}*`;
          if (style.strike) formatted = `~~${formatted}~~`;
          return formatted;
        }
        case 'link':
          return typeof element.text === 'string' && element.text
            ? `[${element.text}](${String(element.url)})`
            : String(element.url ?? '');
        case 'emoji':
          return `:${String(element.name)}:`;
        case 'user':
          return `<@${String(element.user_id)}>`;
        case 'usergroup':
          return `<!subteam^${String(element.usergroup_id)}>`;
        case 'channel':
          return `<#${String(element.channel_id)}>`;
        case 'broadcast':
          return `<!${String(element.range)}>`;
        default:
          return typeof element.text === 'string'
            ? element.text
            : typeof element.fallback === 'string'
              ? element.fallback
              : '';
      }
    })
    .join('');
}

function richText(block: Record<string, unknown>): string | undefined {
  if (!Array.isArray(block.elements)) return undefined;
  const lines: string[] = [];
  for (const element of block.elements) {
    if (!object(element)) return undefined;
    if (element.type === 'rich_text_section') {
      lines.push(inline(element.elements));
    } else if (element.type === 'rich_text_quote') {
      lines.push(
        inline(element.elements)
          .split('\n')
          .map((line) => '> ' + line)
          .join('\n'),
      );
    } else if (element.type === 'rich_text_preformatted') {
      lines.push('```\n' + inline(element.elements) + '\n```');
    } else if (element.type === 'rich_text_list' && Array.isArray(element.elements)) {
      const safeIndent =
        typeof element.indent === 'number' && Number.isFinite(element.indent)
          ? Math.min(8, Math.max(0, Math.floor(element.indent)))
          : 0;
      const indent = '  '.repeat(safeIndent);
      lines.push(
        element.elements
          .map(
            (item, index) =>
              indent +
              (element.style === 'ordered' ? `${index + 1}. ` : '- ') +
              (object(item) ? inline(item.elements) : ''),
          )
          .join('\n'),
      );
    } else {
      return undefined;
    }
  }
  return lines.join('\n').replace(/\n+$/u, '');
}

function markdownPart(block: Record<string, unknown>): string | undefined {
  if (block.type === 'markdown') return typeof block.text === 'string' ? block.text : undefined;
  if (block.type === 'rich_text') return richText(block);
  if (block.type === 'header') {
    const safeLevel =
      typeof block.level === 'number' && Number.isFinite(block.level)
        ? Math.min(6, Math.max(1, Math.floor(block.level)))
        : 1;
    return object(block.text) && typeof block.text.text === 'string'
      ? '#'.repeat(safeLevel) + ' ' + block.text.text
      : undefined;
  }
  if (block.type === 'divider') return '---';
  if (block.type === 'table' && Array.isArray(block.rows)) {
    const rows = block.rows.map((row) =>
      Array.isArray(row)
        ? row.map((cell) => (object(cell) && cell.type === 'rich_text' ? richText(cell) ?? '' : ''))
        : [],
    );
    return rows
      .map(
        (row, index) =>
          '| ' + row.join(' | ') + ' |' + (index === 0 ? '\n|' + row.map(() => '---').join('|') + '|' : ''),
      )
      .join('\n');
  }
  return undefined;
}
