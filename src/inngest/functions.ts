import { eq, inArray } from "drizzle-orm";
import JSONL from "jsonl-parse-stringify";
import OpenAI from "openai";

import { db } from "@/db";
import { env } from "@/lib/env";
import { agents, meetings, user } from "@/db/schema";
import { inngest } from "@/inngest/client";

import { StreamTranscriptItem } from "@/modules/meetings/types";

export const meetingsProcessing = inngest.createFunction(
  { id: "meetings/processing" },
  { event: "meetings/processing" },
  async ({ event, step }) => {
    const openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const response = await step.run("fetch-transcript", async () => {
      const res = await fetch(event.data.transcriptUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch transcript: ${res.status} ${res.statusText}`);
      }
      return res.text();
    });

    const transcript = await step.run("parse-transcript", async () => {
      return JSONL.parse<StreamTranscriptItem>(response);
    });

    const transcriptWithSpeakers = await step.run("add-speakers", async () => {
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
          }))
        );

      const agentSpeakers = await db
        .select()
        .from(agents)
        .where(inArray(agents.id, speakerIds))
        .then((agents) =>
          agents.map((agent) => ({
            ...agent,
          }))
        );

      const speakers = [...userSpeakers, ...agentSpeakers];

      return transcript.map((item) => {
        const speaker = speakers.find(
          (speaker) => speaker.id === item.speaker_id
        );

        if (!speaker) {
          return {
            ...item,
            user: {
              name: "Unknown",
            },
          };
        }

        return {
          ...item,
          user: {
            name: speaker.name,
          },
        };
      });
    });

    const summary = await step.run("summarize-transcript", async () => {
      const response = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert summarizer. You write readable, concise, simple content. You are given a transcript of a meeting and you need to summarize it.

Use the following markdown structure for every output:

### Overview
Provide a detailed, engaging summary of the session's content. Focus on major features, user workflows, and any key takeaways. Write in a narrative style, using full sentences. Highlight unique or powerful aspects of the product, platform, or discussion.

### Notes
Break down key content into thematic sections with timestamp ranges. Each section should summarize key points, actions, or demos in bullet format.

Example:
#### Section Name
- Main point or demo shown here
- Another key insight or interaction
- Follow-up tool or explanation provided

#### Next Section
- Feature X automatically does Y
- Mention of integration with Z`,
          },
          {
            role: "user",
            content: `Summarize the following transcript: ${JSON.stringify(transcriptWithSpeakers)}`,
          },
        ],
      });
      return response.choices[0]?.message.content || "";
    });

    await step.run("save-summary", async () => {
      await db
        .update(meetings)
        .set({
          summary: summary,
          status: "completed",
        })
        .where(eq(meetings.id, event.data.meetingId));
    });
  },
);
