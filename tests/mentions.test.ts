import { describe, expect, it } from 'vitest';
import { findTargetMention, isSupportedMessage } from '../src/mentions.js';

describe('findTargetMention', () => {
  it('matches a target user mention', () => {
    expect(findTargetMention('请看 <@U123|Alice>', new Set(['U123']), new Set())).toEqual({ type: 'user', id: 'U123' });
  });

  it('matches a target subteam mention', () => {
    expect(findTargetMention('<!subteam^S123|team> 处理一下', new Set(), new Set(['S123']))).toEqual({ type: 'subteam', id: 'S123' });
  });

  it('ignores non-target mentions', () => {
    expect(findTargetMention('<@U999>', new Set(['U123']), new Set())).toBeUndefined();
  });
});

describe('isSupportedMessage', () => {
  it.each([
    'channel_join',
    'group_join',
    'channel_leave',
    'group_leave',
    'channel_topic',
    'channel_purpose',
    'pinned_item',
    'message_changed',
    'message_deleted',
  ])('filters non-conversational Slack subtype %s at ingress', (subtype) => {
    expect(
      isSupportedMessage({
        type: 'message',
        channel: 'C1',
        ts: '100.000001',
        user: 'U1',
        text: '<@U1> has joined the channel',
        subtype,
      }),
    ).toBe(false);
  });

  it.each([undefined, 'file_share', 'thread_broadcast', 'bot_message'])(
    'retains conversational subtype %s for downstream author verification',
    (subtype) => {
      expect(
        isSupportedMessage({
          type: 'message',
          channel: 'C1',
          ts: '100.000001',
          user: 'U2',
          text: '<@U1> 看一下',
          ...(subtype ? { subtype } : {}),
        }),
      ).toBe(true);
    },
  );
});
