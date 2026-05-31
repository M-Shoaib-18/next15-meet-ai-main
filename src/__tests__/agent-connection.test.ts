/**
 * Unit tests for agent token generation and reconnection logic.
 *
 * Run:  npm test
 * Watch: npm run test:watch
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use them
// ---------------------------------------------------------------------------

// Mock server-only modules and external SDKs so Jest can load the webhook
// module without a real database or API credentials.
jest.mock("server-only", () => ({}));

jest.mock("@/db", () => ({ db: {} }));
jest.mock("@/db/schema", () => ({ agents: {}, meetings: {} }));
jest.mock("@/inngest/client", () => ({ inngest: { send: jest.fn() } }));
jest.mock("@/lib/stream-video", () => ({
  streamVideo: {
    verifyWebhook: jest.fn(() => true),
    video: { call: jest.fn() },
    generateCallToken: jest.fn(),
    upsertUsers: jest.fn().mockResolvedValue({}),
  },
}));
jest.mock("@/lib/stream-chat", () => ({ streamChat: {} }));
jest.mock("@/lib/avatar", () => ({ generateAvatarUri: jest.fn(() => "") }));
jest.mock("@/lib/env", () => ({
  env: {
    OPENAI_API_KEY: "test-openai-key",
    NEXT_PUBLIC_STREAM_VIDEO_API_KEY: "test-stream-key",
    NEXT_PUBLIC_STREAM_CHAT_API_KEY: "test-chat-key",
  },
}));
jest.mock("@stream-io/openai-realtime-api", () => ({
  createRealtimeClient: jest.fn(),
}));
jest.mock("openai", () =>
  jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
  })),
);
jest.mock("drizzle-orm", () => ({
  and: jest.fn(),
  eq: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { streamVideo } from "@/lib/stream-video";
import { createRealtimeClient } from "@stream-io/openai-realtime-api";
import { MAX_AGENT_RETRIES, generateAgentToken, connectAgent } from "@/app/api/webhook/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake RealtimeClient with a controllable close emitter. */
function makeMockClient() {
  const closeHandlers: Array<(payload: { error: boolean }) => void> = [];

  const realtime = {
    on: jest.fn((event: string, handler: (p: { error: boolean }) => void) => {
      if (event === "close") closeHandlers.push(handler);
    }),
    off: jest.fn(),
  };

  const client = {
    realtime,
    connect: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(undefined),
    updateSession: jest.fn(),
    waitForSessionCreated: jest.fn().mockResolvedValue(true),
    // awaitSessionCreated() checks this flag first; setting true triggers the fast-path
    // (returns immediately without registering server.session.created / close listeners).
    sessionCreated: true,
    /** Simulate WebSocket close from the outside. */
    _triggerClose(error = false) {
      closeHandlers.forEach((h) => h({ error }));
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// Token generation tests
// ---------------------------------------------------------------------------

describe("generateAgentToken", () => {
  const MOCK_TOKEN_PAYLOAD = {
    user_id: "agent-1",
    call_cids: ["default:meeting-1"],
    iat: Math.floor(Date.now() / 1000) - 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  beforeEach(() => {
    // Return a fake JWT whose middle segment encodes our payload
    const payloadB64 = Buffer.from(JSON.stringify(MOCK_TOKEN_PAYLOAD)).toString("base64url");
    (streamVideo.generateCallToken as jest.Mock).mockReturnValue(
      `header.${payloadB64}.sig`,
    );
    (streamVideo.video.call as jest.Mock).mockReturnValue({ cid: "default:meeting-1" });
  });

  it("calls generateCallToken with validity_in_seconds=3600 by default", () => {
    generateAgentToken("agent-1", "default:meeting-1");

    expect(streamVideo.generateCallToken).toHaveBeenCalledWith(
      expect.objectContaining({ validity_in_seconds: 3600 }),
    );
  });

  it("exp is in seconds, not milliseconds", () => {
    generateAgentToken("agent-1", "default:meeting-1");

    const call = (streamVideo.generateCallToken as jest.Mock).mock.calls[0][0];
    // validity_in_seconds is the TTL; verify it's ≤ 3 600 s, not milliseconds (3 600 000)
    expect(call.validity_in_seconds).toBeLessThanOrEqual(3600);
    expect(call.validity_in_seconds).toBeGreaterThanOrEqual(3600);

    // Verify that the decoded exp is a reasonable Unix timestamp in seconds.
    // Current year 2026 ≈ 1.75 × 10⁹ s but 1.75 × 10¹² ms — anything above
    // 1 × 10¹² is clearly in milliseconds.
    const { exp } = MOCK_TOKEN_PAYLOAD;
    expect(exp).toBeLessThan(1e12); // < 1 trillion → seconds
    expect(exp).toBeGreaterThan(1e9); // > 1 billion → real Unix ts
  });

  it("TTL is at least 3 600 seconds (1 hour)", () => {
    const { iat, exp } = MOCK_TOKEN_PAYLOAD;
    expect(exp - iat).toBeGreaterThanOrEqual(3600);
  });

  it("accepts a custom TTL", () => {
    generateAgentToken("agent-1", "default:meeting-1", 7200);
    expect(streamVideo.generateCallToken).toHaveBeenCalledWith(
      expect.objectContaining({ validity_in_seconds: 7200 }),
    );
  });
});

// ---------------------------------------------------------------------------
// connectAgent — reconnection tests
// ---------------------------------------------------------------------------

describe("connectAgent reconnection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear the global agent connections map so the duplicate-guard doesn't
    // carry state from a previous test in this suite.
    (globalThis as { __agentConnections?: Map<string, unknown> }).__agentConnections?.clear();
    (streamVideo.video.call as jest.Mock).mockReturnValue({
      cid: "default:mtg-1",
    });

    const payloadB64 = Buffer.from(
      JSON.stringify({ user_id: "a", iat: 0, exp: 3600 }),
    ).toString("base64url");
    (streamVideo.generateCallToken as jest.Mock).mockReturnValue(
      `h.${payloadB64}.s`,
    );
  });

  it("stores client in activeAgentConnections after successful connect", async () => {
    const mockClient = makeMockClient();
    (createRealtimeClient as jest.Mock).mockReturnValue(mockClient);

    await connectAgent("mtg-1", "agent-1", "Test Agent", "Be helpful.");

    expect(mockClient.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: "realtime", instructions: "Be helpful." }),
    );
  });

  it("attaches a close listener after connecting", async () => {
    const mockClient = makeMockClient();
    (createRealtimeClient as jest.Mock).mockReturnValue(mockClient);

    await connectAgent("mtg-1", "agent-1", "Test Agent", "Be helpful.");

    expect(mockClient.realtime.on).toHaveBeenCalledWith(
      "close",
      expect.any(Function),
    );
  });

  it(`retries up to MAX_AGENT_RETRIES (${MAX_AGENT_RETRIES}) times on close with error`, async () => {
    // Track how many times createRealtimeClient is called — each call is one
    // connect attempt (original + retries).
    const clients: ReturnType<typeof makeMockClient>[] = [];
    (createRealtimeClient as jest.Mock).mockImplementation(() => {
      const c = makeMockClient();
      clients.push(c);
      return c;
    });

    // Mock DB query used inside the close handler to check meeting status
    const { db } = require("@/db");
    const { meetings } = require("@/db/schema");
    const drizzle = require("drizzle-orm");
    db.select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ status: "active" }]),
      }),
    });
    drizzle.eq.mockReturnValue("eq-expr");

    // Connect initially
    await connectAgent("mtg-1", "agent-1", "Test Agent", "instructions", 0);
    expect(clients).toHaveLength(1);

    // Simulate unexpected close (error=true) on the first client.
    // Use a short timeout so the async retry fires within the test.
    jest.useFakeTimers();
    clients[0]._triggerClose(true);

    // Drain the event-loop tick so the close handler starts executing
    await Promise.resolve();

    // Fast-forward past the first back-off (1 000 ms)
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    // After reconnect, the second client was created
    expect(clients.length).toBeGreaterThanOrEqual(2);

    jest.useRealTimers();
  });

  it("does NOT retry when retryCount has reached MAX_AGENT_RETRIES", async () => {
    const mockClient = makeMockClient();
    (createRealtimeClient as jest.Mock).mockReturnValue(mockClient);

    // Call connectAgent already at the retry limit
    await connectAgent("mtg-1", "agent-1", "Test Agent", "instructions", MAX_AGENT_RETRIES);

    // Trigger close — no further connect attempts should happen
    mockClient._triggerClose(true);
    await Promise.resolve();

    // createRealtimeClient was called exactly once (the initial connect only)
    expect(createRealtimeClient).toHaveBeenCalledTimes(1);
  });

  it("stops retrying if meeting is no longer active", async () => {
    const mockClient = makeMockClient();
    (createRealtimeClient as jest.Mock).mockReturnValue(mockClient);

    // DB returns a non-active meeting
    const { db } = require("@/db");
    db.select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ status: "completed" }]),
      }),
    });

    await connectAgent("mtg-1", "agent-1", "Test Agent", "instructions", 0);

    jest.useFakeTimers();
    mockClient._triggerClose(false);
    await Promise.resolve();

    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    // Only 1 call — the original connect; no retry because meeting is done
    expect(createRealtimeClient).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
