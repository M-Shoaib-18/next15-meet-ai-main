"use client";

import { useEffect } from "react";

import type { CaptionLine } from "../hooks/use-openai-voice";
import type { CaptionTranslator } from "../hooks/use-caption-translations";

interface Props {
  captions: CaptionLine[];
  translator: CaptionTranslator;
  agentName: string;
}

export const LiveCaptions = ({ captions, translator, agentName }: Props) => {
  const { enabled, request, get } = translator;

  // YouTube-style: show only the CURRENT speaker. We pick the line that is being
  // spoken RIGHT NOW by the highest `updatedAt` (activity clock), preferring a
  // still-streaming line over finalized ones. Relying on array position instead
  // would get stuck on a stale line when the user's and agent's transcripts
  // interleave or finalize out of order, so the overlay would freeze on one
  // speaker. With this, it switches live between the user and the agent.
  const withText = captions.filter((l) => l.text.trim());
  const streaming = withText.filter((l) => !l.final);
  const pool = streaming.length > 0 ? streaming : withText;
  const active = pool.reduce<CaptionLine | undefined>(
    (best, l) => (!best || l.updatedAt > best.updatedAt ? l : best),
    undefined,
  );

  // Translate the active line once it is finalized (request is cached/de-duped).
  useEffect(() => {
    if (active) request(active);
  }, [active, request]);

  if (!active) return null;

  const translated = get(active);
  const speaker = active.role === "assistant" ? agentName : "You";
  const speakerClass =
    active.role === "assistant" ? "text-blue-300" : "text-emerald-300";

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 w-[min(90%,720px)] -translate-x-1/2">
      <div className="flex flex-col gap-1 rounded-xl bg-black/70 px-4 py-2 backdrop-blur-sm">
        <span
          className={`text-center text-xs font-semibold uppercase tracking-wide ${speakerClass}`}
        >
          {speaker}
        </span>

        {/*
          Each caption is clipped to a 2-line window pinned to the BOTTOM:
          `max-h-14` (2 × leading-7) + `overflow-hidden` + `justify-end` means a
          long sentence overflows and is clipped at the TOP, so only the latest
          ~2 lines stay visible. As more words stream/arrive, older lines roll
          up out of view — exactly like YouTube captions, at any screen width.
        */}
        <div className="flex max-h-14 flex-col justify-end overflow-hidden">
          <p className="text-center text-base leading-7 break-words text-white">
            {active.text}
          </p>
        </div>

        {enabled && (
          <div className="flex max-h-14 flex-col justify-end overflow-hidden">
            <p className="text-center text-base italic leading-7 break-words text-blue-100/90">
              {translated ?? "…"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
