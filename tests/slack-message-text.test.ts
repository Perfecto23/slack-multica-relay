import { expect, it } from 'vitest';
import { agentBody, extractMessageContent } from '../src/slack-message-text.js';
import { readContext } from '../src/slack-context.js';

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string, block_id?: string) => ({
  type: 'context',
  ...(block_id ? { block_id } : {}),
  elements: [{ type: 'mrkdwn', text }],
});
const marker = 'relay-delivery-' + 'a'.repeat(64);
const raw = {
  bot_id: 'B1',
  text: 'flattened body plus footer',
  blocks: [
    section('Body\nSent by is part of the quotation :doge:'),
    context('stats'),
    context('Sent by Agent', marker),
  ],
};

it('removes recognized footer blocks and preserves body text, line breaks and emoji', () => {
  expect(agentBody(raw)).toBe('Body\nSent by is part of the quotation :doge:');
});

it('reconstructs Unicode bodies split at the adapter chunk boundary and multi-paragraph sections', () => {
  const first = '😀'.repeat(3000);
  expect(agentBody({ ...raw, blocks: [section(first), section('tail'), context('footer', marker)] })).toBe(
    first + 'tail',
  );
  expect(agentBody({ ...raw, blocks: [section('para 1'), section('para 2'), context('footer', marker)] })).toBe(
    'para 1\n\npara 2',
  );
});

it('preserves humans, unmarked bots and unsupported structures', () => {
  for (const message of [
    { ...raw, bot_id: undefined },
    { ...raw, blocks: [section('body'), context('Sent by Agent')] },
    { ...raw, blocks: [{ ...section('body'), fields: [{ text: 'important' }] }, context('footer', marker)] },
    { ...raw, blocks: [section('body'), { type: 'image', image_url: 'https://example.test/image' }, context('footer', marker)] },
    { ...raw, blocks: [section('body'), { type: 'context', elements: [{ type: 'image' }] }, context('footer', marker)] },
    { ...raw, blocks: [section('body'), context('footer', 'relay-delivery-invalid')] },
  ]) {
    expect(agentBody(message)).toBeUndefined();
  }
});

it('projects recognized agent replies as agent_reply and extracts rich card/forward content', async () => {
  const event = {
    teamId: 'T1',
    channelId: 'C1',
    threadTs: '100.000001',
    messageTs: '103.000001',
    senderUserId: 'U1',
    text: 'new request',
    mention: { type: 'user' as const, id: 'U2' },
  };
  const cardMessage = {
    ts: '102.000001',
    bot_id: 'B9',
    bot_profile: { name: 'Sentry' },
    thread_ts: event.threadTs,
    text: '',
    attachments: [{ title: 'TypeError in handler', text: 'Cannot read properties of undefined' }],
  };
  const data = await readContext(
    event,
    'fixture',
    async () =>
      Response.json({
        ok: true,
        messages: [
          { ts: event.threadTs, user: 'U1', text: 'root' },
          {
            ...raw,
            ts: '101.000001',
            user: 'U2',
            thread_ts: event.threadTs,
            files: [{ id: 'F1', name: 'file.txt', mimetype: 'text/plain' }],
          },
          cardMessage,
        ],
      }),
    { includeNearby: false },
  );
  expect(data.replies[0]).toMatchObject({
    ts: '101.000001',
    authorId: 'U2',
    origin: 'agent_reply',
    text: agentBody(raw),
  });
  expect(data.replies[0]!.files).toHaveLength(1);
  expect(data.replies[1]).toMatchObject({
    ts: '102.000001',
    authorId: 'B9',
    origin: 'bot_or_app',
    botName: 'Sentry',
  });
  expect(data.replies[1]!.text).toContain('TypeError in handler');
  expect(data.replies[1]!.text).toContain('Cannot read properties of undefined');
  expect(
    extractMessageContent({
      text: '',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Alert*: pod crashed' } }],
    }).text,
  ).toBe('*Alert*: pod crashed');
});

