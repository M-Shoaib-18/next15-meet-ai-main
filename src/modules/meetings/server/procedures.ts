import OpenAI from "openai";
import { z } from "zod";
import JSONL from "jsonl-parse-stringify";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, getTableColumns, ilike, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { agents, meetings, user } from "@/db/schema";
import { env } from "@/lib/env";
import { generateAvatarUri } from "@/lib/avatar";
import { streamVideo } from "@/lib/stream-video";
import { inngest } from "@/inngest/client";
import { createTRPCRouter, premiumProcedure, protectedProcedure } from "@/trpc/init";
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MIN_PAGE_SIZE } from "@/constants";
import { MAX_MEETING_DURATION_SECONDS } from "@/modules/premium/entitlements";

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

import { MeetingStatus, StreamTranscriptItem } from "../types";
import { meetingsInsertSchema, meetingsUpdateSchema } from "../schemas";
import { streamChat } from "@/lib/stream-chat";

export const meetingsRouter = createTRPCRouter({
  generateChatToken: protectedProcedure.mutation(async ({ ctx }) => {
    const token = streamChat.createToken(ctx.auth.user.id);
    try {
      await streamChat.upsertUser({
        id: ctx.auth.user.id,
        role: "admin",
      });
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to set up chat. Please try again.",
        cause: err,
      });
    }

    return token;
  }),
  // Live-caption translation. Called client-side per finalized caption line so
  // users can read subtitles in any language. Uses gpt-4o-mini (cheap, fast,
  // near-universal language coverage). Original-language captions cost nothing
  // extra — only translated lines hit this endpoint.
  translateCaption: protectedProcedure
    .input(
      z.object({
        text: z.string().min(1).max(2000),
        // Human-readable target language label, e.g. "Spanish", "Urdu".
        targetLanguage: z.string().min(1).max(60),
      }),
    )
    .mutation(async ({ input }) => {
      const { text, targetLanguage } = input;
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                `You are a translation engine. Translate the user's text into ${targetLanguage}. ` +
                `Output ONLY the translated text — no quotes, no notes, no explanations. ` +
                `If the text is already in ${targetLanguage}, return it unchanged. ` +
                `Preserve tone, meaning, names, and punctuation.`,
            },
            { role: "user", content: text },
          ],
        });

        const translated = completion.choices[0]?.message?.content?.trim() ?? "";
        return { translated };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Translation failed. Please try again.",
          cause: err,
        });
      }
    }),
  getTranscript: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const [existingMeeting] = await db
        .select()
        .from(meetings)
        .where(
          and(eq(meetings.id, input.id), eq(meetings.userId, ctx.auth.user.id))
        );

      if (!existingMeeting) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Meeting not found",
        });
      }

      if (!existingMeeting.transcriptUrl) {
        return [];
      }

      const transcript = await fetch(existingMeeting.transcriptUrl)
        .then((res) => res.text())
        .then((text) => JSONL.parse<StreamTranscriptItem>(text))
        .catch(() => {
          return [];
        });

      const speakerIds = [
        ...new Set(transcript.map((item) => item.speaker_id)),
      ];

      const userSpeakers = await db
        .select()
        .from(user)
        .where(inArray(user.id, speakerIds))
        .then((users) =>
          users.map((user) => ({
            ...user,
            image:
              user.image ??
              generateAvatarUri({ seed: user.name, variant: "initials" }),
          }))
        );

      const agentSpeakers = await db
        .select()
        .from(agents)
        .where(inArray(agents.id, speakerIds))
        .then((agents) =>
          agents.map((agent) => ({
            ...agent,
            image: generateAvatarUri({
              seed: agent.name,
              variant: "botttsNeutral",
            }),
          }))
        );

      const speakers = [...userSpeakers, ...agentSpeakers];

      const transcriptWithSpeakers = transcript.map((item) => {
        const speaker = speakers.find(
          (speaker) => speaker.id === item.speaker_id
        );

        if (!speaker) {
          return {
            ...item,
            user: {
              name: "Unknown",
              image: generateAvatarUri({
                seed: "Unknown",
                variant: "initials",
              }),
            },
          };
        }

        return {
          ...item,
          user: {
            name: speaker.name,
            image: speaker.image,
          },
        };
      })

      return transcriptWithSpeakers;
    }),
  generateToken: protectedProcedure.mutation(async ({ ctx }) => {
    try {
      await streamVideo.upsertUsers([
        {
          id: ctx.auth.user.id,
          name: ctx.auth.user.name,
          role: "admin",
          image:
            ctx.auth.user.image ??
            generateAvatarUri({ seed: ctx.auth.user.name, variant: "initials" }),
        },
      ]);
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to set up video call. Please try again.",
        cause: err,
      });
    }

    const expirationTime = Math.floor(Date.now() / 1000) + 3600;
    const issuedAt = Math.floor(Date.now() / 1000) - 60;

    const token = streamVideo.generateUserToken({
      user_id: ctx.auth.user.id,
      exp: expirationTime,
      iat: issuedAt,
    });

    return token;
  }),
  /**
   * Creates an ephemeral OpenAI Realtime client_secret for a meeting.
   *
   * Uses the GA WebRTC client_secrets endpoint (POST /v1/realtime/client_secrets).
   * The returned ephemeral token is forwarded to the browser, which uses it as
   * the Authorization header when exchanging the WebRTC SDP offer with OpenAI.
   */
  createRealtimeSession: protectedProcedure
    .input(z.object({ meetingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [meeting] = await db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.id, input.meetingId),
            eq(meetings.userId, ctx.auth.user.id),
          ),
        );

      if (!meeting) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, meeting.agentId));

      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }

      // POST /v1/realtime/client_secrets — the GA WebRTC ephemeral-token endpoint.
      // (/v1/realtime/sessions was removed and now returns 404 "Invalid URL".)
      // Payload must nest the config inside a "session" object.
      const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: "gpt-realtime",
            output_modalities: ["audio"],
            instructions: agent.instructions,
          },
        }),
      });

      // Always read as text first so we can log the raw body for debugging.
      const rawBody = await response.text();
      console.log(
        `[createRealtimeSession] status=${response.status} body=${rawBody.slice(0, 600)}`,
      );

      if (!response.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `OpenAI token request failed (${response.status}): ${rawBody.slice(0, 200)}`,
        });
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "OpenAI returned non-JSON response",
        });
      }

      // Extract the ephemeral token. The GA /client_secrets endpoint returns the
      // token at the TOP LEVEL as `value`. We also fall back to the older
      // `client_secret.value` / string shapes for resilience across versions.
      const secretObj = parsed.client_secret as { value?: string } | string | undefined;
      const ephemeralToken =
        (typeof parsed.value === "string" ? parsed.value : undefined) ??
        (typeof secretObj === "object" && secretObj !== null ? secretObj.value : undefined) ??
        (typeof secretObj === "string" ? secretObj : undefined);

      if (!ephemeralToken) {
        console.error(
          "[createRealtimeSession] Unexpected response shape — full body:",
          rawBody.slice(0, 600),
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "client_secret missing from OpenAI response",
        });
      }

      return { client_secret: ephemeralToken };
    }),
  /**
   * Persists the two-sided transcript captured client-side from the OpenAI
   * Realtime data channel. Because Stream's own transcription is disabled for
   * agent meetings, this is the authoritative transcript for the meeting.
   *
   * The items are serialized into the same JSONL shape Stream produces
   * (StreamTranscriptItem) and stored as a `data:` URL in `transcriptUrl`, so
   * the existing getTranscript query, transcript UI, and Inngest summary
   * pipeline all work unchanged — the only difference is the source of truth.
   *
   * speaker_id is set to the real user id / agent id so getTranscript and the
   * summarizer resolve the correct display names for each side.
   */
  saveRealtimeTranscript: protectedProcedure
    .input(
      z.object({
        meetingId: z.string(),
        items: z.array(
          z.object({
            role: z.enum(["user", "assistant"]),
            text: z.string(),
            ts: z.number(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [meeting] = await db
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.id, input.meetingId),
            eq(meetings.userId, ctx.auth.user.id),
          ),
        );

      if (!meeting) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
      }

      const streamItems: StreamTranscriptItem[] = input.items
        .filter((item) => item.text.trim() !== "")
        .map((item) => ({
          speaker_id: item.role === "user" ? ctx.auth.user.id : meeting.agentId,
          type: "speech",
          text: item.text,
          start_ts: item.ts,
          stop_ts: item.ts,
        }));

      // Encode as a data: URL so the existing transcriptUrl-based pipeline can
      // fetch it verbatim (Node/undici fetch supports the data: scheme).
      const jsonl = JSONL.stringify(streamItems);
      const dataUrl = `data:application/jsonl;base64,${Buffer.from(jsonl, "utf8").toString("base64")}`;

      await db
        .update(meetings)
        .set({ transcriptUrl: dataUrl })
        .where(eq(meetings.id, input.meetingId));

      // If the call already ended (status === "processing"), the webhook's
      // active→processing transition has already fired without a transcript to
      // summarize. Kick off summarization now. The shared Inngest event id
      // (`mp-<meetingId>`) dedupes against the webhook trigger so the summary
      // runs exactly once regardless of ordering.
      if (meeting.status === "processing") {
        try {
          await inngest.send({
            id: `mp-${input.meetingId}`,
            name: "meetings/processing",
            data: { meetingId: input.meetingId, transcriptUrl: dataUrl },
          });
        } catch (err) {
          console.error(
            `[saveRealtimeTranscript] Failed to trigger summary for ${input.meetingId}:`,
            err,
          );
        }
      }

      return { ok: true, count: streamItems.length };
    }),
  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [removedMeeting] = await db
        .delete(meetings)
        .where(
          and(
            eq(meetings.id, input.id),
            eq(meetings.userId, ctx.auth.user.id),
          )
        )
        .returning();

      if (!removedMeeting) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Meeting not found",
        });
      }

      return removedMeeting;
    }),
  update: protectedProcedure
    .input(meetingsUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      const [updatedMeeting] = await db
        .update(meetings)
        .set(input)
        .where(
          and(
            eq(meetings.id, input.id),
            eq(meetings.userId, ctx.auth.user.id),
          )
        )
        .returning();

      if (!updatedMeeting) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Meeting not found",
        });
      }

      return updatedMeeting;
    }),
  create: premiumProcedure("meetings")
    .input(meetingsInsertSchema)
    .mutation(async ({ input, ctx }) => {
      const [createdMeeting] = await db
        .insert(meetings)
        .values({
          ...input,
          userId: ctx.auth.user.id,
        })
        .returning();

      try {
        const call = streamVideo.video.call("default", createdMeeting.id);
        await call.create({
          data: {
            created_by_id: ctx.auth.user.id,
            custom: {
              meetingId: createdMeeting.id,
              meetingName: createdMeeting.name,
            },
            settings_override: {
              // Stream's built-in transcription only "hears" audio published
              // into the call. The AI agent talks over a direct browser→OpenAI
              // WebRTC link, so Stream would transcribe the human only and
              // produce a one-sided transcript/summary. We disable it and use
              // OpenAI Realtime's own two-sided transcript instead (captured
              // client-side and saved via saveRealtimeTranscript). Recording
              // stays on — the agent's voice is mixed into the published mic
              // track in use-openai-voice.ts so it is captured in the recording.
              transcription: {
                language: "en",
                mode: "disabled",
                closed_caption_mode: "disabled",
              },
              recording: {
                mode: "auto-on",
                quality: "1080p",
              },
              // Plan cap: every tier auto-ends a meeting at 1 hour. Enforced
              // server-side by Stream so it can't be bypassed by a page refresh;
              // the client also runs a graceful auto-leave timer (call-active).
              limits: {
                max_duration_seconds: MAX_MEETING_DURATION_SECONDS,
              },
            },
          },
        });
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create video call. Please try again.",
          cause: err,
        });
      }

      const [existingAgent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, createdMeeting.agentId));

      if (!existingAgent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent not found",
        });
      }

      try {
        await streamVideo.upsertUsers([
          {
            id: existingAgent.id,
            name: existingAgent.name,
            role: "user",
            image: generateAvatarUri({
              seed: existingAgent.name,
              variant: "botttsNeutral",
            }),
          },
        ]);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to set up agent for the call. Please try again.",
          cause: err,
        });
      }

      return createdMeeting;
    }),
  getOne: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
    const [existingMeeting] = await db
      .select({
        ...getTableColumns(meetings),
        agent: agents,
        duration: sql<number>`EXTRACT(EPOCH FROM (ended_at - started_at))`.as("duration"),
      })
      .from(meetings)
      .innerJoin(agents, eq(meetings.agentId, agents.id))
      .where(
        and(
          eq(meetings.id, input.id),
          eq(meetings.userId, ctx.auth.user.id),
        )
      );

    if (!existingMeeting) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }

    return existingMeeting;
  }),
  getMany: protectedProcedure
    .input(
      z.object({
        page: z.number().default(DEFAULT_PAGE),
        pageSize: z
          .number()
          .min(MIN_PAGE_SIZE)
          .max(MAX_PAGE_SIZE)
          .default(DEFAULT_PAGE_SIZE),
        search: z.string().nullish(),
        agentId: z.string().nullish(),
        status: z
          .enum([
            MeetingStatus.Upcoming,
            MeetingStatus.Active,
            MeetingStatus.Completed,
            MeetingStatus.Processing,
            MeetingStatus.Cancelled,
          ])
          .nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { search, page, pageSize, status, agentId } = input;

      const data = await db
        .select({
          ...getTableColumns(meetings),
          agent: agents,
          duration: sql<number>`EXTRACT(EPOCH FROM (ended_at - started_at))`.as("duration"),
        })
        .from(meetings)
        .innerJoin(agents, eq(meetings.agentId, agents.id))
        .where(
          and(
            eq(meetings.userId, ctx.auth.user.id),
            search ? ilike(meetings.name, `%${search}%`) : undefined,
            status ? eq(meetings.status, status) : undefined,
            agentId ? eq(meetings.agentId, agentId) : undefined,
          )
        )
        .orderBy(desc(meetings.createdAt), desc(meetings.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize)

      const [total] = await db
        .select({ count: count() })
        .from(meetings)
        .innerJoin(agents, eq(meetings.agentId, agents.id))
        .where(
          and(
            eq(meetings.userId, ctx.auth.user.id),
            search ? ilike(meetings.name, `%${search}%`) : undefined,
            status ? eq(meetings.status, status) : undefined,
            agentId ? eq(meetings.agentId, agentId) : undefined,
          )
        );

      const totalPages = Math.ceil(total.count / pageSize);

      return {
        items: data,
        total: total.count,
        totalPages,
      };
    }),
});