import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { acceptSlack, consumeQueue } from "../src/http.js";
import {
  evaluateInboundSlackEvent,
  extractSupplementalText,
  isAddressedToOtherUser,
  matchesWakePattern,
  type InboundPolicyConfig,
} from "../src/inbound-policy.js";
import { loadRelayConfig } from "../src/config.js";
import {
  threadRepliedStorageKey,
  threadStateStorageKey,
} from "../src/thread-router.js";

vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = vi.fn().mockResolvedValue(true);
  },
}));

const baseEnv: NodeJS.ProcessEnv = {
  SLACK_SIGNING_SECRET: "test",
  SLACK_TEAM_ID: "T1",
  SLACK_TARGET_USER_IDS: "UOWNER",
  SLACK_CONTROL_USER_IDS: "UOWNER",
  SLACK_ALLOWED_CHANNEL_IDS: "C1,D1",
  MULTICA_API_BASE_URL: "https://multica.test",
  MULTICA_API_TOKEN: "test",
  MULTICA_WORKSPACE_ID: "ws",
  MULTICA_PROJECT_ID: "project",
  MULTICA_AGENT_ID: "agent",
  SLACK_USER_TOKEN: "test",
  SLACK_CONTEXT_TOKEN: "test",
  SLACK_REACTION_NAME: "bug_eyes",
  KV_REST_API_URL: "https://kv.test",
  KV_REST_API_TOKEN: "test",
  QSTASH_TOKEN: "test",
  QSTASH_CURRENT_SIGNING_KEY: "test",
  QSTASH_NEXT_SIGNING_KEY: "test",
  RELAY_CONSUMER_URL: "https://relay.test/api/queue/consume",
};

function signedSlackRequest(event: unknown, teamId = "T1"): Request {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: teamId,
    event,
  });
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://relay.test/api/slack/events", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": ts,
      "x-slack-signature":
        "v0=" +
        createHmac("sha256", "test")
          .update("v0:" + ts + ":" + body)
          .digest("hex"),
    },
    body,
  });
}

function makePolicy(overrides: Partial<InboundPolicyConfig> = {}): InboundPolicyConfig {
  const cfg = loadRelayConfig({
    ...baseEnv,
    SLACK_IMPLICIT_THREAD_FOLLOWUP: "true",
    SLACK_WAKE_PATTERNS: "小 p,小p,little perf",
  });
  return { ...cfg, ...overrides };
}

