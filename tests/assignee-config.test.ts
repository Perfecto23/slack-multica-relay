import { describe, expect, it } from "vitest";
import { loadRelayConfig } from "../src/config.js";
import { assignee, threadScopeId } from "../src/multica-api.js";

const env = {
  SLACK_SIGNING_SECRET: "test", SLACK_TEAM_ID: "T1", SLACK_TARGET_USER_IDS: "U1",
  SLACK_ALLOWED_CHANNEL_IDS: "C1", MULTICA_API_BASE_URL: "https://multica.test",
  MULTICA_API_TOKEN: "test", MULTICA_WORKSPACE_ID: "ws", MULTICA_PROJECT_ID: "project",
  MULTICA_AGENT_ID: "old-agent", SLACK_USER_TOKEN: "test", SLACK_CONTEXT_TOKEN: "test",
  SLACK_REACTION_NAME: "eyes", KV_REST_API_URL: "https://kv.test", KV_REST_API_TOKEN: "test",
  QSTASH_TOKEN: "test", QSTASH_CURRENT_SIGNING_KEY: "test", QSTASH_NEXT_SIGNING_KEY: "test",
  RELAY_CONSUMER_URL: "https://relay.test/api/queue/consume",
};

describe("deployment assignment", () => {
  it("keeps the original Agent scope with existing environment", () => {
    const config = loadRelayConfig(env);
    expect(assignee(config)).toEqual({ type: "agent", id: "old-agent" });
    expect(threadScopeId(config)).toBe("old-agent");
    expect(config.slackContextToken).toBe("test");
  });
  it("routes a new Team into its own scope", () => {
    const config = loadRelayConfig({ ...env, MULTICA_ASSIGNEE_TYPE: "squad", MULTICA_ASSIGNEE_ID: "team" });
    expect(assignee(config)).toEqual({ type: "squad", id: "team" });
    expect(threadScopeId(config)).toBe("squad:team");
  });
  it("preserves the old scope only when migration is explicitly configured", () => {
    const config = loadRelayConfig({ ...env, MULTICA_ASSIGNEE_TYPE: "squad", MULTICA_ASSIGNEE_ID: "team",
      MULTICA_THREAD_SCOPE_ID: "old-agent", MULTICA_LEGACY_AGENT_ID: "old-agent" });
    expect(threadScopeId(config)).toBe("old-agent");
    expect(config.multicaLegacyAgentId).toBe("old-agent");
  });
  it.each([
    { MULTICA_ASSIGNEE_TYPE: "user" },
    { MULTICA_ASSIGNEE_TYPE: "squad" },
    { MULTICA_LEGACY_AGENT_ID: "old-agent" },
    { MULTICA_ASSIGNEE_TYPE: "squad", MULTICA_ASSIGNEE_ID: "team", MULTICA_LEGACY_AGENT_ID: "old-agent" },
  ])("rejects incomplete or contradictory assignment: %j", (change) => {
    expect(() => loadRelayConfig({ ...env, ...change })).toThrow();
  });
});

describe("queued marker configuration", () => {
  it("defaults the queue agent to the assignee in agent mode and needs it explicitly for a squad", () => {
    expect(loadRelayConfig({ ...env, SLACK_QUEUED_REACTION_NAME: ":hourglass_flowing_sand:" }))
      .toMatchObject({ slackQueuedReactionName: "hourglass_flowing_sand", multicaQueueAgentId: "old-agent" });
    const squad = loadRelayConfig({ ...env, MULTICA_ASSIGNEE_TYPE: "squad", MULTICA_ASSIGNEE_ID: "team" });
    expect(squad.multicaQueueAgentId).toBeUndefined();
    expect(loadRelayConfig({ ...env, MULTICA_ASSIGNEE_TYPE: "squad", MULTICA_ASSIGNEE_ID: "team", MULTICA_QUEUE_AGENT_ID: " leader " })
      .multicaQueueAgentId).toBe("leader");
  });
  it("turns the marker off for an empty or malformed emoji name", () => {
    for (const value of [undefined, "", "  ", "Hour Glass", "⏳"])
      expect(loadRelayConfig({ ...env, SLACK_QUEUED_REACTION_NAME: value as string }).slackQueuedReactionName).toBeUndefined();
  });
});
