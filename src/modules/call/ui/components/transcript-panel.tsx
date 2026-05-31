"use client";

import { useEffect, useRef } from "react";
import { XIcon } from "lucide-react";

import type { CaptionLine } from "../hooks/use-openai-voice";
import type { CaptionTranslator } from "../hooks/use-caption-translations";

interface Props {
  captions: CaptionLine[];
  translator: CaptionTranslator;
  agentName: string;
  onClose: () => void;
}

export const TranscriptPanel = ({
  captions,
  translator,
  agentName,
  onClose,
}: Props) => {
  const { enabled, request, get } = translator;

  // Ensure every finalized line gets translated while the panel is open. Cached
  // and de-duped in the shared translator, so this never re-translates a line.
  useEffect(() => {
    if (!enabled) return;
    for (const line of captions) request(line);
  }, [captions, enabled, request]);

  // Auto-stick to the bottom as new lines arrive, but only if the user hasn't
  // scrolled up to read history.
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    const el = viewportRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [captions]);

  const lines = captions.filter((l) => l.text.trim());

  return (
    <div className="flex w-80 shrink-0 flex-col rounded-2xl bg-[#1e2023] ring-1 ring-white/10">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h5 className="text-sm font-semibold text-white">Transcript</h5>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close transcript"
          className="rounded-md p-1 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      <div
        ref={viewportRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="flex flex-col gap-3 p-4">
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The conversation transcript will appear here.
            </p>
          ) : (
            lines.map((line) => {
              const isAgent = line.role === "assistant";
              const speaker = isAgent ? agentName : "You";
              const translated = get(line);

              return (
                <div key={line.id} className="flex flex-col gap-0.5">
                  <span
                    className={`text-xs font-semibold uppercase tracking-wide ${
                      isAgent ? "text-blue-300" : "text-emerald-300"
                    }`}
                  >
                    {speaker}
                  </span>
                  <p className="text-sm leading-snug text-white break-words">
                    {line.text}
                  </p>
                  {enabled && line.final && (
                    <p className="text-sm italic leading-snug text-blue-100/80 break-words">
                      {translated ?? "…"}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
