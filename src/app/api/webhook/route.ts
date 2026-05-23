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

/** Maximum reconnect attempts after an unexpected WebSocket close. */
export const MAX_AGENT_RETRIES = 2;

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
// connectAgent — creates, connects, and keeps alive the OpenAI Realtime agent
// ---------------------------------------------------------------------------

/**
 * Creates a Realtime agent for the given meeting and stores it in the global
 * connection map.  On unexpected WebSocket close the function retries up to
 * MAX_AGENT_RETRIES times with exponential back-off (1 s, 2 s).
 *
 * NOTE: We bypass streamVideo.video.connectOpenAi() because in
 * @stream-io/node-sdk ≥ 0.7.x it resolves baseUrl from
 * this.streamClient.apiClient (the *chat* API client, chat.stream-io-api.com)
 * instead of the video API URL.  Using createRealtimeClient directly with the
 * hardcoded video endpoint avoids the wrong-server disconnect.
 */
export async function connectAgent(
  meetingId: string,
  agentId: string,
  agentInstructions: string,
  retryCount = 0,
): Promise<void> {
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

  await realtimeClient.connect();
  console.log(`[agent:${meetingId}] Agent connected successfully`);

  realtimeClient.updateSession({ instructions: agentInstructions });
  activeAgentConnections.set(meetingId, realtimeClient);

  // ------------------------------------------------------------------
  // Close / error listener — logs disconnect and implements reconnection
  // ------------------------------------------------------------------
  realtimeClient.realtime.on(
    "close",
    async ({ error }: { error: boolean }) => {
      console.warn(
        `[agent:${meetingId}] WebSocket closed` +
          ` (error=${error}, attempt=${retryCount + 1}/${MAX_AGENT_RETRIES + 1})`,
      );
      activeAgentConnections.delete(meetingId);

      if (retryCount >= MAX_AGENT_RETRIES) {
        console.error(
          `[agent:${meetingId}] Agent exhausted ${MAX_AGENT_RETRIES} retries; giving up`,
        );
        return;
      }

      // Only reconnect if the meeting is still active (not ended by the user)
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

      const backoffMs = Math.pow(2, retryCount) * 1000; // 1 000 ms, 2 000 ms
      console.log(
        `[agent:${meetingId}] Reconnecting in ${backoffMs} ms (attempt ${retryCount + 2})…`,
      );
      await new Promise<void>((r) => setTimeout(r, backoffMs));

      try {
        await connectAgent(meetingId, agentId, agentInstructions, retryCount + 1);
      } catch (err) {
        console.error(`[agent:${meetingId}] Reconnect failed:`, err);
      }
    },
  );
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

    try {
      await connectAgent(meetingId, existingAgent.id, existingAgent.instructions);
    } catch (err) {
      console.error(
        `[webhook] Failed to connect OpenAI agent for meeting ${meetingId}:`,
        err,
      );
    }

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

    // If the AI agent left, remove the stored connection — do NOT end the call
    if (participantUserId === existingMeeting?.agentId) {
      console.log(`[webhook] AI agent left meetingId=${meetingId} — connection cleaned up`);
      activeAgentConnections.delete(meetingId);
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

    const agentClient = activeAgentConnections.get(meetingId);
    if (agentClient) {
      try {
        await agentClient.disconnect();
      } catch {
        // Already disconnected — safe to ignore
      }
      activeAgentConnections.delete(meetingId);
    }

    await db
      .update(meetings)
      .set({ status: "processing", endedAt: new Date() })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));

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

    const agentClient = activeAgentConnections.get(meetingId);
    if (agentClient) {
      try {
        await agentClient.disconnect();
      } catch {
        // Already disconnected — safe to ignore
      }
      activeAgentConnections.delete(meetingId);
    }

    await db
      .update(meetings)
      .set({ status: "processing", endedAt: new Date() })
      .where(and(eq(meetings.id, meetingId), eq(meetings.status, "active")));

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