describe("inbound policy & Hermes/OpenClaw inspired gating", () => {
  it("matches Chinese and ASCII wake patterns without false partial-word matches", () => {
    const patterns = ["小 p", "小p", "little perf", "bot"];
    expect(matchesWakePattern("小 p 帮我看下这个报错", patterns)).toBe("小 p");
    expect(matchesWakePattern("hey Little Perf check this", patterns)).toBe("little perf");
    expect(matchesWakePattern("ask bot please", patterns)).toBe("bot");
    expect(matchesWakePattern("robotics pipeline failed", patterns)).toBeUndefined();
  });

  it("extracts shared/forwarded Slack attachment text when absent from flat text", () => {
    const combined = extractSupplementalText(
      {
        attachments: [
          {
            is_share: true,
            text: "TypeError: Cannot read properties of undefined\n  at worker.ts:42",
          },
        ],
      },
      "<@UOWNER> 看下这个转发的报错",
    );
    expect(combined).toContain("<@UOWNER> 看下这个转发的报错");
    expect(combined).toContain("> TypeError: Cannot read properties of undefined");
  });

  it("wakes when a human edits an unmentioned message to add @target, but ignores link unfurls and repeat edits", () => {
    const policy = makePolicy();
    // 1. Human edit adding @UOWNER
    const edited = evaluateInboundSlackEvent(
      "T1",
      {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "105.000001",
        previous_message: { type: "message", user: "U2", ts: "100.000001", text: "帮忙看下这个 PR" },
        message: {
          type: "message",
          user: "U2",
          ts: "100.000001",
          text: "<@UOWNER> 帮忙看下这个 PR",
          edited: { user: "U2", ts: "105.000001" },
        },
      },
      policy,
    );
    expect(edited.admitted).toBe(true);
    if (edited.admitted) {
      expect(edited.candidate.messageTs).toBe("100.000001");
      expect(edited.candidate.trigger).toBe("edit_mention");
    }

    // 2. Link unfurl (no `edited` metadata) -> ignored
    const unfurl = evaluateInboundSlackEvent(
      "T1",
      {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "105.000002",
        previous_message: { type: "message", user: "U2", ts: "100.000001", text: "<@UOWNER> https://example.com" },
        message: {
          type: "message",
          user: "U2",
          ts: "100.000001",
          text: "<@UOWNER> https://example.com",
        },
      },
      policy,
    );
    expect(unfurl.admitted).toBe(false);

    // 3. Message already had @UOWNER before edit -> ignored
    const repeatEdit = evaluateInboundSlackEvent(
      "T1",
      {
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "105.000003",
        previous_message: { type: "message", user: "U2", ts: "100.000001", text: "<@UOWNER> typo" },
        message: {
          type: "message",
          user: "U2",
          ts: "100.000001",
          text: "<@UOWNER> fixed typo",
          edited: { user: "U2", ts: "105.000003" },
        },
      },
      policy,
    );
    expect(repeatEdit.admitted).toBe(false);
  });

  it("classifies owner !new / 重开 session-reset commands and blocks non-owners", () => {
    const policy = makePolicy();
    const ownerReset = evaluateInboundSlackEvent(
      "T1",
      {
        type: "message",
        channel: "C1",
        user: "UOWNER",
        ts: "102.000001",
        thread_ts: "100.000001",
        text: "<@UOWNER> !new 按新方案重新分析",
      },
      policy,
    );
    expect(ownerReset.admitted).toBe(true);
    if (ownerReset.admitted) {
      expect(ownerReset.candidate.operation).toBe("new_session");
      expect(ownerReset.candidate.text).toBe("按新方案重新分析");
    }

    const strangerReset = evaluateInboundSlackEvent(
      "T1",
      {
        type: "message",
        channel: "C1",
        user: "UCOLLEAGUE",
        ts: "102.000002",
        thread_ts: "100.000001",
        text: "<@UOWNER> !new",
      },
      policy,
    );
    expect(strangerReset).toEqual({ admitted: false, reason: "cancel_not_allowed" });
  });

  it("applies the 4-gate implicit thread funnel: blocks broadcasts, @other-user leads, and owner unaddressed replies", () => {
    const policy = makePolicy();
    expect(isAddressedToOtherUser("<@UNOOK> 你看下这部分前端", policy.targetUserIds)).toBe(true);
    expect(isAddressedToOtherUser("顺便拉上 <@UNOOK> 一起看", policy.targetUserIds)).toBe(false);

    // 1. Broadcast <!channel> without direct mention -> dropped
    expect(
      evaluateInboundSlackEvent(
        "T1",
        {
          type: "message",
          channel: "C1",
          user: "UCOLLEAGUE",
          ts: "102.000001",
          thread_ts: "100.000001",
          text: "<!channel> 大家注意一下线上变更",
        },
        policy,
      ),
    ).toEqual({ admitted: false, reason: "broadcast" });

    // 2. Leading @other-user in thread -> dropped
    expect(
      evaluateInboundSlackEvent(
        "T1",
        {
          type: "message",
          channel: "C1",
          user: "UCOLLEAGUE",
          ts: "102.000002",
          thread_ts: "100.000001",
          text: "<@UNOOK> 这块接口你来对齐一下",
        },
        policy,
      ),
    ).toEqual({ admitted: false, reason: "addressed_to_other" });

    // 3. Owner replying directly to colleagues without @UOWNER or wake pattern -> dropped
    expect(
      evaluateInboundSlackEvent(
        "T1",
        {
          type: "message",
          channel: "C1",
          user: "UOWNER",
          ts: "102.000003",
          thread_ts: "100.000001",
          text: "好的，按方案 A 推进就行",
        },
        policy,
      ),
    ).toEqual({ admitted: false, reason: "owner_unaddressed" });

    // 4. Owner explicitly calling wake pattern "小 p" in thread without <@UOWNER> -> admitted!
    const ownerWake = evaluateInboundSlackEvent(
      "T1",
      {
        type: "message",
        channel: "C1",
        user: "UOWNER",
        ts: "102.000004",
        thread_ts: "100.000001",
        text: "小 p 帮我把刚才的结论整理发出来",
      },
      policy,
    );
    expect(ownerWake.admitted).toBe(true);
    if (ownerWake.admitted) {
      expect(ownerWake.candidate.trigger).toBe("wake_pattern");
      expect(ownerWake.candidate.requiresActiveThread).toBe(false);
    }

    // 5. Colleague replying naturally in thread -> requiresActiveThread = true
    const colleagueFollowup = evaluateInboundSlackEvent(
      "T1",
      {
        type: "message",
        channel: "C1",
        user: "UCOLLEAGUE",
        ts: "102.000005",
        thread_ts: "100.000001",
        text: "按 A 改吧，报错日志我贴下面了",
      },
      policy,
    );
    expect(colleagueFollowup.admitted).toBe(true);
    if (colleagueFollowup.admitted) {
      expect(colleagueFollowup.candidate.trigger).toBe("implicit_thread");
      expect(colleagueFollowup.candidate.requiresActiveThread).toBe(true);
    }
  });

  it("admits implicit thread replies at acceptSlack only when KV has an open ThreadState, and records relay_reply timestamps", async () => {
    const kv = new Map<string, string>();
    const envWithImplicit = {
      ...baseEnv,
      SLACK_IMPLICIT_THREAD_FOLLOWUP: "true",
      SLACK_DISPATCH_DELAY_SECONDS: "2",
    };
    const cfg = loadRelayConfig(envWithImplicit);
    const threadRef = { teamId: "T1", channelId: "C1", threadTs: "100.000001" };
    const stateKey = threadStateStorageKey(cfg, threadRef);
    const repliedKey = threadRepliedStorageKey(cfg, threadRef);

    const published: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === baseEnv.KV_REST_API_URL) {
        const [cmd, key, val] = JSON.parse(String(init?.body)) as [string, string, string];
        if (cmd === "GET") return Response.json({ result: kv.get(key) ?? null });
        if (cmd === "SET") {
          kv.set(key, val);
          return Response.json({ result: "OK" });
        }
      }
      if (url.includes("/users.info?")) {
        return Response.json({ ok: true, user: { id: "UCOLLEAGUE", is_bot: false } });
      }
      if (url.includes("/v2/publish/")) {
        published.push({
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ messageId: "q-1" });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    // 1. Thread has no state in KV -> rejected at door without publishing to QStash
    const unmappedRes = await acceptSlack(
      signedSlackRequest({
        type: "message",
        channel: "C1",
        user: "UCOLLEAGUE",
        ts: "101.000001",
        thread_ts: "100.000001",
        text: "普通群聊跟帖",
      }),
      envWithImplicit,
      fetcher,
    );
    expect(await unmappedRes.json()).toEqual({ action: "ignored", reason: "not_addressed" });
    expect(published).toHaveLength(0);

    // 2. Relay's own Slack reply arrives -> records `:replied` timestamp in KV and ignores echo
    const ownReplyRes = await acceptSlack(
      signedSlackRequest({
        type: "message",
        channel: "C1",
        user: "UOWNER",
        ts: "101.500001",
        thread_ts: "100.000001",
        text: "这是排查结论",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "这是排查结论" } },
          {
            type: "context",
            block_id: "relay-delivery-" + "b".repeat(64),
            elements: [{ type: "mrkdwn", text: "Sent by Perfecto's Agent" }],
          },
        ],
      }),
      envWithImplicit,
      fetcher,
    );
    expect(await ownReplyRes.json()).toEqual({ action: "ignored", reason: "relay_reply" });
    expect(kv.get(repliedKey)).toBe("101.500001");

    // 3. Thread has open ThreadState -> unmentioned follow-up is accepted with 2s QStash delay!
    kv.set(
      stateKey,
      JSON.stringify({
        version: 2,
        rootMessageKey: "T1:C1:100.000001",
        issueId: "issue-1",
        creating: false,
        implicitMode: "open",
      }),
    );
    const activeRes = await acceptSlack(
      signedSlackRequest({
        type: "message",
        channel: "C1",
        user: "UCOLLEAGUE",
        ts: "102.000001",
        thread_ts: "100.000001",
        text: "那第二种情况怎么处理？",
      }),
      envWithImplicit,
      fetcher,
    );
    expect(await activeRes.json()).toEqual({ action: "accepted", queueMessageId: "q-1" });
    expect(published).toHaveLength(1);
    expect(published[0]?.headers["Upstash-Delay"]).toBe("2s");
    expect(published[0]?.body.trigger).toBe("implicit_thread");

    // 4. Consumer re-validates implicit_thread events
    const badConsumer = await consumeQueue(
      new Request(baseEnv.RELAY_CONSUMER_URL!, {
        method: "POST",
        body: JSON.stringify(published[0]!.body),
      }),
      { ...baseEnv, SLACK_IMPLICIT_THREAD_FOLLOWUP: "false" },
      vi.fn<typeof fetch>(),
    );
    expect(await badConsumer.json()).toEqual({ action: "ignored", reason: "policy_changed" });
  });

  it("drives end-to-end consumeQueue for edit_mention wake phrases, retry-safe !new <prompt> + watchdog, and relay-progress exclusion", async () => {
    const kv = new Map<string, string>();
    const envFull: NodeJS.ProcessEnv = {
      ...baseEnv,
      SLACK_IMPLICIT_THREAD_FOLLOWUP: "true",
      SLACK_WAKE_PATTERNS: "小 p,little perf",
      SLACK_WATCHDOG_DELAY_SECONDS: "60",
      SLACK_ALERT_CHANNEL_ID: "DALERT",
    };

    const issues: { id: string; title: string; description: string; project_id: string; assignee_type: string; assignee_id: string }[] = [];
    const queuedPayloads: Record<string, unknown>[] = [];
    let failNextIssueCreate = false;

    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === baseEnv.KV_REST_API_URL) {
        const [cmd, key, val] = JSON.parse(String(init?.body)) as [string, string, string];
        if (cmd === "GET") return Response.json({ result: kv.get(key) ?? null });
        if (cmd === "SET") {
          if ((JSON.parse(String(init?.body)) as string[]).includes("NX") && kv.has(key)) {
            return Response.json({ result: null });
          }
          kv.set(key, val);
          return Response.json({ result: "OK" });
        }
        if (cmd === "EVAL") {
          const [, , , lockKey, owner] = JSON.parse(String(init?.body)) as string[];
          if (kv.get(lockKey!) === owner) kv.delete(lockKey!);
          return Response.json({ result: 1 });
        }
      }
      if (url.includes("/users.info?")) {
        const id = new URL(url).searchParams.get("user")!;
        return Response.json({ ok: true, user: { id, is_bot: false } });
      }
      if (url.includes("/v2/publish/")) {
        queuedPayloads.push(JSON.parse(String(init?.body)));
        return Response.json({ messageId: `q-${queuedPayloads.length}` });
      }
      if (url.includes("slack.com/api/conversations.history")) {
        return Response.json({ ok: true, messages: [] });
      }
      if (url.includes("slack.com/api/conversations.replies")) {
        return Response.json({
          ok: true,
          messages: [
            { ts: "100.000001", user: "UOWNER", text: "root" },
            {
              ts: "100.500001",
              user: "UOWNER",
              text: "⏳ 临时进度",
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: "⏳ 临时进度" } },
                { type: "context", block_id: "relay-progress-" + "c".repeat(64), elements: [{ type: "mrkdwn", text: "footer" }] },
              ],
            },
          ],
        });
      }
      if (url.includes("/api/agents/agent")) {
        return Response.json({ id: "agent", workspace_id: "ws", model: "gemini-4-hydrogen-medium" });
      }
      if (url.includes("/api/issues/search?")) {
        const q = new URL(url).searchParams.get("q")!;
        return Response.json({ issues: issues.filter((i) => i.description.includes(q)) });
      }
      if (url.endsWith("/api/issues") && init?.method === "POST") {
        const b = JSON.parse(String(init.body));
        const created = {
          id: `issue-${issues.length + 1}`,
          title: b.title,
          description: b.description,
          project_id: b.project_id,
          assignee_type: b.assignee_type,
          assignee_id: b.assignee_id,
        };
        issues.push(created);
        if (failNextIssueCreate) {
          failNextIssueCreate = false;
          // Simulate ambiguous 503 after server committed: retry must keep epoch=1 and recover via findIssue!
          return new Response("upstream gateway timeout after commit", { status: 503 });
        }
        return Response.json(created, { status: 201 });
      }
      if (url.match(/\/api\/issues\/issue-\d+$/)) {
        const id = url.split("/").pop()!;
        const found = issues.find((i) => i.id === id);
        return found ? Response.json(found) : new Response("not found", { status: 404 });
      }
      if (url.endsWith("/task-runs")) {
        const issueId = url.split("/").at(-2)!;
        return Response.json([
          { id: "run-failed-1", issue_id: issueId, workspace_id: "ws", agent_id: "agent", status: "failed" },
        ]);
      }
      if (url.endsWith("/reactions.add") || url.endsWith("/reactions.remove") || url.endsWith("/chat.postMessage")) {
        return Response.json({ ok: true, ts: "900.000001" });
      }
      throw new Error(`Unhandled fetch URL: ${url}`);
    };

    // A. `relay-progress-` echo is ignored and NEVER writes `:replied`!
    const progEcho = await acceptSlack(
      signedSlackRequest({
        type: "message",
        channel: "C1",
        user: "UOWNER",
        ts: "100.500001",
        thread_ts: "100.000001",
        text: "⏳ 临时进度",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "⏳ 临时进度" } },
          { type: "context", block_id: "relay-progress-" + "c".repeat(64), elements: [{ type: "mrkdwn", text: "footer" }] },
        ],
      }),
      envFull,
      fetcher,
    );
    expect(await progEcho.json()).toEqual({ action: "ignored", reason: "relay_progress" });
    expect([...kv.keys()].some((k) => k.endsWith(":replied"))).toBe(false);

    // B. Edit-mention adding wake phrase ("小 p") without <@UOWNER> survives acceptSlack -> consumeQueue!
    const editAccept = await acceptSlack(
      signedSlackRequest({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        ts: "101.000001",
        previous_message: { type: "message", user: "U2", ts: "100.000001", text: "看下这个问题" },
        message: {
          type: "message",
          user: "U2",
          ts: "100.000001",
          text: "小 p 看下这个问题",
          edited: { user: "U2", ts: "101.000001" },
        },
      }),
      envFull,
      fetcher,
    );
    expect((await editAccept.json()).action).toBe("accepted");
    const editQueued = queuedPayloads.pop()!;
    const editConsumed = await consumeQueue(
      new Request(baseEnv.RELAY_CONSUMER_URL!, { method: "POST", body: JSON.stringify(editQueued) }),
      envFull,
      fetcher,
    );
    expect((await editConsumed.json()).action).toBe("created");
    expect(issues).toHaveLength(1);
    queuedPayloads.length = 0; // clear watchdog from issue-1

    // C. `!new <prompt>` preserves mid-sentence <@UOWNER>, survives 503 retry without double-incrementing epoch, and its watchdog passes consumeQueue!
    const newAccept = await acceptSlack(
      signedSlackRequest({
        type: "message",
        channel: "C1",
        user: "UOWNER",
        ts: "110.000001",
        thread_ts: "100.000001",
        text: "<@UOWNER> !new 重新查下发给 <@UOWNER> 的告警",
      }),
      envFull,
      fetcher,
    );
    expect((await newAccept.json()).action).toBe("accepted");
    const newQueued = queuedPayloads.pop()!;
    expect(newQueued.text).toBe("重新查下发给 <@UOWNER> 的告警");

    // Attempt 1 hits Multica 503 after rotating epoch
    failNextIssueCreate = true;
    const attempt1 = await consumeQueue(
      new Request(baseEnv.RELAY_CONSUMER_URL!, { method: "POST", body: JSON.stringify(newQueued) }),
      envFull,
      fetcher,
    );
    expect(attempt1.status).toBe(503);

    // Attempt 2 retries -> keeps same epoch=1, creates issue-2 cleanly, and schedules watchdog!
    const attempt2 = await consumeQueue(
      new Request(baseEnv.RELAY_CONSUMER_URL!, { method: "POST", body: JSON.stringify(newQueued) }),
      envFull,
      fetcher,
    );
    const res2 = await attempt2.json();
    expect(res2.action).toBe("created");
    expect(res2.issueId).toBe("issue-2");
    expect(issues).toHaveLength(2);
    // Transient `relay-progress-` block in thread replies was filtered out of Issue description!
    expect(issues[1]!.description).not.toContain("临时进度");

    // Watchdog scheduled from `!new <prompt>` (where text has no leading @mention) passes consumeQueue!
    const watchdogPayload = queuedPayloads.pop()!;
    expect(watchdogPayload.operation).toBe("watchdog");
    const dogRes = await consumeQueue(
      new Request(baseEnv.RELAY_CONSUMER_URL!, { method: "POST", body: JSON.stringify(watchdogPayload) }),
      envFull,
      fetcher,
    );
    expect((await dogRes.json()).action).toBe("watchdog_cleaned");
  });
});
