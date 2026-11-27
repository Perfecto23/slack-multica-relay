import { setSlackSessionStatus } from "./slack-session.js";
import { Buffer } from "node:buffer";
import {
  formatTaskTitle,
  formatTaskDescription,
  readTaskEnvelope,
} from "./task-presentation.js";
import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  threadScopeId,
  validateMappedIssue,
  createIssue,
  findIssue,
  createComment,
  findComment,
  findCommentById,
  retryTaskSupplement,
  getSlackReplyContext,
  getIssue,
  listRelayMessageContents,
  listIssueRuns,
  cancelIssueRun,
  isActiveRun,
  isSteerableRun,
  type ApiConfig,
  type MulticaComment,
  type IssueRun,
} from "./multica-api.js";
import type { MentionMatch } from "./mentions.js";
import type { InboundOperation, TriggerSource } from "./inbound-policy.js";
import {
  addSlackReaction,
  removeSlackReaction,
  reactionErrorDetails,
} from "./reaction.js";
import {
  cancelThread,
  maxTimestamp,
  type CancellationState,
} from "./cancellation.js";
import { type ThreadStore } from "./thread-store.js";
import {
  buildEnvelope,
  compareTs,
  timestampValid,
  type ThreadContext,
} from "./context-envelope.js";
import type { ContextReadOptions } from "./slack-context.js";

export interface SteerCheckPayload {
  issueId: string;
  commentId: string;
  taskId: string;
  attempt: number;
}

export interface WatchdogCheckPayload {
  issueId: string;
  attempt: number;
}

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
  operation?: InboundOperation;
  trigger?: TriggerSource;
  steerCheck?: SteerCheckPayload;
  watchdogCheck?: WatchdogCheckPayload;
}

export interface ThreadRouterConfig extends ApiConfig {
  store: ThreadStore;
  readContext: (
    event: SlackThreadEvent,
    options?: ContextReadOptions,
  ) => Promise<ThreadContext>;
  slackReactionToken?: string;
  slackReactionName?: string;
  slackQueuedReactionName?: string;
  slackSteerPendingReactionName?: string;
  slackSteerReadReactionName?: string;
  slackOfflineReactionName?: string;
  slackResetReactionName?: string;
  multicaQueueAgentId?: string;
  slackStatusToken?: string;
  slackAlertChannelId?: string;
  implicitThreadMaxSilentTurns?: number;
  ownerUserIds?: ReadonlySet<string>;
}

export interface ThreadState {
  version: 2;
  rootMessageKey: string;
  issueId?: string;
  creating: boolean;
  epoch?: number;
  epochStartedTs?: string;
  lastDeliveredTs?: string;
  implicitMode?: "open" | "closed";
  lastSeenReplyTs?: string;
  implicitSilentCount?: number;
  lastMessageTs?: string;
  ignoredThrough?: string;
  reactionMessages?: string[];
  reactionHistoryKnown?: boolean;
  cancellation?: CancellationState;
}

interface MessageState {
  phase: "writing" | "done" | "rejected";
}

export interface SteerReceipt {
  commentId: string;
  taskId: string;
  status: "pending" | "delivering" | "delivered" | "failed";
}

export interface ThreadRouteResult {
  action:
    | "created"
    | "comment_persisted"
    | "duplicate"
    | "cancelled"
    | "no_active_run"
    | "ignored"
    | "session_reset"
    | "steer_delivered"
    | "steer_pending"
    | "steer_failed"
    | "watchdog_active"
    | "watchdog_cleaned";
  issueId?: string;
  steerReceipt?: SteerReceipt;
}

export const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;

export function threadKey(
  event: Pick<SlackThreadEvent, "teamId" | "channelId" | "threadTs">,
): string {
  return `${event.teamId}:${event.channelId}:${event.threadTs}`;
}

