import { describe, expect, it, vi } from 'vitest';
import { resolveSlackDirectory } from '../src/slack-directory.js';
import { MemoryThreadStore, type ThreadStore } from '../src/thread-store.js';

const baseEvent = {
  teamId: 'T1',
  channelId: 'D0DM1',
  senderUserId: 'USENDER',
  mention: { type: 'user' as const, id: 'UOWNER' },
};

describe('resolveSlackDirectory resilience & priority', () => {
  it('promotes imUserId ahead of MAX_USER_LOOKUPS and skips user_not_visible without aborting', async () => {
    const store = new MemoryThreadStore();
    await store.set(
      'relay:dir:v1:user:T1:UOWNER',
      JSON.stringify({ id: 'UOWNER', name: 'Perfecto' }),
      3600,
    );
    await store.set('relay:dir:v1:ch:T1:D0DM1', '{corrupt-json', 3600);

    const manyMentions =
      Array.from({ length: 16 }, (_, i) => `<@UM${String(i).padStart(2, '0')}>`).join(' ') + ' <@UPEER>';
    const lookedUp: string[] = [];

    const f = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/conversations.info') {
        return Response.json({
          ok: true,
          channel: { id: 'D0DM1', is_im: true, user: 'UPEER', num_members: 2 },
        });
      }
      const uid = url.searchParams.get('user')!;
      lookedUp.push(uid);
      if (uid === 'UM00') {
        return Response.json({ ok: false, error: 'user_not_visible' });
      }
      return Response.json({
        ok: true,
        user: { id: uid, profile: { display_name: `name-${uid}` } },
      });
    });

    const res = await resolveSlackDirectory(baseEvent, [manyMentions], [], {
      token: 'xoxp-test',
      store,
      fetchImpl: f,
    });

    expect(res.channel).toEqual({ id: 'D0DM1', type: 'im', imUserId: 'UPEER', memberCount: 2 });
    expect(res.stats.channelCacheHit).toBe(false);
    expect(res.stats.userCacheHits).toBe(1);
    expect(res.users.UOWNER?.name).toBe('Perfecto');
    // UPEER was at position >12 in text mentions, but must be promoted to #1 for 1v1 DM header
    expect(lookedUp[0]).toBe('UPEER');
    expect(res.users.UPEER?.name).toBe('name-UPEER');
    // UM00 returned user_not_visible, yet subsequent lookups still succeeded
    expect(res.users.USENDER?.name).toBe('name-USENDER');
    expect(res.stats.userLookupCalls).toBeLessThanOrEqual(12);
  });

  it('fails open when Redis and Slack directory endpoints error or rate-limit', async () => {
    const brokenStore: ThreadStore = {
      get: async () => {
        throw new Error('redis_down');
      },
      mget: async () => {
        throw new Error('redis_down');
      },
      set: async () => {
        throw new Error('redis_down');
      },
      setIfAbsent: async () => false,
      releaseIfOwner: async () => {},
    };

    const res = await resolveSlackDirectory(
      { ...baseEvent, channelId: 'C0CHAN' },
      ['hello <@U2>'],
      ['U3'],
      {
        token: 'xoxp-test',
        store: brokenStore,
        fetchImpl: async () => new Response('rate limited', { status: 429 }),
      },
    );

    expect(res.channel).toEqual({ id: 'C0CHAN', type: 'unknown' });
    expect(res.users.USENDER).toEqual({ id: 'USENDER' });
  });
});
