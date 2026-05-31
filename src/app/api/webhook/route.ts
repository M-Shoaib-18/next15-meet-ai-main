import OpenAI from "openai";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  MessageNewEvent,
  CallEndedEvent,
  CallSessionEndedEvent,
  CallTranscriptionReadyEvent,
  CallRecordingReadyEvent,
  CallSessionParticipantLeftEvent,
  CallSessionStartedEvent,
} from "@stream-io/node-sdk";
import { createRealtimeClient, RealtimeClient } from "@stream-io/openai-realtime-api";

import { db } from "@/db";
import { agents, meetings } from "@/db/schema";
import { streamVideo } from "@/lib/stream-video";
import { inngest } from "@/inngest/client";
import { generateAvatarUri } from "@/lib/avatar";
import { streamChat } from "@/lib/stream-chat";

const openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Persistent agent connection store
// ---------------------------------------------------------------------------
// globalThis survives Next.js hot-module-reload (HMR) in development.
// A plain module-level const is re-initialized on every HMR triggered by a
// file save, which drops the RealtimeClient reference, GC's it, and closes
// the WebSocket — making the agent leave in under a second.
// ---------------------------------------------------------------------------
const g = globalThis as typeof globalThis & {
  __agentConnections?: Map<string, RealtimeClient>;
};
if (!g.__agentConnections) {
  g.__agentConnections = new Map<string, RealtimeClient>();
}
const activeAgentConnections = g.__agentConnections;

// ---------------------------------------------------------------------------
// Processed chat-message store (idempotency for message.new)
// ---------------------------------------------------------------------------
// Stream retries webhook deliveries that respond slowly. The message.new
// handler does several seconds of work (chat history + OpenAI completion)
// before returning 200, so the same message can be delivered 2–3 times,
// producing duplicate agent replies. We dedupe by message id. The Set lives
// on globalThis so it survives Next.js HMR in development.
// ---------------------------------------------------------------------------
const gChat = globalThis as typeof globalThis & {
  __processedChatMessages?: Set<string>;
};
if (!gChat.__processedChatMessages) {
  gChat.__processedChatMessages = new Set<string>();
}
const processedChatMessages = gChat.__processedChatMessages;

/** Maximum reconnect attempts after an unexpected WebSocket close. */
export const MAX_AGENT_RETRIES = 2;

/**
 * Triggers the Inngest summarization job for a meeting that just transitioned
 * to "processing", provided its transcript has already been saved.
 *
 * `meeting` is the row returned by the status-transition UPDATE. It is only
 * defined when THIS event actually performed the active→processing transition,
 * which guarantees we trigger at most once per meeting from the webhook side.
 * The Inngest event id (`mp-<meetingId>`) additionally dedupes against the
 * trigger fired by saveRealtimeTranscript, so the summary runs exactly once.
 */
