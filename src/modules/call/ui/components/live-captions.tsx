"use client";

import { useEffect, useState } from "react";

import type { CaptionLine } from "../hooks/use-openai-voice";

interface Props {
  captions: CaptionLine[];
  agentName: string;
}

// How long a speaker's caption stays on screen after their LAST activity before
// it auto-hides. While a speaker keeps talking (new deltas/finals arrive) the
// timer resets, so it only disappears once they've been silent this long.
const CAPTION_TTL_MS = 10_000;

export const LiveCaptions = ({ captions, agentName }: Props) => {
  // Show BOTH speakers at once: the agent's current line bottom-LEFT and the
  // user's current line bottom-RIGHT, side by side. We pick the most recent
  // line per speaker (the streaming one while they talk, otherwise their last
  // utterance), so each side updates in real time and neither hides the other.
  const latestAgent = [...captions]
    .reverse()
    .find((l) => l.role === "assistant" && l.text.trim());
  const latestUser = [...captions]
    .reverse()
    .find((l) => l.role === "user" && l.text.trim());

  // Per-speaker auto-hide. `updatedAt` bumps on every delta/finalize, so keying
  // the timer on it resets the countdown whenever that speaker is active and
  // expires CAPTION_TTL_MS after they go quiet — e.g. the user's caption clears
  // ~10s after they stop talking, even while the agent keeps answering.
  const [agentVisible, setAgentVisible] = useState(false);
  const [userVisible, setUserVisible] = useState(false);

  const agentKey = latestAgent ? `${latestAgent.id}:${latestAgent.updatedAt}` : null;
  const userKey = latestUser ? `${latestUser.id}:${latestUser.updatedAt}` : null;

  useEffect(() => {
    if (!agentKey) {
      setAgentVisible(false);
      return;
    }
    setAgentVisible(true);
    const t = setTimeout(() => setAgentVisible(false), CAPTION_TTL_MS);
    return () => clearTimeout(t);
  }, [agentKey]);

  useEffect(() => {
    if (!userKey) {
      setUserVisible(false);
      return;
    }
    setUserVisible(true);
    const t = setTimeout(() => setUserVisible(false), CAPTION_TTL_MS);
    return () => clearTimeout(t);
  }, [userKey]);

  const showAgent = !!latestAgent && agentVisible;
  const showUser = !!latestUser && userVisible;

  if (!showAgent && !showUser) return null;

  return (
    <>
      {showAgent && (
        <CaptionBubble
          side="left"
          speaker={agentName}
          speakerClass="text-blue-300"
          line={latestAgent}
        />
      )}
      {showUser && (
        <CaptionBubble
          side="right"
          speaker="You"
          speakerClass="text-emerald-300"
          line={latestUser}
        />
      )}
    </>
  );
};

interface BubbleProps {
  side: "left" | "right";
  speaker: string;
  speakerClass: string;
  line: CaptionLine;
}

const CaptionBubble = ({ side, speaker, speakerClass, line }: BubbleProps) => {
  const isLeft = side === "left";

  return (
    <div
      className={`pointer-events-none absolute bottom-4 z-10 w-[min(44%,520px)] ${
        isLeft ? "left-4" : "right-4"
      }`}
    >
      <div className="flex flex-col gap-1 rounded-xl bg-black/70 px-4 py-2 backdrop-blur-sm">
        <span
          className={`text-xs font-semibold uppercase tracking-wide ${speakerClass} ${
            isLeft ? "text-left" : "text-right"
          }`}
        >
          {speaker}
        </span>

        {/*
          Each caption is clipped to a 2-line window pinned to the BOTTOM:
          `max-h-14` (2 × leading-7) + `overflow-hidden` + `justify-end` means a
          long sentence overflows and is clipped at the TOP, so only the latest
          ~2 lines stay visible — exactly like YouTube captions, at any width.
        */}
        <div className="flex max-h-14 flex-col justify-end overflow-hidden">
          <p
            className={`text-base leading-7 break-words text-white ${
              isLeft ? "text-left" : "text-right"
            }`}
          >
            {line.text}
          </p>
        </div>
      </div>
    </div>
  );
};
