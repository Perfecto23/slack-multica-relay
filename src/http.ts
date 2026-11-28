import { Buffer } from "node:buffer";
import { Receiver } from "@upstash/qstash";
import { loadRelayConfig, type RelayConfig } from "./config.js";
import { verifySlackSignature } from "./signature.js";
import { canCancelTask } from "./mentions.js";
import {
  classifyCommand,
  evaluateInboundSlackEvent,
  isChannelAndSenderAllowed,
  isQueuedEventAdmitted,
  type InboundOperation,
  type TriggerSource,
} from "./inbound-policy.js";
import { readContext, enrichContextDirectory } from "./slack-context.js";
import {
  routeSlackThreadEvent,
  isThreadOpenForImplicitFollowup,
  threadRepliedStorageKey,
  STATE_TTL_SECONDS,
  digest,
  threadKey,
  messageKey,
  type SlackThreadEvent,
} from "./thread-router.js";
import { UpstashThreadStore } from "./thread-store.js";
import {
  projectFiles,
  compareTs,
  timestampValid,
} from "./context-envelope.js";
import { setSlackSessionStatus } from "./slack-session.js";
import { agentBody, isRelayProgressMessage } from "./slack-message-text.js";
import { lookupSlackAuthor, SlackAuthorLookupError } from "./slack-author.js";

export const ADMISSION_BUDGET_MS = 2750;
export const QUEUE_PUBLISH_BUDGET_MS = 2000;
export const STEER_ACK_DELAYS_SECONDS = [3, 5, 10, 20, 30] as const;
export const DEFERRED_STEER_DELAYS_SECONDS = [5, 10, 15, 15, 15, 15] as const;

const VALID_OPERATIONS = new Set<InboundOperation>([
  "dispatch",
  "cancel",
  "new_session",
  "steer_ack",
  "watchdog",
]);
const VALID_TRIGGERS = new Set<TriggerSource>([
  "native_stop",
  "implicit_thread",
  "wake_pattern",
  "edit_mention",
]);

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function readBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 256 * 1024) throw new Error("body_too_large");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).toString("utf8");
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parsedEvent(value: unknown): SlackThreadEvent {
  if (
    !record(value) ||
    ["teamId", "channelId", "senderUserId"].some(
      (k) =>
        typeof value[k] !== "string" ||
        !/^[A-Z][A-Z0-9]+$/u.test(value[k] as string),
    ) ||
    ["messageTs", "threadTs"].some(
      (k) =>
        typeof value[k] !== "string" ||
        !/^\d+\.\d{1,6}$/u.test(value[k] as string),
    ) ||
    typeof value.text !== "string" ||
    (value.sourceFingerprint !== undefined &&
      (typeof value.sourceFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.sourceFingerprint))) ||
    (value.operation !== undefined &&
      !VALID_OPERATIONS.has(value.operation as InboundOperation)) ||
    (value.operation === "steer_ack" &&
      (!record(value.steerCheck) ||
        ["issueId", "commentId", "taskId"].some((k) => {
          const v = (value.steerCheck as Record<string, unknown>)[k];
          return typeof v !== "string" || !v.trim();
        }) ||
        typeof value.steerCheck.attempt !== "number" ||
        !Number.isInteger(value.steerCheck.attempt) ||
        value.steerCheck.attempt < 1 ||
        value.steerCheck.attempt > STEER_ACK_DELAYS_SECONDS.length)) ||
    (value.operation !== "steer_ack" && value.steerCheck !== undefined) ||
    (value.operation === "watchdog" &&
      (!record(value.watchdogCheck) ||
        typeof value.watchdogCheck.issueId !== "string" ||
        !value.watchdogCheck.issueId.trim() ||
        typeof value.watchdogCheck.attempt !== "number" ||
        !Number.isInteger(value.watchdogCheck.attempt) ||
        value.watchdogCheck.attempt < 1 ||
        value.watchdogCheck.attempt > 2)) ||
    (value.operation !== "watchdog" && value.watchdogCheck !== undefined) ||
    (value.steerWaitAttempt !== undefined &&
      (typeof value.steerWaitAttempt !== "number" ||
        !Number.isInteger(value.steerWaitAttempt) ||
        value.steerWaitAttempt < 1 ||
        value.steerWaitAttempt > DEFERRED_STEER_DELAYS_SECONDS.length)) ||
    (value.trigger !== undefined &&
      (!VALID_TRIGGERS.has(value.trigger as TriggerSource) ||
        (value.trigger === "native_stop" &&
          (value.operation !== "cancel" || value.text !== "")))) ||
    !record(value.mention) ||
    !["user", "subteam"].includes(String(value.mention.type)) ||
    typeof value.mention.id !== "string"
  )
    throw new Error("invalid_event");
  return value as unknown as SlackThreadEvent;
}