async function triggerSummaryIfReady(
  meeting: { transcriptUrl: string | null } | undefined,
  meetingId: string,
): Promise<void> {
  if (!meeting?.transcriptUrl) return;
  try {
    await inngest.send({
      id: `mp-${meetingId}`,
      name: "meetings/processing",
      data: { meetingId, transcriptUrl: meeting.transcriptUrl },
    });
  } catch (err) {
    console.error(
      `[webhook] Failed to trigger Inngest summary for meeting ${meetingId}:`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Token generation helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Generates a Stream call token for the AI agent.
 * exp is always set in *seconds* (Unix timestamp), not milliseconds.
 * TTL defaults to 3600 s (1 hour).
 */
export function generateAgentToken(
  agentId: string,
  callCid: string,
  validityInSeconds = 3600,
): string {
  const token = streamVideo.generateCallToken({
    user_id: agentId,
    call_cids: [callCid],
    validity_in_seconds: validityInSeconds,
  });
  // Debug: log the decoded payload so we can verify exp is in seconds
  try {
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    );
    console.debug(
      `[agent-token] user_id=${payload.user_id} iat=${payload.iat} exp=${payload.exp}` +
        ` (TTL=${payload.exp - payload.iat}s, valid_until=${new Date(payload.exp * 1000).toISOString()})`,
    );
  } catch {
    // Decoding is best-effort; never break token issuance
  }
  return token;
}

// ---------------------------------------------------------------------------
// connectAgent helpers
// ---------------------------------------------------------------------------

/**
 * Event-driven replacement for the base client's waitForSessionCreated().
 *
 * The base implementation is a busy-poll loop (while (!sessionCreated) sleep(1ms))
 * with no connection-drop detection. If the WebSocket closes before session.created
 * is received, the loop spins forever and connectAgent never returns.
 *
 * This version:
 * - Returns immediately if sessionCreated is already true (session.created was
 *   the first message, which is the normal case with OpenAI Realtime API)
 * - Uses event listeners instead of polling (no event-loop pressure)
 * - Rejects on connection close (unblocks connectAgent so the catch path runs)
 * - Rejects after timeoutMs if neither event fires
 */
function awaitSessionCreated(
  client: RealtimeClient,
  meetingId: string,
  timeoutMs = 10_000,
): Promise<void> {
  if (client.sessionCreated) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    function onSession() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.realtime.off("close", onClose); } catch { /* already removed */ }
      resolve();
    }

    function onClose() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.realtime.off("server.session.created", onSession); } catch { /* already removed */ }
      reject(new Error(`[agent:${meetingId}] WS closed before session.created`));
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.realtime.off("server.session.created", onSession); } catch { /* already removed */ }
      try { client.realtime.off("close", onClose); } catch { /* already removed */ }
      reject(new Error(`[agent:${meetingId}] Timed out waiting for session.created`));
    }, timeoutMs);

    client.realtime.on("server.session.created", onSession);
    client.realtime.on("close", onClose);
  });
}

// ---------------------------------------------------------------------------
// connectAgent — creates, connects, and keeps alive the OpenAI Realtime agent
// ---------------------------------------------------------------------------

/**
 * Creates a Realtime agent for the given meeting and stores it in the global
 * connection map.  On unexpected WebSocket close the function retries up to
 * MAX_AGENT_RETRIES times with exponential back-off (1 s, 2 s).
 *
 * Key design decisions:
 * 1. The agent user is upserted into Stream before connecting — Stream rejects
 *    JWTs for unknown user IDs with an immediate WebSocket close (no message),
 *    which the SDK surfaces as dispatch("close", {error:false}).
 * 2. The "close" listener is attached BEFORE connect() so it cannot be missed.
 *    The patched connect() in @stream-io/openai-realtime-api resolves on the
 *    first *message* (not on 'open'). If the WS closes between 'open' and the
 *    first message, attaching after await would miss that window.
 * 3. sessionEstablished flag: the close handler only retries if connect() had
 *    already resolved. If connect() itself throws (e.g. OpenAI sends an error
 *    message which triggers disconnect() which fires the close event), the close
 *    handler must NOT retry — that would create an infinite loop for permanent
 *    errors like invalid API key or unsupported model.
 * 4. awaitSessionCreated() replaces the base waitForSessionCreated() busy-poll
 *    to avoid an infinite loop when the WS closes before session.created.
 * 5. We bypass streamVideo.video.connectOpenAi() because in
 *    @stream-io/node-sdk ≥ 0.7.x it uses the chat API client's baseUrl
 *    (chat.stream-io-api.com) instead of the video endpoint.
 */
