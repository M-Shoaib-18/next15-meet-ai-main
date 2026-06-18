"use client";

import { useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useQuery } from "@tanstack/react-query";
import {
  CallControls,
  CallingState,
  ParticipantView,
  useCall,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";

import { useTRPC } from "@/trpc/client";
import { generateAvatarUri } from "@/lib/avatar";
import { MAX_MEETING_DURATION_SECONDS } from "@/modules/premium/entitlements";
import { useOpenAIVoice } from "../hooks/use-openai-voice";
import { LiveCaptions } from "./live-captions";

interface Props {
  onLeave: () => void;
  meetingId: string;
  meetingName: string;
  agentId: string;
  agentName: string;
}

export const CallActive = ({ onLeave, meetingId, meetingName, agentId, agentName }: Props) => {
  const call = useCall();
  const { useParticipants } = useCallStateHooks();
  const participants = useParticipants();

  // Plan entitlements. Live captions are a Pro+ feature; Basic users (and anyone
  // whose entitlement hasn't loaded yet) get no on-screen captions.
  const trpc = useTRPC();
  const { data: entitlement } = useQuery(trpc.premium.getEntitlement.queryOptions());
  const captionsEnabled = entitlement?.captionsEnabled ?? false;

  // Every plan caps a meeting at 1 hour. When the cap is reached we leave the
  // call gracefully (same path as clicking "leave") so the user sees the
  // "Meeting ended" screen and the transcript is persisted. Stream also enforces
  // this server-side via max_duration_seconds, so a refresh can't bypass it.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (call && call.state.callingState !== CallingState.LEFT) {
        call.leave().catch(() => {});
      }
      onLeave();
    }, MAX_MEETING_DURATION_SECONDS * 1000);

    return () => clearTimeout(timer);
  }, [call, onLeave]);

  // Agent is no longer a Stream WebRTC participant — voice is handled via a
  // direct browser→OpenAI WebRTC connection (Stream's connect_agent proxy is
  // broken since OpenAI removed the OpenAI-Beta header in May 2026).
  const { isSpeaking, isConnected, captions } = useOpenAIVoice(meetingId);

  // Only show human participants in the video grid (agent has no video track).
  const humanParticipants = participants.filter((p) => p.userId !== agentId);

  const agentImage = generateAvatarUri({ seed: agentName, variant: "botttsNeutral" });

  return (
    <div className="flex flex-col justify-between p-4 h-full text-white">
      <div className="bg-[#101213] rounded-full p-4 flex items-center gap-4">
        <Link
          href="/"
          className="flex items-center justify-center p-1 bg-white/10 rounded-full w-fit"
        >
          <Image src="/logo.svg" width={22} height={22} alt="Logo" priority />
        </Link>
        <h4 className="text-base">{meetingName}</h4>
      </div>

      <div className="flex flex-1 gap-4 my-4 min-h-0">
        {/* Video area (holds the live-caption overlay) */}
        <div className="relative flex flex-1 gap-4 min-h-0">
        {/* Agent slot */}
        <div
          className={`flex flex-col items-center justify-center rounded-2xl bg-[#1e2023] flex-1 transition-all duration-300 ${
            isSpeaking ? "ring-2 ring-blue-400" : "ring-1 ring-white/10"
          }`}
        >
          <div className="relative">
            <Image
              src={agentImage}
              alt={agentName}
              width={96}
              height={96}
              className="rounded-full"
            />
            {isSpeaking && (
              <span className="absolute inset-0 rounded-full animate-ping bg-blue-400 opacity-25 pointer-events-none" />
            )}
          </div>
          <p className="mt-3 text-base font-semibold">{agentName}</p>
          <p
            className={`text-xs mt-1 ${
              isConnected
                ? isSpeaking
                  ? "text-blue-400"
                  : "text-green-400"
                : "text-muted-foreground"
            }`}
          >
            {isConnected
              ? isSpeaking
                ? "Speaking…"
                : "Connected"
              : "Joining…"}
          </p>
        </div>

        {/* Human participants */}
        <div className="flex flex-1 gap-2 min-h-0">
          {humanParticipants.length > 0 ? (
            humanParticipants.map((p) => (
              <ParticipantView
                key={p.sessionId}
                participant={p}
                className="flex-1 rounded-2xl overflow-hidden"
              />
            ))
          ) : (
            <div className="flex-1 flex items-center justify-center rounded-2xl bg-[#1e2023] ring-1 ring-white/10">
              <p className="text-sm text-muted-foreground">Connecting…</p>
            </div>
          )}
        </div>

        {/* Live captions overlay (bottom, Netflix-style) — Pro+ only */}
        {captionsEnabled && (
          <LiveCaptions captions={captions} agentName={agentName} />
        )}
        </div>
      </div>

      <div className="bg-[#101213] rounded-full px-4 flex items-center justify-center gap-2 py-2">
        <CallControls onLeave={onLeave} />
      </div>
    </div>
  );
};
