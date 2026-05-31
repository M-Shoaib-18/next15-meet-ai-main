"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useCall } from "@stream-io/video-react-sdk";
import { useTRPC } from "@/trpc/client";

// A single live-caption line. While the speaker is mid-utterance `final` is
// false and `text` grows from streaming deltas; once the utterance ends it is
// replaced with the authoritative transcript and `final` flips to true.
export interface CaptionLine {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export interface UseOpenAIVoiceResult {
  isSpeaking: boolean;
  isConnected: boolean;
  error: string | null;
  // Full running conversation (user + agent), in order. The overlay renders
  // only the active speaker; the transcript side panel renders the whole list.
  captions: CaptionLine[];
}

// OpenAI Realtime WebRTC endpoints
// GA restructured the SDP exchange path: /v1/realtime → /v1/realtime/calls
const OPENAI_REALTIME_SDP_URL = "https://api.openai.com/v1/realtime/calls";
const OPENAI_REALTIME_MODEL  = "gpt-realtime";

// RMS threshold (0–255) above which the remote track is considered "speaking"
const SPEAKING_THRESHOLD = 8;

// Debounce for persisting the running transcript to the server (ms).
const TRANSCRIPT_SAVE_DEBOUNCE = 1500;

// Screen-vision: max width (px) and JPEG quality for screenshots sent to the
// agent. Downscaling keeps image-token cost and latency reasonable while
// keeping text/code on screen legible.
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_JPEG_QUALITY = 0.7;

// Tool the agent calls on-demand when the user asks about what's on their
// screen. When invoked, our client captures the currently shared screen and
// attaches it as an image, then asks the model to answer using it. This is
// purely additive — it rides the existing data channel and never affects the
// audio / SDP / token path.
const VIEW_SCREEN_TOOL = {
  type: "function",
  name: "view_screen",
  description:
    "Capture and look at the user's currently shared screen. Call this WHENEVER " +
    "the user asks anything about what is on their screen, a screenshot, an image, " +
    "a diagram, a slide, code, an error message, or any on-screen visual (e.g. " +
    '"what do you see", "what\'s this error", "read my screen", "look at this"). ' +
    "Only the user's shared screen is captured.",
  parameters: { type: "object", properties: {}, required: [] },
} as const;

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
  const [captions,    setCaptions]    = useState<CaptionLine[]>([]);

  // ---- Live caption assembly ---- //
  // We keep the canonical list in a ref (mutated synchronously from the data
  // channel handler) and mirror it into state for rendering. `agentLineIdRef`
  // / `userLineIdRef` track the currently-open (streaming) line per speaker so
  // deltas append to it and the final event replaces it in place.
  const captionsRef    = useRef<CaptionLine[]>([]);
  const agentLineIdRef = useRef<string | null>(null);
  const userLineIdRef  = useRef<string | null>(null);
  const lineSeqRef     = useRef(0);

  // Append a streaming delta or finalize a caption line for a given speaker.
  // Pass `finalText` to close the line (replaces any partial with the
  // authoritative transcript); pass `delta` to extend the open partial line.
  const applyCaption = useCallback(
    (role: "user" | "assistant", delta: string | null, finalText: string | null) => {
      const openIdRef = role === "assistant" ? agentLineIdRef : userLineIdRef;
      let lines = captionsRef.current;

      if (finalText !== null) {
        if (openIdRef.current) {
          lines = lines.map((l) =>
            l.id === openIdRef.current ? { ...l, text: finalText, final: true } : l,
          );
        } else {
          lines = [...lines, { id: `c${++lineSeqRef.current}`, role, text: finalText, final: true }];
        }
        openIdRef.current = null;
      } else if (delta) {
        if (openIdRef.current) {
          lines = lines.map((l) =>
            l.id === openIdRef.current ? { ...l, text: l.text + delta } : l,
          );
        } else {
          const id = `c${++lineSeqRef.current}`;
          openIdRef.current = id;
          lines = [...lines, { id, role, text: delta, final: false }];
        }
      } else {
        return;
      }

      captionsRef.current = lines;
      setCaptions(lines);
    },
    [],
  );

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

  // ---- Screen vision (on-demand "look at my screen" tool) ---- //
  // De-dupes function-call handling so a single tool call captures once.
  const processedToolCallsRef = useRef<Set<string>>(new Set());

