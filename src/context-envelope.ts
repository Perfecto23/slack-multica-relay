import { Buffer } from 'node:buffer';
import type { SlackReplyContext } from './multica-api.js';
import { createHash } from 'node:crypto';
import type { SlackThreadEvent } from './thread-router.js';
import { coverageGuidance, noteOmission, summarizeCoverage, type SectionStatus } from './context-coverage.js';

export interface ContextMessage {
  ts: string;
  authorId: string;
  origin: 'bot_or_app' | 'unknown';
  text: string;
  files: { id: string; name: string; mime: string; size?: number; contentStatus: 'not_loaded' }[];
  change?: 'new' | 'updated' | 'referenced' | 'context';
  replies?: ContextSection;
  currentRequest?: boolean;
  restoredFrom?: 'persisted_request';
  footerOmitted?: boolean;
  contentStatus?: 'unavailable';
  textTruncated?: boolean;
  filesTruncated?: boolean;
  /** Hash of the untruncated Slack content. It is used for change detection only. */
  sourceFingerprint?: string;
}
export interface ContextSection {
  status: SectionStatus;
  messages: ContextMessage[];
  /** Why the section is selected or missing; appended, never overwritten. */
  reasons?: string[];
  reconstructed?: boolean;
  coveredFromTs?: string;
  coveredThroughTs?: string;
}
export interface ThreadContext {
  /** Last persisted mention, inclusive in the snapshot; absent means root through cutoff. */
  sinceTs?: string;
  /** Nearby context remains anchored to the first accepted mention. */
  initialCutoffTs?: string;
  initialStatus?: ContextSection['status'];
  initialReasons?: string[];
  selectionStats?: { unchangedRoots: number; rootLimit: number; omittedSiblingReplies: number; currentReplyLimit: number };
  readStats?: { slackCalls: number; rawMessages: number; messageReadMs?: number; nameLookupCalls?: number; nameReadMs?: number };
  selection?: { mode: 'full' | 'focused'; baseline: 'available' | 'unavailable'; omittedRoots: number; omittedCurrentReplies: number; added?: number; updated?: number; referenced?: number };
  participants?: { id: string; name?: string }[];
  anchorTs: string;
  cutoffTs: string;
  capturedAt: string;
  timeline: ContextSection;
}

