import { describe, expect, it } from 'vitest';
import { coverageGuidance, normalizeContext, noteOmission, summarizeCoverage } from '../src/context-coverage.js';
import { buildEnvelope, mergeParticipants, type ContextMessage, type ContextSection, type ThreadContext } from '../src/context-envelope.js';
import type { SlackThreadEvent } from '../src/thread-router.js';
import { formatTaskDescription, readTaskEnvelope } from '../src/task-presentation.js';

const node = (ts: string, extra: Partial<ContextMessage> = {}): ContextMessage => ({ ts, authorId: 'U1', origin: 'unknown', text: ts, files: [], ...extra });
const context = (timeline: ContextSection, extra: Partial<ThreadContext> = {}): ThreadContext =>
  ({ anchorTs: '100.000001', cutoffTs: '300.000001', capturedAt: 'fixed', timeline, ...extra });
const current = (replies: ContextSection = { status: 'complete', messages: [node('300.000001')] }) => node('100.000001', { replies });

describe('section omissions', () => {
  it('accumulates reasons and lets a missing reason outrank a selection', () => {
    const section: ContextSection = { status: 'complete', messages: [] };
    noteOmission(section, 'timeline_root_limit');
    expect(section).toMatchObject({ status: 'selected', reasons: ['timeline_root_limit'] });
    noteOmission(section, 'read_failed'); noteOmission(section, 'timeline_root_limit');
    expect(section).toMatchObject({ status: 'missing', reasons: ['timeline_root_limit', 'read_failed'] });
  });

  it('normalizes schema-5 sections and initial background status', () => {
    const legacy = { anchorTs: '1.000001', cutoffTs: '2.000001', capturedAt: '', initialStatus: 'truncated', initialReason: 'timeline_root_limit',
      timeline: { status: 'truncated', reason: 'timeline_root_limit', messages: [{ ...node('1.000001'), replies: { status: 'unavailable', reason: 'not_in_channel', messages: [] } }] } };
    const normalized = normalizeContext(legacy as unknown as ThreadContext);
    expect(normalized.timeline).toMatchObject({ status: 'selected', reasons: ['timeline_root_limit'] });
    expect(normalized.timeline.messages[0]!.replies).toEqual({ status: 'missing', reasons: ['not_in_channel'], messages: [] });
    expect(normalized).toMatchObject({ initialStatus: 'selected', initialReasons: ['timeline_root_limit'] });
    expect(JSON.stringify(normalized)).not.toContain('"reason"');
  });
});

describe('coverage summary', () => {
  it('reports the current thread complete even when nearby roots hit the policy cap', () => {
    const timeline: ContextSection = { status: 'complete', messages: [node('90.000001'), current()] };
    noteOmission(timeline, 'timeline_root_limit');
    const coverage = summarizeCoverage(context(timeline));
    expect(coverage.currentThread).toEqual({ status: 'complete' });
    expect(coverage.nearby).toEqual({ status: 'selected', reasons: ['timeline_root_limit'], roots: 1 });
    const text = coverageGuidance(coverage, {}).join('\n');
    expect(text).toContain('不必重读');
    expect(text).toContain('附近讨论按范围选取（首次 mention 前 30 分钟内最多取 12 条主消息）；没选入的消息不算缺失。');
    expect(text).not.toContain('仅在原会话');
  });

  it('splits reference reasons out of the first background and words selections by reason', () => {
    const timeline: ContextSection = { status: 'complete', messages: [node('90.000001'), current()] };
    noteOmission(timeline, 'thread_reply_selection');
    const coverage = summarizeCoverage(context(timeline, { initialStatus: 'missing', initialReasons: ['context_byte_limit', 'reference_unavailable'] }));
    expect(coverage.nearby).toEqual({ status: 'selected', reasons: ['thread_reply_selection', 'context_byte_limit'], roots: 1 });
    expect(coverage.references).toEqual({ status: 'missing', reasons: ['reference_unavailable'], count: 0 });
    const text = coverageGuidance(coverage, {}).join('\n');
    expect(text).toContain('只展开最近活跃的 2 个线程的回复，为控制大小省略了较早的背景');
    expect(text).toContain('链接引用有部分没读到（reference_unavailable）');
    expect(text).not.toContain('附近讨论有部分没读到');
  });

  it('keeps references, initial background and attachments apart from the current thread', () => {
    const failedReply: ContextSection = { status: 'complete', messages: [] };
    noteOmission(failedReply, 'read_failed');
    const timeline: ContextSection = { status: 'complete', messages: [
      node('80.000001', { contentStatus: 'unavailable', change: 'referenced' }),
      node('90.000001', { replies: failedReply, files: [{ id: 'F1', name: 'a.png', mime: 'image/png', contentStatus: 'not_loaded' }] }),
      current(),
    ] };
    const coverage = summarizeCoverage(context(timeline, { initialStatus: 'selected', initialReasons: ['timeline_root_limit'] }));
    expect(coverage.currentThread.status).toBe('complete');
    expect(coverage.nearby).toEqual({ status: 'missing', reasons: ['read_failed', 'timeline_root_limit'], roots: 1 });
    expect(coverage.references).toEqual({ status: 'missing', reasons: ['reference_target_missing'], count: 1 });
    expect(coverage.attachments).toEqual({ view: [], listedOnly: 1 });
    expect(coverageGuidance(coverage, {}).join('\n')).toContain('还有 1 个附件只列了引用');
  });
});