  // Grab a single downscaled JPEG frame of the user's currently shared screen
  // (via Stream's screen-share track). Returns a data URL, or null if nothing
  // is being shared. Uses a throwaway off-DOM <video>+<canvas>; no Stream state
  // is mutated, so the live call is unaffected.
  const captureScreenFrame = useCallback(async (): Promise<string | null> => {
    const call = callRef.current;
    const stream =
      call?.screenShare.state.mediaStream ??
      call?.state.localParticipant?.screenShareStream ??
      null;
    if (!stream) return null;

    const track = stream.getVideoTracks()[0];
    if (!track) return null;

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);

    try {
      await video.play().catch(() => {});
      // Wait for the first frame's dimensions if not ready yet.
      if (!video.videoWidth) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 600);
          video.onloadeddata = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }

      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / vw);

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(vw * scale));
      canvas.height = Math.max(1, Math.round(vh * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", SCREENSHOT_JPEG_QUALITY);
    } catch {
      return null;
    } finally {
      video.pause();
      video.srcObject = null;
    }
  }, []);

  // Respond to the agent's `view_screen` tool call: attach a screenshot of the
  // shared screen (or tell the agent nothing is shared) and ask it to answer.
  const handleViewScreen = useCallback(
    async (callId: string) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") return;

      const send = (obj: unknown) => {
        try {
          dc.send(JSON.stringify(obj));
        } catch {
          /* channel closing — ignore */
        }
      };

      const dataUrl = await captureScreenFrame();

      if (!dataUrl) {
        // Nothing shared — satisfy the tool call and let the model ask the user
        // to start sharing their screen.
        send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              status: "no_screen",
              message:
                "No screen is currently being shared. Ask the user to click the " +
                "screen-share button, then try again.",
            }),
          },
        });
        send({ type: "response.create" });
        return;
      }

      // 1) Satisfy the tool call.
      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ status: "ok", message: "Screenshot attached below." }),
        },
      });
      // 2) Attach the screenshot as an image the model can actually see.
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: dataUrl }],
        },
      });
      // 3) Ask the model to answer using the screenshot.
      send({ type: "response.create" });
    },
    [captureScreenFrame],
  );

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
                  // Give the agent an on-demand "look at my screen" tool. Adding
                  // tools here is a partial update; it does NOT touch the agent's
                  // server-set instructions/persona.
                  tools: [VIEW_SCREEN_TOOL],
                  tool_choice: "auto",
                },
              }),
            );
          } catch {
            // Non-fatal: if this fails we still capture the agent transcript.
          }
        };

        dc.onmessage = (e) => {
          let msg: {
            type?: string;
            transcript?: string;
            delta?: string;
            item?: { type?: string; name?: string; call_id?: string };
          };
          try {
            msg = JSON.parse(e.data);
          } catch {
            return;
          }

          switch (msg.type) {
            // ---- Agent tool call: look at the shared screen (on-demand) ---- //
            case "response.output_item.done": {
              const item = msg.item;
              if (
                item?.type === "function_call" &&
                item.name === "view_screen" &&
                item.call_id &&
                !processedToolCallsRef.current.has(item.call_id)
              ) {
                processedToolCallsRef.current.add(item.call_id);
                void handleViewScreen(item.call_id);
              }
              break;
            }

            // ---- Agent (assistant) ---- //
            // Streaming deltas → live caption only (not persisted; the .done
            // event carries the authoritative full transcript we save).
            case "response.output_audio_transcript.delta":
            case "response.audio_transcript.delta":
              applyCaption("assistant", msg.delta ?? "", null);
              break;
            case "response.output_audio_transcript.done":
            case "response.audio_transcript.done": {
              const t = msg.transcript?.trim();
              if (t) {
                transcriptRef.current.push({ role: "assistant", text: t, ts: Date.now() });
                scheduleTranscriptSave();
                applyCaption("assistant", null, t);
              } else {
                // No final text — just close any open streaming line.
                agentLineIdRef.current = null;
              }
              break;
            }

            // ---- User ---- //
            case "conversation.item.input_audio_transcription.delta":
              applyCaption("user", msg.delta ?? "", null);
              break;
            case "conversation.item.input_audio_transcription.completed": {
              const t = msg.transcript?.trim();
              if (t) {
                transcriptRef.current.push({ role: "user", text: t, ts: Date.now() });
                scheduleTranscriptSave();
                applyCaption("user", null, t);
              } else {
                userLineIdRef.current = null;
              }
              break;
            }
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
      captionsRef.current = [];
      agentLineIdRef.current = null;
      userLineIdRef.current = null;
      processedToolCallsRef.current.clear();
      setCaptions([]);
    };
  // createRealtimeSession is a stable React Query mutation reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  return { isSpeaking, isConnected, error, captions };
}