function reason(error: unknown): string {
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  )
    return "timeout";
  const codes = [
    "body_too_large",
    "invalid_event",
    "thread_lock_busy",
    "ambiguous_issue_create",
    "ambiguous_comment_create",
    "invalid_thread_state",
    "ambiguous_issue_mapping",
    "invalid_issue_scope",
    "invalid_context_scope",
    "context_request_too_large",
    "context_required_page_limit",
    "context_required_unavailable",
    "task_presentation_too_large",
    "context_rate_limited",
    "context_upstream_failed",
    "context_invalid_response",
    "context_invalid_cursor",
    "context_response_too_large",
    "comment_lookup_limit",
    "multica_http_error",
    "invalid_multica_response",
    "invalid_comment_cursor",
    "cancellation_pending",
    "cancellation_run_missing",
    "cancellation_new_run",
    "reaction_cleanup_failed",
  ];
  return error instanceof Error && codes.includes(error.message)
    ? error.message
    : "upstream_failed";
}

const permanentConsumerErrors = new Set([
  "invalid_event",
  "invalid_thread_state",
  "ambiguous_issue_mapping",
  "invalid_issue_scope",
  "invalid_context_scope",
  "context_request_too_large",
  "context_required_page_limit",
  "context_required_unavailable",
  "task_presentation_too_large",
  "comment_lookup_limit",
]);

export function consumerFailure(code: string): Response {
  if (permanentConsumerErrors.has(code))
    return json({ action: "rejected", error: code, retryable: false });
  return json({ error: code, retryable: true }, 503);
}

