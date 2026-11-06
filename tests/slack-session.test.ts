import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSlackSessionStatus } from '../src/slack-session.js';
const event = { channelId: 'C1', threadTs: '1.000001', senderUserId: 'U1' };
afterEach(() => vi.restoreAllMocks());
describe('native Slack session status', () => {
  it('uses bot status identity and the exact thread', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, agent_status: 'processing' }));
    await setSlackSessionStatus('status-token', event, 'processing', fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://slack.com/api/agents.sessions.setStatus');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ channel_id: 'C1', thread_ts: '1.000001', status: 'processing', initiator_user_id: 'U1' });
  });
  it('does nothing without opt-in and contains Slack errors without leaking content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private token or upstream text'));
    await setSlackSessionStatus(undefined, event, 'active', fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    await setSlackSessionStatus('status-token', event, 'active', fetcher);
    expect(warn).toHaveBeenCalledWith('relay_session', { reason: 'status_unavailable', status: 'active' });
  });
});
