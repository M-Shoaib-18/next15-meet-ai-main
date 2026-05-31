import { useState } from "react";
import { StreamTheme, useCall } from "@stream-io/video-react-sdk";

import { CallLobby } from "./call-lobby";
import { CallActive } from "./call-active";
import { CallEnded } from "./call-ended";

interface Props {
  meetingId: string;
  meetingName: string;
  agentId: string;
  agentName: string;
};

export const CallUI = ({ meetingId, meetingName, agentId, agentName }: Props) => {
  const call = useCall();
  const [show, setShow] = useState<"lobby" | "call" | "ended">("lobby");

  const handleJoin = async () => {
    if (!call) return;

    await call.join();

    setShow("call");
  };

  const handleLeave = () => {
    // CallControls has already called call.leave() before firing onLeave.
    // Calling endCall() here would fail (403) for non-host participants.
    setShow("ended");
  };

  return (
    <StreamTheme className="h-full">
      {show === "lobby" && <CallLobby onJoin={handleJoin} />}
      {show === "call" && <CallActive onLeave={handleLeave} meetingId={meetingId} meetingName={meetingName} agentId={agentId} agentName={agentName} />}
      {show === "ended" && <CallEnded />}
    </StreamTheme>
  )
};