export function messageKey(
  event: Pick<SlackThreadEvent, "teamId" | "channelId" | "messageTs">,
): string {
  return `${event.teamId}:${event.channelId}:${event.messageTs}`;
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function relayScopeHash(config: ApiConfig): string {
  return digest(
    config.multicaWorkspaceId +
      ":" +
      config.multicaProjectId +
      ":" +
      threadScopeId(config),
  );
}

export function threadStateStorageKey(
  config: ApiConfig,
  event: Pick<SlackThreadEvent, "teamId" | "channelId" | "threadTs">,
): string {
  return `relay:${relayScopeHash(config)}:thread:${digest(threadKey(event))}`;
}

export function threadRepliedStorageKey(
  config: ApiConfig,
  event: Pick<SlackThreadEvent, "teamId" | "channelId" | "threadTs">,
): string {
  return `${threadStateStorageKey(config, event)}:replied`;
}

export async function isThreadOpenForImplicitFollowup(
  store: ThreadStore,
  config: ApiConfig,
  event: Pick<SlackThreadEvent, "teamId" | "channelId" | "threadTs">,
): Promise<boolean> {
  const raw = await store.get(threadStateStorageKey(config, event));
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadState>;
    if (parsed.version !== 2) return false;
    if (!parsed.issueId && !parsed.creating) return false;
    return parsed.implicitMode !== "closed";
  } catch {
    return false;
  }
}

function buildThreadMarker(
  scope: string,
  event: SlackThreadEvent,
  epoch: number | undefined,
): string {
  const identityInput = epoch
    ? `${threadKey(event)}:${epoch}`
    : threadKey(event);
  return `<!-- relay-thread:${scope}:${digest(identityInput)} -->`;
}

