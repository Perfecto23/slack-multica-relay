import type { SlackThreadEvent } from './thread-router.js';

export type SessionStatus = 'processing' | 'active' | 'suspended';

/** Session status is presentation state; failure must not replay a persisted task. */
export async function setSlackSessionStatus(
  token: string | undefined,
  event: Pick<SlackThreadEvent, 'channelId' | 'threadTs' | 'senderUserId'>,
  status: SessionStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!token) return;
  try {
    const response = await fetchImpl('https://slack.com/api/agents.sessions.setStatus', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel_id: event.channelId, thread_ts: event.threadTs, status,
        ...(status === 'processing' ? { initiator_user_id: event.senderUserId } : {}) }),
      signal: AbortSignal.timeout(2000),
    });
    const body: unknown = await response.json();
    if (!response.ok || !body || typeof body !== 'object' || !('ok' in body) || body.ok !== true)
      console.warn('relay_session', { reason: 'status_unavailable', status });
  } catch {
    console.warn('relay_session', { reason: 'status_unavailable', status });
  }
}