const t = (text: string, style?: Record<string, boolean>) => ({
  type: 'text',
  text,
  ...(style ? { style } : {}),
});
const sectionRich = (...elements: unknown[]) => ({ type: 'rich_text_section', elements });
const cell = (text: string) => ({ type: 'rich_text', block_id: 'c', elements: [sectionRich(t(text))] });
const storedMarkdown = {
  app_id: 'A1',
  user: 'U2',
  text: 'flattened',
  blocks: [
    { type: 'rich_text', block_id: 'a', elements: [sectionRich(t('结论：'), t('\n\n'))] },
    { type: 'header', block_id: 'b', text: { type: 'plain_text', text: '小标题', emoji: true }, level: 2 },
    {
      type: 'rich_text',
      block_id: 'd',
      elements: [
        sectionRich(
          t('粗体', { bold: true }),
          t('、'),
          t('斜体', { italic: true }),
          t('、'),
          t('删除', { strike: true }),
          t('、'),
          t('code', { code: true }),
          t(' 见 '),
          { type: 'link', url: 'https://example.test/pr/1', text: 'PR #1' },
          t('\n\n'),
        ),
        { type: 'rich_text_list', style: 'bullet', indent: 0, elements: [sectionRich(t('一'))] },
        { type: 'rich_text_list', style: 'bullet', indent: 1, elements: [sectionRich(t('嵌套'))] },
        {
          type: 'rich_text_list',
          style: 'ordered',
          indent: 0,
          elements: [sectionRich(t('甲')), sectionRich(t('乙'))],
        },
        { type: 'rich_text_quote', elements: [t('引用')] },
      ],
    },
    { type: 'table', block_id: 'e', rows: [[cell('项'), cell('结果')], [cell('表格'), cell('正常')]] },
    {
      type: 'rich_text',
      block_id: 'f',
      elements: [
        { type: 'rich_text_preformatted', language: 'python', elements: [t('print(1)')] },
        sectionRich(t('\n'), t('表情 '), { type: 'emoji', name: 'doge' }, t(' 好～')),
      ],
    },
    context('stats'),
    context('Sent by Agent', marker),
  ],
};

it('recognizes the rich_text layout Slack stores for a markdown block including italic and strike', () => {
  expect(agentBody(storedMarkdown)).toBe(
    '结论：\n## 小标题\n**粗体**、*斜体*、~~删除~~、`code` 见 [PR #1](https://example.test/pr/1)\n\n- 一\n  - 嵌套\n1. 甲\n2. 乙\n> 引用\n| 项 | 结果 |\n|---|---|\n| 表格 | 正常 |\n```\nprint(1)\n```\n\n表情 :doge: 好～',
  );
  expect(agentBody({ ...storedMarkdown, blocks: [{ type: 'markdown', text: '**hi**' }, context('Sent by Agent', marker)] })).toBe(
    '**hi**',
  );
  expect(
    agentBody({ ...storedMarkdown, blocks: [{ type: 'rich_text', elements: [{ type: 'unknown_element' }] }, context('Sent by Agent', marker)] }),
  ).toBeUndefined();
  expect(
    agentBody({ ...storedMarkdown, blocks: [{ type: 'rich_text', elements: [sectionRich(t('x'))] }, context('Sent by Agent')] }),
  ).toBeUndefined();
});

it('clamps negative, fractional, NaN, or huge rich_text_list indent and header level without throwing RangeError', () => {
  const weirdBlocks = {
    text: '',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'NegHeader' }, level: -5 },
      { type: 'header', text: { type: 'plain_text', text: 'HugeHeader' }, level: 999999 },
      {
        type: 'rich_text',
        elements: [
          { type: 'rich_text_list', style: 'bullet', indent: -3, elements: [sectionRich(t('neg'))] },
          { type: 'rich_text_list', style: 'bullet', indent: 1e9, elements: [sectionRich(t('deep'))] },
        ],
      },
    ],
  };
  const out = extractMessageContent(weirdBlocks);
  expect(out.text).toContain('# NegHeader');
  expect(out.text).toContain('###### HugeHeader');
  expect(out.text).toContain('- neg');
  expect(out.text).toContain('                - deep');
});
