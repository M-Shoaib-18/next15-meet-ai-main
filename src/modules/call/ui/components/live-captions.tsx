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

  // YouTube-style: show only the CURRENT speaker — the most recent line with
  // text. When the user stops and the agent starts replying, a new line becomes
  // active and the previous one disappears automatically.
  const active = [...captions].reverse().find((l) => l.text.trim());

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
