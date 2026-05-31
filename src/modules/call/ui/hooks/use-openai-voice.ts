"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useCall } from "@stream-io/video-react-sdk";
import { useTRPC } from "@/trpc/client";

export interface UseOpenAIVoiceResult {
  isSpeaking: boolean;
  isConnected: boolean;
  error: string | null;
}

// OpenAI Realtime WebRTC endpoints
// GA restructured the SDP exchange path: /v1/realtime → /v1/realtime/calls
const OPENAI_REALTIME_SDP_URL = "https://api.openai.com/v1/realtime/calls";
const OPENAI_REALTIME_MODEL  = "gpt-realtime";

// RMS threshold (0–255) above which the remote track is considered "speaking"
const SPEAKING_THRESHOLD = 8;

// Debounce for persisting the running transcript to the server (ms).
const TRANSCRIPT_SAVE_DEBOUNCE = 1500;

type TranscriptItem = { role: "user" | "assistant"; text: string; ts: number };

export function useOpenAIVoice(meetingId: string): UseOpenAIVoiceResult {
  const trpc = useTRPC();
  const { mutateAsync: createRealtimeSession } = useMutation(
    trpc.meetings.createRealtimeSession.mutationOptions(),
  );
  const { mutateAsync: saveRealtimeTranscript } = useMutation(
    trpc.meetings.saveRealtimeTranscript.mutationOptions(),
  );

  // The Stream Call instance for this meeting. Available because this hook is
  // rendered inside <StreamCall> (CallActive uses useCallStateHooks). We read
  // it through a ref so the connection effect doesn't depend on its identity.
  const call = useCall();
  const callRef = useRef(call);
  callRef.current = call;

  // Keep the latest save mutation in a ref so the [meetingId]-scoped effect can
  // call it without being re-created when React Query returns a new function.
  const saveTranscriptRef = useRef(saveRealtimeTranscript);
  saveTranscriptRef.current = saveRealtimeTranscript;

  const [isSpeaking,  setIsSpeaking]  = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const pcRef          = useRef<RTCPeerConnection | null>(null);
  const audioElRef     = useRef<HTMLAudioElement   | null>(null);
  const audioCtxRef    = useRef<AudioContext        | null>(null);
  const animFrameRef   = useRef<number>(0);
  const micStreamRef   = useRef<MediaStream | null>(null);

  // ---- Transcript capture (OpenAI Realtime data channel) ---- //
  const dcRef          = useRef<RTCDataChannel | null>(null);
  const transcriptRef  = useRef<TranscriptItem[]>([]);
  const saveTimerRef   = useRef<number | null>(null);

  // ---- Recording mix (agent voice → published mic track) ---- //
  const mixCtxRef      = useRef<AudioContext | null>(null);
  const mixDestRef     = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micFilterUnregRef = useRef<(() => Promise<void>) | null>(null);

  const cleanup = useCallback(() => {
    // Stop the animation frame loop
    cancelAnimationFrame(animFrameRef.current);

    // Flush any pending transcript-save timer
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    // Best-effort final transcript save (fire-and-forget; the page may be
    // navigating away, but incremental saves during the call already persisted
    // the bulk of the transcript).
    if (transcriptRef.current.length > 0) {
      saveTranscriptRef.current({
        meetingId,
        items: [...transcriptRef.current],
      }).catch(() => {});
    }

    // Unregister the microphone mix filter so Stream reverts to the raw mic.
    if (micFilterUnregRef.current) {
      micFilterUnregRef.current().catch(() => {});
      micFilterUnregRef.current = null;
    }

    // Close the mixing AudioContext
    if (mixCtxRef.current) {
      mixCtxRef.current.close().catch(() => {});
      mixCtxRef.current = null;
    }
    mixDestRef.current = null;

    // Close the data channel
    if (dcRef.current) {
      try { dcRef.current.close(); } catch { /* already closed */ }
      dcRef.current = null;
    }

    // Close the analyser AudioContext
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    // Detach and remove the hidden audio element from the DOM
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }

    // Stop all microphone tracks
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }

    // Close the peer connection
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
  }, [meetingId]);

  useEffect(() => {
    if (!meetingId) return;

    let cancelled = false;

    // Debounced persistence of the running transcript. Saving incrementally
    // (rather than only on unmount) makes the transcript reliable even if the
    // tab is closed abruptly when the user leaves the call.
    function scheduleTranscriptSave() {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        if (cancelled || transcriptRef.current.length === 0) return;
        saveTranscriptRef.current({
          meetingId,
          items: [...transcriptRef.current],
        }).catch(() => {});
      }, TRANSCRIPT_SAVE_DEBOUNCE);
    }

    async function start() {
      try {
        // ------------------------------------------------------------------ //
        // Step 1: Get an ephemeral OpenAI Realtime token from our server.     //
        // The API key never reaches the browser — only the short-lived token. //
        // ------------------------------------------------------------------ //
        const { client_secret } = await createRealtimeSession({ meetingId });
        if (cancelled) return;

        // ------------------------------------------------------------------ //
        // Step 2: Create the RTCPeerConnection.                               //
        // ------------------------------------------------------------------ //
        const pc = new RTCPeerConnection();
        pcRef.current = pc;

        // ------------------------------------------------------------------ //
        // Step 2b: Open the OpenAI Realtime event data channel.              //
        //                                                                     //
        // Created BEFORE the offer so its m=application section is included   //
        // in the SDP. We use it to (a) enable input-audio transcription and   //
        // (b) receive the two-sided transcript (user + agent) so the meeting  //
        // transcript and summary include the agent's replies, not just the    //
        // user's questions.                                                   //
        // ------------------------------------------------------------------ //
        const dc = pc.createDataChannel("oai-events");
        dcRef.current = dc;

        dc.onopen = () => {
          // Ask OpenAI to transcribe the user's spoken input too. The agent's
          // own output transcript is emitted automatically for audio output.
          try {
            dc.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  type: "realtime",
                  audio: {
                    input: { transcription: { model: "whisper-1" } },
                  },
                },
              }),
            );
          } catch {
            // Non-fatal: if this fails we still capture the agent transcript.
          }
        };

        dc.onmessage = (e) => {
          let msg: { type?: string; transcript?: string };
          try {
            msg = JSON.parse(e.data);
          } catch {
            return;
          }

          let role: "user" | "assistant" | null = null;
          if (msg.type === "conversation.item.input_audio_transcription.completed") {
            role = "user";
          } else if (
            msg.type === "response.output_audio_transcript.done" ||
            msg.type === "response.audio_transcript.done"
          ) {
            role = "assistant";
          }

          if (role && typeof msg.transcript === "string" && msg.transcript.trim()) {
            transcriptRef.current.push({
              role,
              text: msg.transcript.trim(),
              ts: Date.now(),
            });
            scheduleTranscriptSave();
          }
        };

        // ------------------------------------------------------------------ //
        // Step 2c: Prepare the recording mix.                                //
        //                                                                     //
        // Stream only records audio published into the call. The agent talks  //
        // over this direct browser↔OpenAI link, so without mixing it would be  //
        // absent from the recording. We build a MediaStreamDestination that    //
        // combines the user's mic with the agent's audio and publish THAT as   //
        // the mic track via a Stream microphone filter.                        //
        // ------------------------------------------------------------------ //
        const mixCtx = new AudioContext();
        mixCtxRef.current = mixCtx;
        if (mixCtx.state === "suspended") {
          mixCtx.resume().catch(() => {});
        }
        const mixDest = mixCtx.createMediaStreamDestination();
        mixDestRef.current = mixDest;

        const callObj = callRef.current;
        if (callObj) {
          try {
            const registration = callObj.microphone.registerFilter(
              (input: MediaStream) => {
                const micSource = mixCtx.createMediaStreamSource(input);
                micSource.connect(mixDest);
                return {
                  output: mixDest.stream,
                  stop: () => {
                    try { micSource.disconnect(); } catch { /* noop */ }
                  },
                };
              },
            );
            micFilterUnregRef.current = registration.unregister;
          } catch (e) {
            console.warn("[useOpenAIVoice] mic mix filter registration failed:", e);
          }
        }

        // ------------------------------------------------------------------ //
        // Step 3: Wire up the remote audio track from OpenAI.                //
        //                                                                     //
        // We create a real <audio> element appended to document.body so the  //
        // browser's autoplay policy is satisfied (the element is in the DOM). //
        // It is hidden via inline style and cleaned up on unmount.            //
        // ------------------------------------------------------------------ //
        pc.ontrack = (event) => {
          if (cancelled) return;

          const remoteStream = event.streams[0];

          // Create a hidden <audio> element in the live DOM tree.
          const audioEl = document.createElement("audio");
          audioEl.autoplay   = true;
          audioEl.style.display = "none";
          audioEl.srcObject  = remoteStream;
          document.body.appendChild(audioEl);
          audioElRef.current = audioEl;

          // Resume the AudioContext in case it started suspended (Chrome policy).
          audioEl.play().catch(() => {
            // play() can throw if the context is suspended; resume then retry.
            audioEl.play().catch(() => {});
          });

          // ---- Mix the agent's voice into the published/recorded mic ---- //
          if (mixDestRef.current && mixCtxRef.current) {
            try {
              const agentSource =
                mixCtxRef.current.createMediaStreamSource(remoteStream);
              agentSource.connect(mixDestRef.current);
            } catch (e) {
              console.warn("[useOpenAIVoice] failed to mix agent audio:", e);
            }
          }

          // ---- Speaking detection via AnalyserNode ---- //
          const audioCtx = new AudioContext();
          audioCtxRef.current = audioCtx;

          // Ensure the AudioContext is running (it can start in "suspended" state).
          if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
          }

          const source   = audioCtx.createMediaStreamSource(remoteStream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);

          const freqData = new Uint8Array(analyser.frequencyBinCount);

          function tick() {
            if (cancelled) return;
            analyser.getByteFrequencyData(freqData);
            const rms = freqData.reduce((sum, v) => sum + v, 0) / freqData.length;
            setIsSpeaking(rms > SPEAKING_THRESHOLD);
            animFrameRef.current = requestAnimationFrame(tick);
          }
          tick();
        };

        // ------------------------------------------------------------------ //
        // Step 4: Capture the user's microphone and add it to the PC.        //
        // ------------------------------------------------------------------ //
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          micStream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = micStream;
        micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));

        // ------------------------------------------------------------------ //
        // Step 5: SDP offer → OpenAI → SDP answer.                          //
        // ------------------------------------------------------------------ //
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const sdpRes = await fetch(
          `${OPENAI_REALTIME_SDP_URL}?model=${OPENAI_REALTIME_MODEL}`,
          {
            method: "POST",
            body: offer.sdp,
            headers: {
              Authorization:  `Bearer ${client_secret}`,
              "Content-Type": "application/sdp",
            },
          },
        );

        if (!sdpRes.ok) {
          const body = await sdpRes.text().catch(() => "");
          throw new Error(`OpenAI WebRTC SDP exchange failed (${sdpRes.status}): ${body}`);
        }

        const answerSdp = await sdpRes.text();
        if (cancelled) return;

        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

        if (!cancelled) {
          setIsConnected(true);
          console.log("[useOpenAIVoice] Connected to OpenAI Realtime via WebRTC ✓");
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[useOpenAIVoice] Connection failed:", msg);
          setError(msg);
        }
      }
    }

    start();

    return () => {
      cancelled = true;
      cleanup();
      setIsConnected(false);
      setIsSpeaking(false);
    };
  // createRealtimeSession is a stable React Query mutation reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  return { isSpeaking, isConnected, error };
}