describe('images to view', () => {
  const file = (id: string, mime = 'image/png', size = 1000) => ({ id, name: id + '.png', mime, size, contentStatus: 'not_loaded' as const });

  it('lists request and current-thread images newest first, capped and size-limited', () => {
    const replies: ContextSection = { status: 'complete', messages: [
      node('200.000001', { files: [file('F2'), file('F3', 'application/pdf')] }),
      node('250.000001', { files: [file('F4'), file('F5'), file('F6'), file('F7'), file('BIG', 'image/jpeg', 11 * 1024 * 1024)] }),
    ] };
    const root = node('100.000001', { replies, files: [file('F1')] });
    const side = node('90.000001', { files: [file('S1')] });
    const coverage = summarizeCoverage(context({ status: 'complete', messages: [side, root] }), { messageTs: '300.000001', files: [file('R1')] });
    expect(coverage.attachments.view.map(v => v.fileId)).toEqual(['R1', 'F4', 'F5', 'F6', 'F7', 'F2']);
    expect(coverage.attachments.view[0]).toMatchObject({ messageTs: '300.000001', mime: 'image/png', size: 1000 });
    expect(coverage.attachments.skipped).toEqual([
      { fileId: 'BIG', messageTs: '250.000001', reason: 'too_large' },
      { fileId: 'F1', messageTs: '100.000001', reason: 'view_limit' },
    ]);
    expect(coverage.attachments.listedOnly).toBe(2);
    const text = coverageGuidance(coverage, {}).join('\n');
    expect(text).toContain('先看 coverage.attachments.view 里的 6 张图片');
    expect(text).toContain('--types image');
    expect(text).toContain('另有 2 张图片');
  });

  it('caps skipped images, counts the rest and keeps a long image thread within the envelope budget', () => {
    const replies: ContextSection = { status: 'complete', messages: Array.from({ length: 40 }, (_, i) =>
      node(`${200 + i}.000001`, { files: [file(`I${i}`)] })) };
    const coverage = summarizeCoverage(context({ status: 'complete', messages: [node('100.000001', { replies })] }));
    expect(coverage.attachments.view).toHaveLength(6);
    expect(coverage.attachments.skipped).toHaveLength(10);
    expect(coverage.attachments.listedOnly).toBe(24);
    expect(coverage.attachments.view[0]!.fileId).toBe('I39');
  });

  it('recognizes an image by extension when Slack sent no mime type, and orders by timestamp', () => {
    const replies: ContextSection = { status: 'complete', messages: [
      node('260.000001', { files: [file('LATE')] }), node('210.000001', { files: [{ id: 'EXT', name: 'shot.JPG', mime: '', contentStatus: 'not_loaded' }] }),
    ] };
    const coverage = summarizeCoverage(context({ status: 'complete', messages: [node('100.000001', { replies })] }));
    expect(coverage.attachments.view.map(v => v.fileId)).toEqual(['LATE', 'EXT']);
    expect(coverage.attachments.view[1]).not.toHaveProperty('size');
  });

  it('writes the view list into the envelope from the request files', () => {
    const event = { teamId: 'T1', channelId: 'C1', threadTs: '100.000001', messageTs: '300.000001', senderUserId: 'U1', text: 'look',
      mention: { type: 'user', id: 'U2' }, files: [{ id: 'R1', name: 'shot.png', mimetype: 'image/png', size: 10 }] } as unknown as SlackThreadEvent;
    const envelope = JSON.parse(buildEnvelope(event, context({ status: 'complete', messages: [current()] })));
    expect(envelope.coverage.attachments).toEqual({ view: [{ fileId: 'R1', name: 'shot.png', mime: 'image/png', size: 10, messageTs: '300.000001' }], listedOnly: 0 });
  });
});

