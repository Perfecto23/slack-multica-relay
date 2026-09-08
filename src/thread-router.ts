import { Buffer } from 'node:buffer';
import {formatTaskTitle,formatTaskDescription,readTaskEnvelope} from './task-presentation.js';
import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  createIssue,
  findIssue,
  createComment,
  findComment,
  getSlackReplyContext,
  type ApiConfig,
} from "./multica-api.js";
import type { MentionMatch } from "./mentions.js";
import { type ThreadStore } from "./thread-store.js";
import { buildEnvelope, focusContext, messageFingerprint, compareTs, type ThreadContext } from './context-envelope.js';

export interface SlackThreadEvent {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  senderUserId: string;
  text: string;
  mention: MentionMatch;
  files?: unknown;
  filesTruncated?: boolean;
  sourceFingerprint?: string;
}
export interface ThreadRouterConfig extends ApiConfig {
  store: ThreadStore;
  readContext: (event: SlackThreadEvent) => Promise<ThreadContext>;
}
interface ThreadState {
  version: 2;
  rootMessageKey: string;
  issueId?: string;
  creating: boolean;
}
interface MessageState {
  phase: "writing" | "done" | "rejected";
}
export interface ThreadRouteResult {
  action: "created" | "comment_persisted" | "duplicate";
  issueId: string;
}
export const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
export function threadKey(event: SlackThreadEvent): string {
  return `${event.teamId}:${event.channelId}:${event.threadTs}`;
}
export function messageKey(event: SlackThreadEvent): string {
  return `${event.teamId}:${event.channelId}:${event.messageTs}`;
}
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function routeSlackThreadEvent(
  event: SlackThreadEvent,
  config: ThreadRouterConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ThreadRouteResult> {
  const scope = digest(
    config.multicaWorkspaceId +
      ":" +
      config.multicaProjectId +
      ":" +
      config.multicaAgentId,
  );
  const key = `relay:${scope}:thread:${digest(threadKey(event))}`;
  const msgKey = `relay:${scope}:message:${digest(messageKey(event))}`;
  const lockKey = key + ":lock",
    owner = randomUUID();
  if (!(await config.store.setIfAbsent(lockKey, owner, 120)))
    throw new Error("thread_lock_busy");
  try {
    const raw = await config.store.get(key);
    let state: ThreadState;
    if (raw) {
      state = JSON.parse(raw) as ThreadState;
      if (
        state.version !== 2 ||
        typeof state.rootMessageKey !== "string" ||
        typeof state.creating !== "boolean"
      )
        throw new Error("invalid_thread_state");
    } else
      state = {
        version: 2,
        rootMessageKey: messageKey(event),
        creating: false,
      };
    const marker = `<!-- relay-thread:${scope}:${digest(threadKey(event))} -->`;
    const selectionKey = key + ':sent-context-index';
    type SelectionIndex = { version: 2; cutoffTs: string; messages: Record<string,string> };
    const advanceSelection = async (): Promise<void> => {
      const pending=await config.store.get(msgKey+':selection-index');
      if(!pending)return;
      const next=JSON.parse(pending) as SelectionIndex;
      const old=await config.store.get(selectionKey);
      if(old&&compareTs(JSON.parse(old).cutoffTs,next.cutoffTs)>=0)return;
      await config.store.set(selectionKey,pending,24*60*60);
    };
    const prepare = async (): Promise<string> => {
      const preparedKey = msgKey + ':envelope';
      const frozen = await config.store.get(preparedKey);
      if (frozen) {
        console.info('relay_context',{eventId:digest(messageKey(event)),snapshot:'reused',envelopeBytes:Buffer.byteLength(frozen)});
        return frozen;
      }
      const source=await config.readContext(event);
      const savedIndex=await config.store.get(selectionKey);
      const index:SelectionIndex|undefined=savedIndex?JSON.parse(savedIndex):undefined;
      const baseline=index?.version===2&&compareTs(index.cutoffTs,event.messageTs)<0?index.messages:undefined;
      const followup=messageKey(event)!==state.rootMessageKey;
      const agentConfigStartedAt=Date.now();
      const replyContext=await getSlackReplyContext(config,fetchImpl);
      const agentConfigMs=Date.now()-agentConfigStartedAt;
      const assemblyStart=Date.now();
      const selected=followup?focusContext(event,source,baseline):source;
      const body=buildEnvelope(event,selected,replyContext);
      const output=JSON.parse(body).context as ThreadContext;
      const delivered=output.timeline.messages;
      const count=(roots:ThreadContext['timeline']['messages'])=>roots.length+roots.reduce((n,m)=>n+(m.replies?.messages.length??0),0);
      const reasons:Record<string,number>={};
      const readReasons:Record<string,number>={};
      for(const section of [source.timeline,...source.timeline.messages.flatMap(m=>m.replies?[m.replies]:[])])if(section.reason)readReasons[section.reason]=(readReasons[section.reason]??0)+1;
      const sections=[output.timeline,...delivered.flatMap(m=>m.replies?[m.replies]:[])];
      for(const section of sections)if(section.reason)reasons[section.reason]=(reasons[section.reason]??0)+1;
      console.info('relay_context',{
        eventId:digest(messageKey(event)),snapshot:'prepared',mode:followup?'focused':'full',baseline:baseline?'available':'unavailable',
        slackCalls:source.readStats?.slackCalls,rawMessages:source.readStats?.rawMessages,
        candidateRoots:source.timeline.messages.length,candidateMessages:count(source.timeline.messages),
        retainedRoots:delivered.length,retainedMessages:count(delivered),omittedMessages:count(source.timeline.messages)-count(delivered),
        added:output.selection?.added??0,updated:output.selection?.updated??0,referenced:output.selection?.referenced??0,
        selectionReasons:selected.selectionStats,byteBudgetOmissions:count(selected.timeline.messages)-count(delivered),
        readReasons,reasons,messageReadMs:source.readStats?.messageReadMs,nameLookupCalls:source.readStats?.nameLookupCalls,
        nameReadMs:source.readStats?.nameReadMs,agentConfigMs,assemblyMs:Date.now()-assemblyStart,envelopeBytes:Buffer.byteLength(body),
      });
      const hashes={...baseline};
      const sourceMessages=new Map(source.timeline.messages.flatMap(m=>[m,...(m.replies?.messages??[])]).map(m=>[m.ts,m]));
      for(const root of delivered){
        for(const message of [root,...(root.replies?.messages??[])]){
          const original=sourceMessages.get(message.ts);
          if(original)hashes[message.ts]=messageFingerprint(original);
        }
      }
      const messages=Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>compareTs(b,a)).slice(0,500));
      await config.store.setIfAbsent(preparedKey, body, 24 * 60 * 60);
      const saved = await config.store.get(preparedKey);
      if (!saved) throw new Error('invalid_thread_state');
      if(saved===body)await config.store.set(msgKey+':selection-index',JSON.stringify({version:2,cutoffTs:event.messageTs,messages}),24*60*60);
      return saved;
    };
    if (!state.issueId) {
      // Recover by immutable description marker before any write. A POST whose
      // result is unknown must never be repeated blindly.
      const existing = await findIssue(config, marker, fetchImpl);
      if (existing) {
        state.issueId = existing.id;
        if (!raw) {
          const original = readTaskEnvelope(existing.description!);
          if (
            !original.eventPayload ||
            threadKey(original.eventPayload) !== threadKey(event)
          )
            throw new Error("invalid_thread_state");
          state.rootMessageKey = messageKey(original.eventPayload);
        }
      } else {
        if (state.creating) throw new Error("ambiguous_issue_create");
        const envelope = await prepare();
        state.rootMessageKey = messageKey(event);
        state.creating = true;
        await config.store.set(key, JSON.stringify(state), STATE_TTL_SECONDS);
        try {
          const created = await createIssue(
            config,
            formatTaskTitle(event,scope),
            formatTaskDescription(envelope,marker),
            fetchImpl,
          );
          state.issueId = created.id;
        } catch (error) {
          // Definite request rejection permits a later retry; 5xx/transport or
          // malformed success may have committed, so retain the write intent.
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            state.creating = false;
            await config.store.set(
              key,
              JSON.stringify(state),
              STATE_TTL_SECONDS,
            );
          }
          throw error;
        }
      }
      state.creating = false;
      await config.store.set(key, JSON.stringify(state), STATE_TTL_SECONDS);
    }
    const previous = await config.store.get(msgKey);
    if (previous && (JSON.parse(previous) as MessageState).phase === "done")
      return { action: "duplicate", issueId: state.issueId };
    if (messageKey(event) === state.rootMessageKey) {
      await advanceSelection();
      await config.store.set(
        msgKey,
        JSON.stringify({ phase: "done" }),
        STATE_TTL_SECONDS,
      );
      return { action: "created", issueId: state.issueId };
    }
    const messageMarker = `<!-- relay-message:${digest(messageKey(event))} -->`;
    const existingComment = await findComment(
      config,
      state.issueId,
      messageMarker,
      fetchImpl,
    );
    if (!existingComment) {
      if (
        previous &&
        (JSON.parse(previous) as MessageState).phase === "writing"
      )
        throw new Error("ambiguous_comment_create");
      const envelope = await prepare();
      await config.store.set(
        msgKey,
        JSON.stringify({ phase: "writing" }),
        STATE_TTL_SECONDS,
      );
      try {
        await createComment(
          config,
          state.issueId,
          formatTaskDescription(envelope,messageMarker,true),
          fetchImpl,
        );
      } catch (error) {
        // Do not clear ambiguous writes. Explicit rejections are retried by
        // the queue after storing a non-writing phase.
        if (
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        )
          await config.store.set(
            msgKey,
            JSON.stringify({ phase: "rejected" }),
            STATE_TTL_SECONDS,
          );
        throw error;
      }
    }
    await advanceSelection();
    await config.store.set(
      msgKey,
      JSON.stringify({ phase: "done" }),
      STATE_TTL_SECONDS,
    );
    return { action: "comment_persisted", issueId: state.issueId };
  } finally {
    await config.store.releaseIfOwner(lockKey, owner);
  }
}