export const timestampValid = (ts: unknown): ts is string => typeof ts === 'string' && /^\d+\.\d{1,6}$/.test(ts);
export function compareTs(a: string, b: string): number {
  const micro = (s: string) => { const [sec, fraction] = s.split('.'); return BigInt(sec!) * 1_000_000n + BigInt(fraction!.padEnd(6, '0')); };
  return micro(a) < micro(b) ? -1 : micro(a) > micro(b) ? 1 : 0;
}
export function clip(text: string, bytes: number): string {
  let result = '', used = 0;
  for (const char of text) { const n = Buffer.byteLength(char); if (used + n > bytes) break; result += char; used += n; }
  return result;
}
export function projectFiles(value: unknown, limit = 5): ContextMessage['files'] {
  if (!Array.isArray(value)) return [];
  return value.filter(x => x && typeof x.id === 'string').slice(0, limit).map(x => ({
    id: clip(x.id, 128), name: clip(typeof x.name === 'string' ? x.name : '', 256),
    mime: clip(typeof x.mime === 'string' ? x.mime : typeof x.mimetype === 'string' ? x.mimetype : '', 128),
    ...(typeof x.size === 'number' && Number.isFinite(x.size) ? { size: x.size } : {}),
    contentStatus: 'not_loaded' as const,
  }));
}
export function sourceMessageFingerprint(raw: Record<string, unknown>): string {
  const files = Array.isArray(raw.files) ? raw.files.filter(x => x && typeof x.id === 'string').map(x => ({
    id: x.id,
    name: typeof x.name === 'string' ? x.name : '',
    mime: typeof x.mime === 'string' ? x.mime : typeof x.mimetype === 'string' ? x.mimetype : '',
    size: typeof x.size === 'number' && Number.isFinite(x.size) ? x.size : null,
  })) : [];
  const content = { ts:String(raw.ts), authorId:typeof raw.user === 'string' ? raw.user : typeof raw.bot_id === 'string' ? raw.bot_id : '',
    origin:raw.bot_id || raw.app_id ? 'bot_or_app' : 'unknown', text:typeof raw.text === 'string' ? raw.text : '', files };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
/** Fresh lookups win; a stored name only fills in when the fresh read found none. */
export function mergeParticipants(stored: ThreadContext['participants'] = [], fresh: ThreadContext['participants'] = []): NonNullable<ThreadContext['participants']> {
  const people = new Map(stored.map(p => [p.id, p]));
  for (const person of fresh) {
    const name = person.name ?? people.get(person.id)?.name;
    people.set(person.id, { ...person, ...(name ? { name } : {}) });
  }
  return [...people.values()];
}
export function updateCoverage(s: ContextSection): void {
  delete s.coveredFromTs; delete s.coveredThroughTs;
  if (s.messages.length) { s.coveredFromTs = s.messages[0]!.ts; s.coveredThroughTs = s.messages.at(-1)!.ts; }
}
// Escape platform routing syntax as well as HTML markers while preserving JSON round trips.
export function serializeEnvelope(value: unknown, space?: number): string {
  return JSON.stringify(value,null,space).replace(/"(?:\\.|[^"\\])*"/g, token => token.replace(/[<>\[\]]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
}
export function messageFingerprint(m: ContextMessage): string {
  if (m.sourceFingerprint) return m.sourceFingerprint;
  const content={ts:m.ts,authorId:m.authorId,origin:m.origin,text:m.text,files:m.files,
    contentStatus:m.contentStatus,textTruncated:m.textTruncated,filesTruncated:m.filesTruncated};
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
/** Apply the current nearby policy when recovering a pre-v5 first Issue. */
export function compactInitialContext(input:ThreadContext):ThreadContext {
  const context=structuredClone(input);
  const [seconds,fraction]=context.cutoffTs.split('.');
  const oldest=`${BigInt(seconds!)>1800n?BigInt(seconds!)-1800n:0n}.${fraction}`;
  const sides=context.timeline.messages.filter(m=>m.ts!==context.anchorTs&&compareTs(m.ts,oldest)>=0&&compareTs(m.ts,context.cutoffTs)<0)
    .sort((a,b)=>compareTs(a.ts,b.ts)).slice(-12);
  const active=new Set(sides.filter(m=>m.replies?.messages.length).sort((a,b)=>compareTs(b.replies!.messages.at(-1)!.ts,a.replies!.messages.at(-1)!.ts)).slice(0,2).map(m=>m.ts));
  for(const root of sides){
    if(!active.has(root.ts)){if(root.replies?.messages.length)noteOmission(context.timeline,'thread_reply_selection');delete root.replies;continue;}
    if(root.replies!.messages.length>5){root.replies!.messages=root.replies!.messages.slice(-5);noteOmission(root.replies!,'thread_message_limit');}
    updateCoverage(root.replies!);
  }
  if(sides.length<context.timeline.messages.filter(m=>m.ts!==context.anchorTs).length)noteOmission(context.timeline,'initial_background_selection');
  context.timeline.messages=sides;updateCoverage(context.timeline);
  return context;
}
export function buildEnvelope(event: SlackThreadEvent, input: ThreadContext, replyContext?: SlackReplyContext): string {
  const context: ThreadContext = structuredClone(input);
  delete context.readStats;
  delete context.selectionStats;
  const visit = (section: ContextSection): void => {
    for (const message of section.messages) {
      if (message.ts === event.messageTs) { message.text = ''; message.files = []; message.currentRequest = true; delete message.textTruncated; delete message.filesTruncated; }
      delete message.sourceFingerprint;
      if (message.replies) visit(message.replies);
    }
    updateCoverage(section);
  };
  visit(context.timeline);
  const eventPayload = { teamId:event.teamId,channelId:event.channelId,threadTs:event.threadTs,messageTs:event.messageTs,senderUserId:event.senderUserId,text:event.text,mention:{type:event.mention.type,id:event.mention.id},files:projectFiles(event.files,Number.MAX_SAFE_INTEGER),
    ...(event.filesTruncated ? {filesTruncated:true} : {}) };
  // Coverage and its guidance are recomputed after every byte-budget cut, so they describe what is delivered.
  const result: Record<string, unknown> = { schemaVersion: 6, task: {}, coverage: {}, eventPayload, context, ...(replyContext?{replyContext}:{}) };
  const describe = (): void => {
    const coverage = summarizeCoverage(context, { messageTs: event.messageTs, files: eventPayload.files });
    result.coverage = coverage;
    result.task = { instructions: coverageGuidance(coverage, context) };
  };
  describe();
  const shrink = (): boolean => {
    const roots = context.timeline.messages;
    let optional = roots.findIndex(m => m.ts !== event.threadTs&&m.change!=='referenced');
    if(optional<0)optional=roots.findIndex(m=>m.ts!==event.threadTs);
    if (optional >= 0) {
      const [dropped] = roots.splice(optional, 1);
      // Background is optional; a message the user linked to is not.
      noteOmission(context.timeline, dropped!.change==='referenced'||dropped!.contentStatus==='unavailable' ? 'reference_byte_limit' : 'context_byte_limit');
    } else {
      // Follow-ups only deliver root, A and later by design, so replies before A came in through links.
      const replies=roots.find(m=>m.ts===event.threadTs)?.replies;
      const extra=replies?.messages.findIndex(m=>context.sinceTs&&compareTs(m.ts,context.sinceTs)<0)??-1;
      if(!replies||extra<0)return false;
      replies.messages.splice(extra,1);noteOmission(context.timeline,'reference_byte_limit');
    }
    visit(context.timeline);
    describe();
    return true;
  };
  while (Buffer.byteLength(serializeEnvelope(result)) > 48 * 1024) {
    if (!shrink()) throw new Error('context_request_too_large');
  }
  if(context.selection){
    context.selection.omittedRoots += input.timeline.messages.length-context.timeline.messages.length;
    const before=input.timeline.messages.find(m=>m.ts===event.threadTs)?.replies?.messages.length??0;
    const after=context.timeline.messages.find(m=>m.ts===event.threadTs)?.replies?.messages.length??0;
    context.selection.omittedCurrentReplies += before-after;
  }
  if(context.selection){
    const changed=context.timeline.messages.filter(m=>m.ts!==event.threadTs).flatMap(m=>[m,...(m.replies?.messages??[])]);
    context.selection.added=changed.filter(m=>m.change==='new').length;
    context.selection.updated=changed.filter(m=>m.change==='updated').length;
    context.selection.referenced=changed.filter(m=>m.change==='referenced').length;
  }
  const used=new Set([event.senderUserId,...(event.mention.type==='user'?[event.mention.id]:[]),...context.timeline.messages.flatMap(m=>[m.authorId,...(m.replies?.messages.map(r=>r.authorId)??[])])]);
  if(context.participants)context.participants=context.participants.filter(p=>used.has(p.id));
  const serialized=serializeEnvelope(result);
  if(Buffer.byteLength(serialized)>48*1024)throw new Error('context_request_too_large');
  return serialized;
}