describe('envelope', () => {
  const event = { teamId: 'T1', channelId: 'C1', threadTs: '100.000001', messageTs: '300.000001', senderUserId: 'U1', text: 'go',
    mention: { type: 'user', id: 'U2' }, files: [] } as unknown as SlackThreadEvent;

  it('writes schema 6 with coverage and guidance generated from it', () => {
    const timeline: ContextSection = { status: 'complete', messages: [node('90.000001'), current()] };
    noteOmission(timeline, 'timeline_root_limit');
    const envelope = JSON.parse(buildEnvelope(event, context(timeline)));
    expect(envelope.schemaVersion).toBe(6);
    expect(envelope.coverage.currentThread.status).toBe('complete');
    expect(envelope.task.instructions.join('\n')).toContain('不必重读');
  });

  it('refreshes coverage after the byte budget removes optional roots', () => {
    const big = node('90.000001', { text: 'x'.repeat(49 * 1024) });
    const envelope = JSON.parse(buildEnvelope(event, context({ status: 'complete', messages: [big, current()] })));
    expect(envelope.coverage.nearby).toMatchObject({ status: 'selected', reasons: ['context_byte_limit'], roots: 0 });
    expect(envelope.coverage.currentThread.status).toBe('complete');
  });
});

describe('byte budget on linked messages', () => {
  const event = { teamId: 'T1', channelId: 'C1', threadTs: '100.000001', messageTs: '300.000001', senderUserId: 'U1', text: 'go',
    mention: { type: 'user', id: 'U2' }, files: [] } as unknown as SlackThreadEvent;

  it('reports a dropped linked root as a reference gap, not a selection', () => {
    const linked = node('90.000001', { change: 'referenced', text: 'x'.repeat(49 * 1024) });
    const envelope = JSON.parse(buildEnvelope(event, context({ status: 'complete', messages: [linked, current()] })));
    expect(envelope.coverage.references).toEqual({ status: 'missing', reasons: ['reference_byte_limit'], count: 0 });
    expect(envelope.coverage.currentThread.status).toBe('complete');
  });

  it('reports dropped linked replies before the last mention as a reference gap', () => {
    const replies: ContextSection = { status: 'complete', messages: [node('150.000001', { change: 'referenced', text: 'x'.repeat(49 * 1024) }), node('250.000001'), node('300.000001')] };
    const envelope = JSON.parse(buildEnvelope(event, context({ status: 'complete', messages: [current(replies)] }, { sinceTs: '250.000001' })));
    expect(envelope.coverage.currentThread.status).toBe('complete');
    expect(envelope.coverage.references).toMatchObject({ status: 'missing', reasons: ['reference_byte_limit'] });
  });
});

describe('task presentation', () => {
  it('round-trips a schema 6 envelope with coverage', () => {
    const event = { teamId: 'T1', channelId: 'C1', threadTs: '100.000001', messageTs: '300.000001', senderUserId: 'U1', text: 'go',
      mention: { type: 'user', id: 'U2' }, files: [] } as unknown as SlackThreadEvent;
    const envelope = buildEnvelope(event, context({ status: 'complete', messages: [current()] }));
    const parsed = readTaskEnvelope(formatTaskDescription(envelope, '<!-- relay-thread:x -->'));
    expect(parsed.schemaVersion).toBe(6);
    expect((parsed.coverage as { currentThread: unknown }).currentThread).toEqual({ status: 'complete' });
    expect(((parsed.context as ThreadContext).timeline.messages[0]!.replies!.messages[0])).toMatchObject({ origin: 'unknown', files: [] });
  });
});

describe('participants', () => {
  it('prefers fresh names and keeps a stored one only when the fresh lookup found none', () => {
    expect(mergeParticipants([{ id: 'U1', name: 'Old' }, { id: 'U2', name: 'Kept' }], [{ id: 'U1', name: 'New' }, { id: 'U2' }, { id: 'U3' }]))
      .toEqual([{ id: 'U1', name: 'New' }, { id: 'U2', name: 'Kept' }, { id: 'U3' }]);
  });
});