export async function acceptSlack(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const start = Date.now();
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405);
  let config: RelayConfig;
  try {
    config = loadRelayConfig(env);
  } catch {
    return json({ error: "relay_not_configured" }, 500);
  }
  let raw: string;
  try {
    raw = await readBody(request);
  } catch {
    return json({ error: "body_too_large" }, 413);
  }
  if (
    !verifySlackSignature(
      raw,
      request.headers.get("x-slack-request-timestamp") ?? undefined,
      request.headers.get("x-slack-signature") ?? undefined,
      config.signingSecret,
    )
  ) {
    console.warn("relay_admission", {
      reason: "invalid_slack_signature",
      hasTimestamp: request.headers.has("x-slack-request-timestamp"),
      hasSignature: request.headers.has("x-slack-signature"),
      contentType: request.headers.get("content-type") ?? "missing",
      bodyBytes: Buffer.byteLength(raw),
    });
    return json({ error: "invalid_slack_signature" }, 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!record(body)) return json({ error: "invalid_envelope" }, 400);
  if (body.type === "url_verification" && typeof body.challenge === "string")
    return json({ challenge: body.challenge });
  if (
    body.type === "event_callback" &&
    record(body.event) &&
    body.event.type === "agent_session_stopped"
  ) {
    let stop: SlackThreadEvent;
    try {
      stop = parsedEvent({
        teamId: body.team_id,
        channelId: body.event.channel,
        messageTs: body.event.event_ts,
        threadTs: body.event.thread_ts,
        senderUserId: body.event.user,
        text: "",
        mention: { type: "user", id: body.event.user },
        operation: "cancel",
        trigger: "native_stop",
      });
    } catch {
      return json({ error: "invalid_event" }, 400);
    }
    if (!isQueuedEventAdmitted(stop, config))
      return json({ action: "ignored", reason: "cancel_not_allowed" });
    return publishSlackEvent(stop, config, start, fetchImpl, 0);
  }
  if (body.type !== "event_callback" || !record(body.event))
    return json({ action: "ignored" });

  const event = body.event;
  if (isRelayProgressMessage(event)) {
    return json({ action: "ignored", reason: "relay_progress" });
  }
  if (agentBody(event, true) !== undefined) {
    if (
      (config.implicitThreadFollowup || config.watchdogDelaySeconds > 0) &&
      typeof body.team_id === "string" &&
      typeof event.channel === "string" &&
      typeof event.user === "string" &&
      typeof event.thread_ts === "string" &&
      typeof event.ts === "string" &&
      timestampValid(event.ts) &&
      timestampValid(event.thread_ts) &&
      isChannelAndSenderAllowed(body.team_id, event.channel, event.user, config) &&
      (config.targetUserIds.has(event.user) || config.controlUserIds.has(event.user))
    ) {
      const store = new UpstashThreadStore(
        config.kvRestApiUrl,
        config.kvRestApiToken,
        fetchImpl,
      );
      const rKey = threadRepliedStorageKey(config, {
        teamId: body.team_id,
        channelId: event.channel,
        threadTs: event.thread_ts,
      });
      await store
        .get(rKey)
        .then(async (prev) => {
          if (!prev || !timestampValid(prev) || compareTs(event.ts as string, prev) > 0) {
            await store.set(rKey, event.ts as string, STATE_TTL_SECONDS);
          }
        })
        .catch(() => {});
    }
    return json({ action: "ignored", reason: "relay_reply" });
  }

  const evaluation = evaluateInboundSlackEvent(body.team_id, event, config);
  if (!evaluation.admitted) {
    if (evaluation.invalid) return json({ error: "invalid_event" }, 400);
    if (
      typeof event.thread_ts === "string" &&
      typeof event.ts === "string" &&
      event.thread_ts !== event.ts
    ) {
      console.info("relay_ignored", {
        stage: "evaluate",
        reason: evaluation.reason,
        channelId: typeof event.channel === "string" ? event.channel : undefined,
        implicitEnabled: config.implicitThreadFollowup,
      });
    }
    return json({
      action: "ignored",
      ...(evaluation.reason !== "ignored" ? { reason: evaluation.reason } : {}),
    });
  }

  const candidate = evaluation.candidate;
  if (candidate.requiresActiveThread) {
    const store = new UpstashThreadStore(
      config.kvRestApiUrl,
      config.kvRestApiToken,
      fetchImpl,
    );
    let open = false;
    try {
      open = await isThreadOpenForImplicitFollowup(store, config, candidate);
    } catch (error) {
      console.warn("relay_active_thread_error", {
        channelId: candidate.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return json({ error: "queue_unavailable", retryable: true }, 503);
    }
    if (!open) {
      console.info("relay_ignored", {
        stage: "active_thread_gate",
        reason: "thread_not_open",
        channelId: candidate.channelId,
        trigger: candidate.trigger,
      });
      return json({ action: "ignored", reason: "not_addressed" });
    }
  }

  let payload: SlackThreadEvent;
  try {
    payload = parsedEvent({
      teamId: candidate.teamId,
      channelId: candidate.channelId,
      messageTs: candidate.messageTs,
      threadTs: candidate.threadTs,
      senderUserId: candidate.senderUserId,
      text: candidate.text,
      mention: candidate.mention,
      operation: candidate.operation,
      ...(candidate.trigger ? { trigger: candidate.trigger } : {}),
      ...(candidate.files
        ? { files: projectFiles(candidate.files, Number.MAX_SAFE_INTEGER) }
        : {}),
    });
  } catch {
    return json({ error: "invalid_event" }, 400);
  }

  const authorBudgetMs = ADMISSION_BUDGET_MS - (Date.now() - start);
  if (authorBudgetMs <= 0)
    return json({ error: "author_unavailable", retryable: true }, 503);
  try {
    const author = await lookupSlackAuthor(
      payload.senderUserId,
      config.slackReactionToken,
      fetchImpl,
      authorBudgetMs,
    );
    if (author.isBot) return json({ action: "ignored", reason: "bot_author" });
  } catch (error) {
    console.warn("relay_author", {
      eventId: digest(messageKey(payload)),
      reason:
        error instanceof SlackAuthorLookupError ? error.code : "request_failed",
      durationMs: Date.now() - start,
    });
    return json({ error: "author_unavailable", retryable: true }, 503);
  }

  const remainingBudgetMs = ADMISSION_BUDGET_MS - (Date.now() - start);
  if (remainingBudgetMs <= 0)
    return json({ error: "queue_unavailable", retryable: true }, 503);
  const delaySeconds =
    payload.operation === "dispatch" ? config.dispatchDelaySeconds : 0;
  return publishSlackEvent(payload, config, start, fetchImpl, delaySeconds);
}

async function publishSlackEvent(
  payload: SlackThreadEvent,
  config: RelayConfig,
  start: number,
  fetchImpl: typeof fetch,
  delaySeconds = 0,
): Promise<Response> {
  const remainingBudgetMs = ADMISSION_BUDGET_MS - (Date.now() - start);
  if (remainingBudgetMs <= 0)
    return json({ error: "queue_unavailable", retryable: true }, 503);
  try {
    const dedupSuffix =
      payload.trigger === "edit_mention" ? ":edit" : "";
    const response = await fetchImpl(
      config.queueUrl + "/v2/publish/" + config.consumerUrl,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.queueToken}`,
          "content-type": "application/json",
          "Upstash-Deduplication-Id": digest(
            config.consumerUrl + ":" + messageKey(payload) + dedupSuffix,
          ),
          "Upstash-Retries": "3",
          "Upstash-Timeout": "50s",
          "Upstash-Flow-Control-Key": digest(
            config.consumerUrl + ":" + threadKey(payload),
          ),
          "Upstash-Flow-Control-Value": "parallelism=1",
          ...(delaySeconds > 0 ? { "Upstash-Delay": `${delaySeconds}s` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(
          Math.min(QUEUE_PUBLISH_BUDGET_MS, remainingBudgetMs),
        ),
      },
    );
    if (!response.ok) throw new Error("queue_publish_failed");
    const queued: unknown = await response.json();
    if (!record(queued) || typeof queued.messageId !== "string")
      throw new Error("invalid_queue_response");
    console.info("relay_admission", {
      eventId: digest(messageKey(payload)),
      queueMessageId: queued.messageId,
      durationMs: Date.now() - start,
    });
    return json({ action: "accepted", queueMessageId: queued.messageId });
  } catch (error) {
    console.warn("relay_admission", {
      eventId: digest(messageKey(payload)),
      reason: reason(error),
      durationMs: Date.now() - start,
    });
    return json({ error: "queue_unavailable", retryable: true }, 503);
  }
}

export async function consumeQueue(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405);
  let config: RelayConfig;
  try {
    config = loadRelayConfig(env);
  } catch {
    return json({ error: "relay_not_configured" }, 500);
  }
  let raw: string;
  try {
    raw = await readBody(request);
  } catch {
    return json({ error: "body_too_large" }, 413);
  }
  try {
    const valid = await new Receiver({
      currentSigningKey: config.queueCurrentSigningKey,
      nextSigningKey: config.queueNextSigningKey,
      devMode: false,
    }).verify({
      body: raw,
      signature: request.headers.get("upstash-signature") ?? "",
      url: config.consumerUrl,
    });
    if (!valid) return json({ error: "invalid_queue_signature" }, 401);
  } catch {
    return json({ error: "invalid_queue_signature" }, 401);
  }
  let event: SlackThreadEvent;
  try {
    event = parsedEvent(JSON.parse(raw));
  } catch {
    return consumerFailure("invalid_event");
  }
  if (!isQueuedEventAdmitted(event, config))
    return json({ action: "ignored", reason: "policy_changed" });
  // Legacy queued events without an explicit operation derive theirs from the unified command classifier.
  if (event.operation === undefined) {
    event.operation = classifyCommand(event.text, config).operation;
  }
  if (
    (event.operation === "cancel" || event.operation === "new_session") &&
    !canCancelTask(event.senderUserId, config.controlUserIds)
  )
    return json({ action: "ignored", reason: "cancel_not_allowed" });
  const start = Date.now(),
    deadline = AbortSignal.timeout(45000);
  const boundedFetch: typeof fetch = (input, init = {}) => {
    deadline.throwIfAborted();
    return fetchImpl(input, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, deadline])
        : deadline,
    });
  };
  try {
    const store = new UpstashThreadStore(
      config.kvRestApiUrl,
      config.kvRestApiToken,
      boundedFetch,
    );
    const result = await routeSlackThreadEvent(
      event,
      {
        ...config,
        ownerUserIds: config.targetUserIds,
        maxDeferredSteerAttempts: DEFERRED_STEER_DELAYS_SECONDS.length,
        readContext: async (event, options) =>
          enrichContextDirectory(
            event,
            await readContext(
              event,
              config.slackContextToken,
              boundedFetch,
              options,
            ),
            {
              token: config.slackContextToken,
              store,
              fetchImpl: boundedFetch,
            },
          ),
        store,
      },
      boundedFetch,
    );
    if (
      event.operation === "cancel" &&
      ["cancelled", "no_active_run"].includes(result.action)
    )
      await setSlackSessionStatus(
        config.slackStatusToken,
        event,
        "active",
        boundedFetch,
      );
    if (result.action === "deferred_steer") {
      const nextAttempt = (event.steerWaitAttempt ?? 0) + 1;
      if (nextAttempt <= DEFERRED_STEER_DELAYS_SECONDS.length) {
        await scheduleDelayedCheck(
          {
            ...event,
            steerWaitAttempt: nextAttempt,
          },
          `deferred_steer:${messageKey(event)}:${nextAttempt}`,
          DEFERRED_STEER_DELAYS_SECONDS[nextAttempt - 1] ?? 15,
          config,
          boundedFetch,
        );
      }
    }
    if (
      result.steerReceipt &&
      (result.steerReceipt.status === "pending" ||
        result.steerReceipt.status === "delivering")
    ) {
      const nextAttempt = (event.steerCheck?.attempt ?? 0) + 1;
      if (nextAttempt <= STEER_ACK_DELAYS_SECONDS.length) {
        await scheduleDelayedCheck(
          {
            ...event,
            operation: "steer_ack",
            steerCheck: {
              issueId: result.issueId ?? event.steerCheck?.issueId ?? "",
              commentId: result.steerReceipt.commentId,
              taskId: result.steerReceipt.taskId,
              attempt: nextAttempt,
            },
          },
          `steer_ack:${result.steerReceipt.commentId}:${nextAttempt}`,
          STEER_ACK_DELAYS_SECONDS[nextAttempt - 1] ?? 10,
          config,
          boundedFetch,
        );
      }
    }
    if (config.watchdogDelaySeconds > 0 && result.issueId) {
      if (
        result.action === "created" ||
        (result.action === "comment_persisted" && !result.steerReceipt)
      ) {
        await scheduleDelayedCheck(
          {
            ...event,
            operation: "watchdog",
            watchdogCheck: { issueId: result.issueId, attempt: 1 },
          },
          `watchdog:${messageKey(event)}:1`,
          config.watchdogDelaySeconds,
          config,
          boundedFetch,
        );
      } else if (
        result.action === "watchdog_active" &&
        (event.watchdogCheck?.attempt ?? 1) < 2
      ) {
        await scheduleDelayedCheck(
          {
            ...event,
            operation: "watchdog",
            watchdogCheck: { issueId: result.issueId, attempt: 2 },
          },
          `watchdog:${messageKey(event)}:2`,
          config.watchdogDelaySeconds,
          config,
          boundedFetch,
        );
      }
    }
    console.info("relay_dispatch", {
      ...result,
      eventId: digest(messageKey(event)),
      durationMs: Date.now() - start,
    });
    return json(result);
  } catch (error) {
    const code = reason(error);
    console.warn("relay_dispatch", {
      eventId: digest(messageKey(event)),
      reason: code,
      durationMs: Date.now() - start,
    });
    return consumerFailure(code);
  }
}

async function scheduleDelayedCheck(
  payload: SlackThreadEvent,
  dedupKey: string,
  delaySeconds: number,
  config: RelayConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const response = await fetchImpl(
      config.queueUrl + "/v2/publish/" + config.consumerUrl,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.queueToken}`,
          "content-type": "application/json",
          "Upstash-Deduplication-Id": digest(
            `${config.consumerUrl}:${dedupKey}`,
          ),
          "Upstash-Delay": `${delaySeconds}s`,
          "Upstash-Retries": "2",
          "Upstash-Timeout": "30s",
          "Upstash-Flow-Control-Key": digest(
            config.consumerUrl + ":" + threadKey(payload),
          ),
          "Upstash-Flow-Control-Value": "parallelism=1",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) throw new Error("delayed_publish_failed");
  } catch {
    console.warn("relay_delayed_check", {
      eventId: digest(messageKey(payload)),
      operation: payload.operation,
      reason: "schedule_failed",
    });
  }
}