export async function connectAgent(
  meetingId: string,
  agentId: string,
  agentName: string,
  agentInstructions: string,
  retryCount = 0,
): Promise<void> {
  // ------------------------------------------------------------------
  // Guard: prevent concurrent connect calls for the same meeting.
  // Stream webhooks time out in ~5 s and retry — without this guard a
  // second call.session_started delivery races with the first.
  // ------------------------------------------------------------------
  if (retryCount === 0 && activeAgentConnections.has(meetingId)) {
    console.log(`[agent:${meetingId}] Connection already active or pending — skipping duplicate`);
    return;
  }
  if (retryCount === 0) {
    activeAgentConnections.set(meetingId, null as unknown as RealtimeClient);
  }

  // Whether connect() has resolved at least once for this invocation.
  // The close handler must NOT retry if connect() itself failed — doing so
  // would loop forever on permanent errors (invalid key, unsupported model).
  let sessionEstablished = false;

  try {
  // ------------------------------------------------------------------
  // 1. Register the agent user in Stream so the JWT is accepted.
  // ------------------------------------------------------------------
  await streamVideo.upsertUsers([
    { id: agentId, name: agentName, role: "user" },
  ]);

  const call = streamVideo.video.call("default", meetingId);
  const token = generateAgentToken(agentId, call.cid);

  console.log(
    `[agent:${meetingId}] Connecting OpenAI Realtime agent` +
      ` (attempt ${retryCount + 1}/${MAX_AGENT_RETRIES + 1})`,
  );

  const realtimeClient = createRealtimeClient({
    baseUrl: "https://video.stream-io-api.com",
    call,
    streamApiKey: env.NEXT_PUBLIC_STREAM_VIDEO_API_KEY,
    streamUserToken: token,
    openAiApiKey: env.OPENAI_API_KEY,
    model: "gpt-4o-realtime-preview",
  });

  // Log server errors so we can see exactly what OpenAI/Stream is sending.
  realtimeClient.realtime.on("server.error", (event: Record<string, unknown>) => {
    console.error(
      `[agent:${meetingId}] server.error:`,
      JSON.stringify(event).slice(0, 500),
    );
  });

  // ------------------------------------------------------------------
  // 2. Attach the close listener BEFORE connect().
  // ------------------------------------------------------------------
  realtimeClient.realtime.on(
    "close",
    async ({ error }: { error: boolean }) => {
      // Wrap the entire handler body so that no code path — including the DB
      // query — can escape as an unhandled promise rejection.
      try {
        console.warn(
          `[agent:${meetingId}] WebSocket closed` +
            ` (error=${error}, sessionEstablished=${sessionEstablished},` +
            ` attempt=${retryCount + 1}/${MAX_AGENT_RETRIES + 1})`,
        );
        activeAgentConnections.delete(meetingId);

        // Do NOT retry if connect() itself never resolved successfully.
        // Scenario: an error message from OpenAI causes the SDK's error handler
        // to call disconnect(), which fires the WS close event. The promise
        // already rejected; retrying would produce the same permanent error.
        if (!sessionEstablished) {
          console.warn(
            `[agent:${meetingId}] Connection closed before session was established — not retrying via close handler`,
          );
          return;
        }

        if (retryCount >= MAX_AGENT_RETRIES) {
          console.error(
            `[agent:${meetingId}] Agent exhausted ${MAX_AGENT_RETRIES} retries; giving up`,
          );
          return;
        }

        // Only reconnect if the meeting is still active
        const [meeting] = await db
          .select()
          .from(meetings)
          .where(eq(meetings.id, meetingId));

        if (!meeting || meeting.status !== "active") {
          console.log(
            `[agent:${meetingId}] Meeting status="${meeting?.status ?? "not found"}"; skipping reconnect`,
          );
          return;
        }

        const backoffMs = Math.pow(2, retryCount) * 1000;
        console.log(
          `[agent:${meetingId}] Reconnecting in ${backoffMs} ms (attempt ${retryCount + 2})…`,
        );
        await new Promise<void>((r) => setTimeout(r, backoffMs));

        await connectAgent(meetingId, agentId, agentName, agentInstructions, retryCount + 1);
      } catch (err) {
        console.error(`[agent:${meetingId}] Reconnect failed:`, err);
      }
    },
  );

  // ------------------------------------------------------------------
  // 3. Connect — throws if the server immediately sends an error message.
  //    After this resolves, the agent is a Stream Video participant.
  // ------------------------------------------------------------------
  await realtimeClient.connect();

  // Mark the session as established BEFORE awaitSessionCreated so that if
  // the WS closes while waiting, the close handler above sees this flag and
  // retries (the agent was a real participant; retry is appropriate).
  sessionEstablished = true;
  console.log(`[agent:${meetingId}] connect() resolved — agent is a Stream participant`);

  // ------------------------------------------------------------------
  // 4. Wait for session.created before configuring the session.
  //    Uses event-driven approach instead of busy-poll to avoid blocking
  //    the event loop and to handle WS close correctly.
  // ------------------------------------------------------------------
  await awaitSessionCreated(realtimeClient, meetingId);
  console.log(`[agent:${meetingId}] session.created — configuring instructions`);

  // SessionResourceType predates the GA rename and has no "type" field, but the
  // GA API requires it. Cast so the extra field reaches the wire correctly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtimeClient.updateSession({ type: "realtime", instructions: agentInstructions } as any);
  activeAgentConnections.set(meetingId, realtimeClient);
  console.log(`[agent:${meetingId}] Agent fully connected and configured`);

  } catch (err) {
    // Release the slot so a future retry (from close handler or next webhook) can attempt
    if (!activeAgentConnections.get(meetingId)) {
      activeAgentConnections.delete(meetingId);
    }
    console.error(`[agent:${meetingId}] connectAgent error (attempt ${retryCount + 1}):`, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

function verifySignatureWithSDK(body: string, signature: string): boolean {
  return streamVideo.verifyWebhook(body, signature);
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-signature");
  const apiKey = req.headers.get("x-api-key");

  if (!signature || !apiKey) {
    return NextResponse.json(
      { error: "Missing signature or API key" },
      { status: 400 },
    );
  }

  const body = await req.text();

  if (!verifySignatureWithSDK(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventType = (payload as Record<string, unknown>)?.type;

  // -------------------------------------------------------------------------
  if (eventType === "call.session_started") {
    const event = payload as CallSessionStartedEvent;
    const meetingId = event.call.custom?.meetingId;

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    console.log(`[webhook] call.session_started meetingId=${meetingId}`);

    // Atomic update: only transitions "upcoming" → "active" once.
    // If this fires twice, the second returns 0 rows and is ignored.
    const [existingMeeting] = await db
      .update(meetings)
      .set({ status: "active", startedAt: new Date() })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "upcoming")))
      .returning();

    if (!existingMeeting) {
      return NextResponse.json({ status: "ok" });
    }

    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, existingMeeting.agentId));

    if (!existingAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // The AI agent connects exclusively client-side via OpenAI WebRTC.
    // The browser calls meetings.createRealtimeSession to obtain an ephemeral
    // token and opens a direct RTCPeerConnection to OpenAI — no server proxy needed.
    console.log(
      `[webhook] call.session_started meetingId=${meetingId} agentId=${existingAgent.id}` +
      ` — waiting for client-side WebRTC connection`,
    );

  // -------------------------------------------------------------------------
  } else if (eventType === "call.session_participant_left") {
    const event = payload as CallSessionParticipantLeftEvent;
    const meetingId = event.call_cid.split(":")[1];

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    const participantUserId = event.participant?.user?.id;
    console.log(
      `[webhook] call.session_participant_left meetingId=${meetingId} userId=${participantUserId}`,
    );

    const [existingMeeting] = await db
      .select()
      .from(meetings)
      .where(eq(meetings.id, meetingId));

    // If the AI agent left, do NOT touch the connection map.
    // The WebSocket close handler in connectAgent already deletes the stale entry
    // and manages retries. Deleting here races against a reconnect that may have
    // already stored a new client in the map under the same meetingId key.
    if (participantUserId === existingMeeting?.agentId) {
      console.log(`[webhook] AI agent left meetingId=${meetingId} — handled by WS close handler`);
      return NextResponse.json({ status: "ok" });
    }

    // Human participant left → end the call server-side
    console.log(`[webhook] Human left meetingId=${meetingId} — ending call`);
    const call = streamVideo.video.call("default", meetingId);
    try {
      await call.end();
    } catch {
      // Call may already be ended; safe to ignore
    }

  // -------------------------------------------------------------------------
  } else if (eventType === "call.session_ended") {
    const event = payload as CallSessionEndedEvent;
    const meetingId = event.call.custom?.meetingId;

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    console.log(`[webhook] call.session_ended meetingId=${meetingId}`);

    // Update DB FIRST so the close handler sees "processing" and does not
    // reconnect when agentClient.disconnect() fires the WebSocket close event.
    const [endedMeeting] = await db
      .update(meetings)
      .set({ status: "processing", endedAt: new Date() })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")))
      .returning();

    const agentClient = activeAgentConnections.get(meetingId);
    if (agentClient) {
      try {
        await agentClient.disconnect();
      } catch {
        // Already disconnected — safe to ignore
      }
      activeAgentConnections.delete(meetingId);
    }

    // If the client already saved its OpenAI Realtime transcript during the
    // call, kick off summarization now. (Stream's own transcription is
    // disabled, so this is the trigger for the summary pipeline.) If the
    // transcript hasn't been saved yet, saveRealtimeTranscript triggers it
    // instead once the final POST lands. The shared event id dedupes both.
    await triggerSummaryIfReady(endedMeeting, meetingId);

  // -------------------------------------------------------------------------
  } else if (eventType === "call.ended") {
    // Fired when call.end() is called server-side after the last participant
    // leaves. This is the primary trigger for the transcript pipeline.
    const event = payload as CallEndedEvent;
    const meetingId = event.call.custom?.meetingId;

    if (!meetingId) {
      return NextResponse.json({ error: "Missing meetingId" }, { status: 400 });
    }

    console.log(`[webhook] call.ended meetingId=${meetingId}`);

    // Update DB FIRST — same race-condition guard as call.session_ended.
    const [endedMeeting] = await db
      .update(meetings)
      .set({ status: "processing", endedAt: new Date() })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")))
      .returning();

    const agentClient = activeAgentConnections.get(meetingId);
    if (agentClient) {
      try {
        await agentClient.disconnect();
      } catch {
        // Already disconnected — safe to ignore
      }
      activeAgentConnections.delete(meetingId);
    }

    await triggerSummaryIfReady(endedMeeting, meetingId);

  // -------------------------------------------------------------------------
  } else if (eventType === "call.transcription_ready") {
    const event = payload as CallTranscriptionReadyEvent;
    const meetingId = event.call_cid.split(":")[1];

    console.log(`[webhook] call.transcription_ready meetingId=${meetingId}`);

    const [updatedMeeting] = await db
      .update(meetings)
      .set({ transcriptUrl: event.call_transcription.url })
      .where(eq(meetings.id, meetingId))
      .returning();

    if (!updatedMeeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    try {
      await inngest.send({
        name: "meetings/processing",
        data: {
          meetingId: updatedMeeting.id,
          transcriptUrl: updatedMeeting.transcriptUrl,
        },
      });
    } catch (err) {
      console.error(
        `[webhook] Failed to trigger Inngest processing for meeting ${updatedMeeting.id}:`,
        err,
      );
    }

  // -------------------------------------------------------------------------
  } else if (eventType === "call.recording_ready") {
    const event = payload as CallRecordingReadyEvent;
    const meetingId = event.call_cid.split(":")[1];

    console.log(`[webhook] call.recording_ready meetingId=${meetingId}`);

    await db
      .update(meetings)
      .set({ recordingUrl: event.call_recording.url })
      .where(eq(meetings.id, meetingId));

  // -------------------------------------------------------------------------
  } else if (eventType === "message.new") {
    const event = payload as MessageNewEvent;

    const userId = event.user?.id;
    const channelId = event.channel_id;
    const text = event.message?.text;

    if (!userId || !channelId || !text) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Idempotency guard: Stream may redeliver the same message.new event when
    // our handler is slow. Process each message id exactly once so the agent
    // never replies twice/thrice to the same user message.
    const incomingMessageId = event.message?.id;
    if (incomingMessageId) {
      if (processedChatMessages.has(incomingMessageId)) {
        return NextResponse.json({ status: "ok", deduped: true });
      }
      processedChatMessages.add(incomingMessageId);
      // Bound the set so it can't grow without limit during a long-running dev
      // server. Drop the oldest ~half once it gets large.
      if (processedChatMessages.size > 1000) {
        const iterator = processedChatMessages.values();
        for (let i = 0; i < 500; i++) {
          const next = iterator.next();
          if (next.done) break;
          processedChatMessages.delete(next.value);
        }
      }
    }

    const [existingMeeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, channelId), eq(meetings.status, "completed")));

    if (!existingMeeting) {
      return NextResponse.json({ error: "Meeting not found" }, { status: 404 });
    }

    const [existingAgent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, existingMeeting.agentId));

    if (!existingAgent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    if (userId !== existingAgent.id) {
      const instructions = `
You are an AI assistant helping the user revisit a recently completed meeting.
Below is a summary of the meeting, generated from the transcript:

${existingMeeting.summary}

The following are your original instructions from the live meeting assistant. Please continue to follow these behavioral guidelines as you assist the user:

${existingAgent.instructions}

The user may ask questions about the meeting, request clarifications, or ask for follow-up actions.
Always base your responses on the meeting summary above.

You also have access to the recent conversation history between you and the user. Use the context of previous messages to provide relevant, coherent, and helpful responses. If the user's question refers to something discussed earlier, make sure to take that into account and maintain continuity in the conversation.

If the summary does not contain enough information to answer a question, politely let the user know.

Be concise, helpful, and focus on providing accurate information from the meeting and the ongoing conversation.
      `;

      let previousMessages: ChatCompletionMessageParam[] = [];
      try {
        const channel = streamChat.channel("messaging", channelId);
        await channel.watch();
        previousMessages = channel.state.messages
          .slice(-5)
          .filter((msg) => msg.text && msg.text.trim() !== "")
          .map<ChatCompletionMessageParam>((message) => ({
            role: message.user?.id === existingAgent.id ? "assistant" : "user",
            content: message.text || "",
          }));
      } catch (err) {
        console.error(
          `[webhook] Failed to fetch chat history for channel ${channelId}:`,
          err,
        );
      }

      let GPTResponseText: string | null = null;
      try {
        const GPTResponse = await openaiClient.chat.completions.create({
          messages: [
            { role: "system", content: instructions },
            ...previousMessages,
            { role: "user", content: text },
          ],
          model: "gpt-4o-mini",
        });
        GPTResponseText = GPTResponse.choices[0]?.message.content ?? null;
      } catch (err) {
        console.error(
          `[webhook] OpenAI completion failed for channel ${channelId}:`,
          err,
        );
      }

      if (!GPTResponseText) {
        return NextResponse.json({ status: "ok" });
      }

      const avatarUrl = generateAvatarUri({
        seed: existingAgent.name,
        variant: "botttsNeutral",
      });

      try {
        await streamChat.upsertUser({
          id: existingAgent.id,
          name: existingAgent.name,
          image: avatarUrl,
        });

        const channel = streamChat.channel("messaging", channelId);
        await channel.sendMessage({
          text: GPTResponseText,
          user: {
            id: existingAgent.id,
            name: existingAgent.name,
            image: avatarUrl,
          },
        });
      } catch (err) {
        console.error(
          `[webhook] Failed to send agent reply for channel ${channelId}:`,
          err,
        );
      }
    }
  }

  return NextResponse.json({ status: "ok" });
}