export async function routeSlackThreadEvent(
  event: SlackThreadEvent,
  config: ThreadRouterConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ThreadRouteResult> {
  const scope = relayScopeHash(config);
  const key = threadStateStorageKey(config, event);
  const repliedKey = threadRepliedStorageKey(config, event);
  const msgIdentity =
    event.trigger === "edit_mention"
      ? `${messageKey(event)}:edit`
      : messageKey(event);
  const msgKey = `relay:${scope}:message:${digest(msgIdentity)}`;
  const lockKey = key + ":lock";
  const owner = randomUUID();
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
    } else {
      state = {
        version: 2,
        rootMessageKey: messageKey(event),
        creating: false,
      };
    }
    let marker = buildThreadMarker(scope, event, state.epoch);
    const save = () =>
      config.store.set(key, JSON.stringify(state), STATE_TTL_SECONDS);

    if (event.operation === "cancel")
      return await cancelThread(event, state, marker, config, save, fetchImpl);

    if (state.cancellation && state.cancellation.phase !== "done") {
      state.ignoredThrough = maxTimestamp(
        state.ignoredThrough,
        event.messageTs,
      );
      await save();
      return { action: "ignored", issueId: state.issueId };
    }
    if (
      state.ignoredThrough &&
      compareTs(event.messageTs, state.ignoredThrough) <= 0
    )
      return { action: "ignored", issueId: state.issueId };

    if (event.operation === "watchdog") {
      return await handleWatchdogCheck(
        event,
        state,
        marker,
        repliedKey,
        config,
        fetchImpl,
      );
    }

    if (event.operation === "steer_ack") {
      return await handleSteerAck(event, state, marker, config, fetchImpl);
    }

    const previous = await config.store.get(msgKey);
    const alreadyDone =
      Boolean(previous) &&
      (JSON.parse(previous!) as MessageState).phase === "done";

    if (event.operation === "new_session") {
      if (alreadyDone) {
        return { action: "duplicate", issueId: state.issueId };
      }
      if (state.epochStartedTs !== event.messageTs) {
        if (state.issueId) {
          try {
            const runs = await listIssueRuns(config, state.issueId, fetchImpl);
            for (const run of runs) {
              if (isActiveRun(run)) {
                await cancelIssueRun(config, state.issueId, run.id, fetchImpl);
              }
            }
          } catch {
            // Best-effort stop of old session before rotating epoch.
          }
        }
        const nextEpoch = (state.epoch ?? 0) + 1;
        state = {
          version: 2,
          rootMessageKey: messageKey(event),
          creating: false,
          epoch: nextEpoch,
          epochStartedTs: event.messageTs,
          implicitMode: "open",
          implicitSilentCount: 0,
          lastMessageTs: event.messageTs,
        };
        marker = buildThreadMarker(scope, event, state.epoch);
        await save();
      }
      if (!event.text.trim()) {
        await setSlackSessionStatus(
          config.slackStatusToken,
          event,
          "active",
          fetchImpl,
        );
        const resetReaction =
          config.slackResetReactionName ?? config.slackReactionName;
        if (config.slackReactionToken && resetReaction) {
          try {
            await addSlackReaction(
              config.slackReactionToken,
              event.channelId,
              event.messageTs,
              resetReaction,
              fetchImpl,
            );
          } catch (error) {
            console.warn("relay_reaction", {
              eventId: digest(messageKey(event)),
              reason: "reaction_failed",
              ...reactionErrorDetails(error),
            });
          }
        }
        await config.store.set(
          msgKey,
          JSON.stringify({ phase: "done" }),
          STATE_TTL_SECONDS,
        );
        return { action: "session_reset" };
      }
    }

    if (state.issueId)
      await validateMappedIssue(config, state.issueId, marker, fetchImpl);

    const isImplicit = event.trigger === "implicit_thread";
    let pendingImplicitIncrement = false;
    let preloadedRuns: IssueRun[] | undefined;
    if (isImplicit && !alreadyDone) {
      if (!state.issueId) return { action: "ignored" };
      const rawReplied = await config.store.get(repliedKey);
      if (
        rawReplied &&
        timestampValid(rawReplied) &&
        (!state.epochStartedTs || compareTs(rawReplied, state.epochStartedTs) > 0) &&
        (!state.lastSeenReplyTs || compareTs(rawReplied, state.lastSeenReplyTs) > 0)
      ) {
        state.lastSeenReplyTs = rawReplied;
        state.implicitSilentCount = 0;
        state.implicitMode = "open";
      }
      preloadedRuns = await listIssueRuns(config, state.issueId, fetchImpl);
      const hasActive = preloadedRuns.some(
        (run) =>
          (!config.multicaQueueAgentId ||
            run.agent_id === config.multicaQueueAgentId) &&
          isActiveRun(run),
      );
      const hasParticipated = Boolean(state.lastSeenReplyTs);
      if (!hasParticipated && !hasActive) {
        state.implicitMode = "closed";
        await save();
        return { action: "ignored", issueId: state.issueId };
      }
      if (hasParticipated && !hasActive) {
        const maxSilent = config.implicitThreadMaxSilentTurns ?? 3;
        const streak = state.implicitSilentCount ?? 0;
        if (maxSilent > 0 && streak >= maxSilent) {
          state.implicitMode = "closed";
          await save();
          return { action: "ignored", issueId: state.issueId };
        }
        pendingImplicitIncrement = true;
      }
    } else if (!isImplicit && !alreadyDone) {
      state.implicitMode = "open";
      state.implicitSilentCount = 0;
    }

    state.lastMessageTs = maxTimestamp(state.lastMessageTs, event.messageTs);
    // 保存触发消息，再尝试外部写入，取消恢复才能找到响应丢失的消息。
    state.reactionMessages ??= raw
      ? [state.rootMessageKey.split(":").at(-1)!]
      : [];
    if (!state.reactionMessages.includes(event.messageTs))
      state.reactionMessages.push(event.messageTs);
    await save();

    let queued = false;
    let runtimeOffline = false;
    let steerReceipt: SteerReceipt | undefined;
    const finish = async (
      action: "created" | "comment_persisted" | "duplicate",
    ): Promise<ThreadRouteResult> => {
      // 添加和取消清理共用线程锁，避免迟到的启动 reaction 出现在已取消任务上。
      if (action !== "duplicate" && config.slackReactionToken) {
        try {
          if (
            steerReceipt &&
            (steerReceipt.status === "pending" ||
              steerReceipt.status === "delivering")
          ) {
            const pendingReaction =
              config.slackSteerPendingReactionName ??
              config.slackQueuedReactionName;
            if (pendingReaction)
              await addSlackReaction(
                config.slackReactionToken,
                event.channelId,
                event.messageTs,
                pendingReaction,
                fetchImpl,
              );
          } else if (steerReceipt && steerReceipt.status === "delivered") {
            const readReaction =
              config.slackSteerReadReactionName ?? config.slackReactionName;
            if (readReaction)
              await addSlackReaction(
                config.slackReactionToken,
                event.channelId,
                event.messageTs,
                readReaction,
                fetchImpl,
              );
          } else {
            if (!isImplicit && config.slackReactionName) {
              await addSlackReaction(
                config.slackReactionToken,
                event.channelId,
                event.messageTs,
                config.slackReactionName,
                fetchImpl,
              );
              if (queued && config.slackQueuedReactionName) {
                await addSlackReaction(
                  config.slackReactionToken,
                  event.channelId,
                  event.messageTs,
                  config.slackQueuedReactionName,
                  fetchImpl,
                );
              }
            }
            if (runtimeOffline && config.slackOfflineReactionName) {
              await addSlackReaction(
                config.slackReactionToken,
                event.channelId,
                event.messageTs,
                config.slackOfflineReactionName,
                fetchImpl,
              );
            }
          }
        } catch (error) {
          console.warn("relay_reaction", {
            eventId: digest(messageKey(event)),
            reason: "reaction_failed",
            ...reactionErrorDetails(error),
          });
        }
      }
      return {
        action,
        issueId: state.issueId,
        ...(steerReceipt ? { steerReceipt } : {}),
      };
    };

    let recoveredDescription: string | undefined;
    const recordDelivered = async (): Promise<void> => {
      const nextDelivered = maxTimestamp(state.lastDeliveredTs, event.messageTs);
      if (nextDelivered !== state.lastDeliveredTs) {
        state.lastDeliveredTs = nextDelivered;
        await save();
      }
    };
    const resolveSinceTs = async (followup: boolean): Promise<string | undefined> => {
      if (!followup || !state.issueId) return undefined;
      if (
        state.lastDeliveredTs &&
        timestampValid(state.lastDeliveredTs) &&
        compareTs(state.lastDeliveredTs, event.messageTs) < 0
      ) {
        return state.lastDeliveredTs;
      }
      const description =
        recoveredDescription ??
        (await getIssue(config, state.issueId, fetchImpl)).description;
      if (!description?.startsWith(marker + "\n"))
        throw new Error("invalid_thread_state");
      const first = readTaskEnvelope(description);
      if (threadKey(first.eventPayload) !== threadKey(event))
        throw new Error("invalid_thread_state");
      const persistedTimestamps = [first.eventPayload.messageTs];
      for (const content of await listRelayMessageContents(
        config,
        state.issueId,
        fetchImpl,
      )) {
        const item = readTaskEnvelope(content);
        if (threadKey(item.eventPayload) !== threadKey(event)) continue;
        const itemKey = messageKey(item.eventPayload);
        if (
          !content.startsWith(`<!-- relay-message:${digest(itemKey)} -->\n`) &&
          !content.startsWith(`<!-- relay-message:${digest(`${itemKey}:edit`)} -->\n`)
        ) {
          continue;
        }
        persistedTimestamps.push(item.eventPayload.messageTs);
      }
      const validTimestamps = persistedTimestamps.filter(timestampValid);
      const beforeDelivered = state.lastDeliveredTs;
      for (const ts of validTimestamps) {
        state.lastDeliveredTs = maxTimestamp(state.lastDeliveredTs, ts);
      }
      if (state.lastDeliveredTs !== beforeDelivered) {
        await save();
      }
      return validTimestamps
        .filter((ts) => compareTs(ts, event.messageTs) < 0)
        .sort((a, b) => compareTs(b, a))[0];
    };
    const prepare = async (): Promise<string> => {
      const preparedKey = msgKey + ":envelope";
      const frozen = await config.store.get(preparedKey);
      if (frozen) {
        try {
          const pf = JSON.parse(frozen) as {
            replyContext?: { runtimeOnline?: boolean };
          };
          if (pf.replyContext?.runtimeOnline === false) runtimeOffline = true;
        } catch {}
        console.info("relay_context", {
          eventId: digest(messageKey(event)),
          snapshot: "reused",
          envelopeBytes: Buffer.byteLength(frozen),
        });
        return frozen;
      }
      const followup =
        Boolean(state.issueId) && messageKey(event) !== state.rootMessageKey;
      const sinceTs = await resolveSinceTs(followup);
      const includeNearby = !followup && event.messageTs === event.threadTs;
      const source = await config.readContext(event, {
        ...(sinceTs ? { sinceTs } : {}),
        includeNearby,
      });
      const agentConfigStartedAt = Date.now();
      const replyContext = await getSlackReplyContext(config, fetchImpl);
      if (replyContext.runtimeOnline === false) runtimeOffline = true;
      const agentConfigMs = Date.now() - agentConfigStartedAt;
      const assemblyStart = Date.now();
      const body = buildEnvelope(event, source, replyContext, {
        ownerUserIds: config.ownerUserIds,
      });
      console.info("relay_context", {
        eventId: digest(messageKey(event)),
        snapshot: "prepared",
        mode: followup ? "followup" : "initial",
        hasSinceTs: Boolean(sinceTs),
        slackCalls: source.readStats?.slackCalls,
        rawMessages: source.readStats?.rawMessages,
        retainedReplies: source.replies.length,
        omittedEarlierReplies: source.omittedEarlierReplies,
        nearbyMessages: source.nearbyMessages.length,
        channelCacheHit: source.readStats?.channelCacheHit,
        channelLookupCalls: source.readStats?.channelLookupCalls,
        userCacheHits: source.readStats?.userCacheHits,
        userLookupCalls: source.readStats?.userLookupCalls,
        messageReadMs: source.readStats?.messageReadMs,
        lookupMs: source.readStats?.lookupMs,
        agentConfigMs,
        assemblyMs: Date.now() - assemblyStart,
        envelopeBytes: Buffer.byteLength(body),
      });
      await config.store.setIfAbsent(preparedKey, body, 24 * 60 * 60);
      const saved = await config.store.get(preparedKey);
      if (!saved) throw new Error("invalid_thread_state");
      return saved;
    };

    if (!state.issueId) {
      // Recover by immutable description marker before any write. A POST whose
      // result is unknown must never be repeated blindly.
      const existing = await findIssue(config, marker, fetchImpl);
      if (existing) {
        state.issueId = existing.id;
        recoveredDescription = existing.description ?? undefined;
        if (!raw) {
          const original = readTaskEnvelope(existing.description!);
          if (
            !original.eventPayload ||
            threadKey(original.eventPayload) !== threadKey(event)
          )
            throw new Error("invalid_thread_state");
          state.rootMessageKey = messageKey(original.eventPayload);
          if (
            !state.reactionMessages!.includes(original.eventPayload.messageTs)
          )
            state.reactionMessages!.push(original.eventPayload.messageTs);
        }
      } else {
        if (state.creating) throw new Error("ambiguous_issue_create");
        const envelope = await prepare();
        state.rootMessageKey = messageKey(event);
        state.creating = true;
        await config.store.set(key, JSON.stringify(state), STATE_TTL_SECONDS);
        await setSlackSessionStatus(
          config.slackStatusToken,
          event,
          "processing",
          fetchImpl,
        );
        try {
          const created = await createIssue(
            config,
            formatTaskTitle(event, scope),
            formatTaskDescription(envelope, marker),
            fetchImpl,
          );
          state.issueId = created.id;
          state.reactionHistoryKnown = true;
        } catch (error) {
          // Definite request rejection permits a later retry; 5xx/transport or
          // malformed success may have committed, so retain the write intent.
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            await setSlackSessionStatus(
              config.slackStatusToken,
              event,
              "active",
              fetchImpl,
            );
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

    if (alreadyDone)
      return await finish("duplicate");
    if (messageKey(event) === state.rootMessageKey) {
      await recordDelivered();
      await config.store.set(
        msgKey,
        JSON.stringify({ phase: "done" }),
        STATE_TTL_SECONDS,
      );
      return await finish("created");
    }

    const messageMarker = `<!-- relay-message:${digest(msgIdentity)} -->`;
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
      let steerTaskId: string | undefined;
      let coalesceParentId: string | undefined;
      let observedActiveRun = false;
      if (config.multicaQueueAgentId) {
        try {
          const runs =
            preloadedRuns ??
            (await listIssueRuns(config, state.issueId, fetchImpl));
          observedActiveRun = runs.some(
            (run) =>
              run.agent_id === config.multicaQueueAgentId && isActiveRun(run),
          );
          const steerable = runs.find(
            (run) =>
              run.agent_id === config.multicaQueueAgentId && isSteerableRun(run),
          );
          if (steerable) {
            steerTaskId = steerable.id;
          } else {
            const queuedCommentRun = runs.find(
              (run) =>
                run.agent_id === config.multicaQueueAgentId &&
                run.status === "queued" &&
                (run.trigger_thread_id || run.trigger_comment_id),
            );
            if (queuedCommentRun) {
              coalesceParentId =
                (queuedCommentRun.trigger_thread_id ||
                  queuedCommentRun.trigger_comment_id) ??
                undefined;
            }
            if (config.slackQueuedReactionName) {
              queued = observedActiveRun;
            }
          }
        } catch {
          queued = false;
        }
      }
      await config.store.set(
        msgKey,
        JSON.stringify({ phase: "writing" }),
        STATE_TTL_SECONDS,
      );
      if (!isImplicit || steerTaskId) {
        await setSlackSessionStatus(
          config.slackStatusToken,
          event,
          "processing",
          fetchImpl,
        );
      }
      try {
        const createdComment = await createComment(
          config,
          state.issueId,
          formatTaskDescription(envelope, messageMarker, true),
          fetchImpl,
          steerTaskId
            ? { steerTaskIds: [steerTaskId] }
            : coalesceParentId
              ? { parentId: coalesceParentId }
              : undefined,
        );
        if (steerTaskId) {
          const bound = extractSupplementReceipt(createdComment, steerTaskId);
          if (bound) {
            steerReceipt = {
              commentId: createdComment.id,
              taskId: bound.task_id,
              status: bound.status,
            };
          } else if (config.slackQueuedReactionName) {
            queued = observedActiveRun;
          }
        }
      } catch (error) {
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
    if (pendingImplicitIncrement) {
      state.implicitSilentCount = (state.implicitSilentCount ?? 0) + 1;
      await save();
    }
    await recordDelivered();
    await config.store.set(
      msgKey,
      JSON.stringify({ phase: "done" }),
      STATE_TTL_SECONDS,
    );
    return await finish("comment_persisted");
  } finally {
    await config.store.releaseIfOwner(lockKey, owner);
  }
}

async function handleSteerAck(
  event: SlackThreadEvent,
  state: ThreadState,
  marker: string,
  config: ThreadRouterConfig,
  fetchImpl: typeof fetch,
): Promise<ThreadRouteResult> {
  const check = event.steerCheck;
  if (!check || !state.issueId || state.issueId !== check.issueId)
    return { action: "ignored", issueId: state.issueId };
  await validateMappedIssue(config, state.issueId, marker, fetchImpl);
  const comment = await findCommentById(
    config,
    state.issueId,
    check.commentId,
    fetchImpl,
  );
  if (!comment) return { action: "ignored", issueId: state.issueId };
  const receipt = extractSupplementReceipt(comment, check.taskId);
  const pendingReaction =
    config.slackSteerPendingReactionName ?? config.slackQueuedReactionName;
  const readReaction =
    config.slackSteerReadReactionName ?? config.slackReactionName;
  if (!receipt) return { action: "ignored", issueId: state.issueId };
  if (receipt.status === "delivered") {
    if (config.slackReactionToken) {
      try {
        if (pendingReaction && pendingReaction !== readReaction)
          await removeSlackReaction(
            config.slackReactionToken,
            event.channelId,
            event.messageTs,
            pendingReaction,
            fetchImpl,
          );
        if (readReaction)
          await addSlackReaction(
            config.slackReactionToken,
            event.channelId,
            event.messageTs,
            readReaction,
            fetchImpl,
          );
      } catch (error) {
        console.warn("relay_reaction", {
          eventId: digest(messageKey(event)),
          reason: "reaction_failed",
          ...reactionErrorDetails(error),
        });
      }
    }
    return {
      action: "steer_delivered",
      issueId: state.issueId,
      steerReceipt: {
        commentId: check.commentId,
        taskId: check.taskId,
        status: "delivered",
      },
    };
  }
  if (receipt.status === "pending" || receipt.status === "delivering") {
    return {
      action: "steer_pending",
      issueId: state.issueId,
      steerReceipt: {
        commentId: check.commentId,
        taskId: check.taskId,
        status: receipt.status,
      },
    };
  }
  if (receipt.status === "failed") {
    const runs = await listIssueRuns(config, state.issueId, fetchImpl);
    const targetRun = runs.find((run) => run.id === check.taskId);
    if (targetRun && isSteerableRun(targetRun) && check.attempt <= 2) {
      await retryTaskSupplement(
        config,
        state.issueId,
        check.taskId,
        check.commentId,
        fetchImpl,
      );
      return {
        action: "steer_pending",
        issueId: state.issueId,
        steerReceipt: {
          commentId: check.commentId,
          taskId: check.taskId,
          status: "pending",
        },
      };
    }
    const wakeAgentId = config.multicaQueueAgentId;
    const hasActiveAgentRun = wakeAgentId
      ? runs.some((run) => run.agent_id === wakeAgentId && isActiveRun(run))
      : false;
    if (wakeAgentId && !hasActiveAgentRun) {
      const wakeupMarker = `<!-- relay-steer-fallback:${check.commentId} -->`;
      const existingFallback = await findComment(
        config,
        state.issueId,
        wakeupMarker,
        fetchImpl,
      );
      if (!existingFallback) {
        await createComment(
          config,
          state.issueId,
          `${wakeupMarker}\n[@Agent](mention://agent/${wakeAgentId}) 上一轮运行结束前未读到 Slack 插话评论 \`${check.commentId}\`，请读取该条评论的请求上下文并回复 Slack 原线程。`,
          fetchImpl,
          { parentId: check.commentId },
        );
      }
    }
    if (config.slackReactionToken) {
      try {
        if (pendingReaction && pendingReaction !== readReaction)
          await removeSlackReaction(
            config.slackReactionToken,
            event.channelId,
            event.messageTs,
            pendingReaction,
            fetchImpl,
          );
        if (readReaction && wakeAgentId && !hasActiveAgentRun)
          await addSlackReaction(
            config.slackReactionToken,
            event.channelId,
            event.messageTs,
            readReaction,
            fetchImpl,
          );
      } catch (error) {
        console.warn("relay_reaction", {
          eventId: digest(messageKey(event)),
          reason: "reaction_failed",
          ...reactionErrorDetails(error),
        });
      }
    }
    return {
      action: "steer_failed",
      issueId: state.issueId,
      steerReceipt: {
        commentId: check.commentId,
        taskId: check.taskId,
        status: "failed",
      },
    };
  }
  return { action: "ignored", issueId: state.issueId };
}

async function handleWatchdogCheck(
  event: SlackThreadEvent,
  state: ThreadState,
  marker: string,
  repliedKey: string,
  config: ThreadRouterConfig,
  fetchImpl: typeof fetch,
): Promise<ThreadRouteResult> {
  const check = event.watchdogCheck;
  if (!check || !state.issueId || state.issueId !== check.issueId) {
    return { action: "ignored", issueId: state.issueId };
  }
  await validateMappedIssue(config, state.issueId, marker, fetchImpl);
  const runs = await listIssueRuns(config, state.issueId, fetchImpl);
  const scoped = config.multicaQueueAgentId
    ? runs.filter((run) => run.agent_id === config.multicaQueueAgentId)
    : runs;
  if (scoped.some(isActiveRun)) {
    return { action: "watchdog_active", issueId: state.issueId };
  }
  const latest = scoped[0];
  if (!latest || (latest.status !== "failed" && latest.status !== "cancelled")) {
    return { action: "ignored", issueId: state.issueId };
  }
  const repliedTs = await config.store.get(repliedKey);
  if (repliedTs && timestampValid(repliedTs) && compareTs(repliedTs, event.messageTs) > 0) {
    return { action: "ignored", issueId: state.issueId };
  }
  if (config.slackReactionToken) {
    const reactionsToClear = new Set(
      [
        config.slackReactionName,
        config.slackQueuedReactionName,
        config.slackOfflineReactionName,
        config.slackSteerPendingReactionName,
      ].filter((x): x is string => Boolean(x)),
    );
    for (const reaction of reactionsToClear) {
      try {
        await removeSlackReaction(
          config.slackReactionToken,
          event.channelId,
          event.messageTs,
          reaction,
          fetchImpl,
        );
      } catch {
        // Best-effort cleanup of stuck reaction.
      }
    }
  }
  await setSlackSessionStatus(
    config.slackStatusToken,
    event,
    "active",
    fetchImpl,
  );
  if (
    latest.status === "failed" &&
    config.slackAlertChannelId &&
    config.slackReactionToken
  ) {
    const permalink = `https://slack.com/archives/${event.channelId}/p${event.messageTs.replace(".", "")}?thread_ts=${event.threadTs}&cid=${event.channelId}`;
    const alertText = `⚠️ Multica 任务异常失败（\`failed\`），已自动清理残留状态：${permalink} · Issue \`${state.issueId}\``;
    try {
      const alertRes = await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.slackStatusToken ?? config.slackReactionToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: config.slackAlertChannelId,
          text: alertText,
          unfurl_links: false,
        }),
        signal: AbortSignal.timeout(3000),
      });
      const alertBody: unknown = await alertRes.json().catch(() => null);
      if (
        !alertRes.ok ||
        !alertBody ||
        typeof alertBody !== "object" ||
        (alertBody as { ok?: unknown }).ok !== true
      ) {
        console.warn("relay_watchdog", { reason: "alert_delivery_failed" });
      }
    } catch {
      console.warn("relay_watchdog", { reason: "alert_delivery_failed" });
    }
  }
  return { action: "watchdog_cleaned", issueId: state.issueId };
}

function extractSupplementReceipt(
  comment: MulticaComment,
  expectedTaskId: string,
): { task_id: string; status: SteerReceipt["status"] } | undefined {
  const validStatus = (s: unknown): s is SteerReceipt["status"] =>
    s === "pending" ||
    s === "delivering" ||
    s === "delivered" ||
    s === "failed";
  if (Array.isArray(comment.supplements)) {
    const match = comment.supplements.find(
      (item) =>
        item && item.task_id === expectedTaskId && validStatus(item.status),
    );
    if (match)
      return { task_id: match.task_id, status: match.status as SteerReceipt["status"] };
  }
  if (
    comment.supplement_task_id === expectedTaskId &&
    validStatus(comment.supplement_status)
  ) {
    return {
      task_id: comment.supplement_task_id,
      status: comment.supplement_status,
    };
  }
  return undefined;
}
