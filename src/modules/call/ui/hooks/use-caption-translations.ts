"use client";

import { useCallback, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { useTRPC } from "@/trpc/client";
import { CAPTIONS_OFF } from "../constants";
import type { CaptionLine } from "./use-openai-voice";

export interface CaptionTranslator {
  // Whether a target language is selected (translation is on).
  enabled: boolean;
  // Lazily request a translation for a finalized line. Cached and de-duped, so
  // it is safe to call repeatedly (e.g. from a render-driven effect). No-op when
  // disabled or when the line is not yet final.
  request: (line: CaptionLine) => void;
  // Read a previously-fetched translation for a line, or undefined if not ready.
  get: (line: CaptionLine) => string | undefined;
}

/**
 * Single source of truth for caption translations, shared by the live overlay
 * and the transcript side panel. Both call `request()` for the lines they show;
 * because results are cached by `${lineId}:${language}` and in-flight requests
 * are tracked, the same line is never translated twice — even across both
 * consumers — so turning on the panel doesn't double the token cost.
 */
export function useCaptionTranslations(targetLanguage: string): CaptionTranslator {
  const trpc = useTRPC();
  const { mutateAsync: translate } = useMutation(
    trpc.meetings.translateCaption.mutationOptions(),
  );

  const [translations, setTranslations] = useState<Record<string, string>>({});
  // Mirror state into a ref so `request` can check the cache without depending
  // on `translations` (keeps its identity stable across translations).
  const translationsRef = useRef<Record<string, string>>({});
  translationsRef.current = translations;

  const inFlightRef = useRef<Set<string>>(new Set());
  const enabled = targetLanguage !== CAPTIONS_OFF;

  const request = useCallback(
    (line: CaptionLine) => {
      if (!enabled || !line.final || !line.text.trim()) return;

      const key = `${line.id}:${targetLanguage}`;
      if (translationsRef.current[key] || inFlightRef.current.has(key)) return;

      inFlightRef.current.add(key);
      translate({ text: line.text, targetLanguage })
        .then((res) => {
          if (res.translated) {
            setTranslations((prev) => ({ ...prev, [key]: res.translated }));
          }
        })
        .catch(() => {
          // Best-effort: the original line still shows if translation fails.
        })
        .finally(() => {
          inFlightRef.current.delete(key);
        });
    },
    [enabled, targetLanguage, translate],
  );

  const get = useCallback(
    (line: CaptionLine) =>
      enabled ? translations[`${line.id}:${targetLanguage}`] : undefined,
    [enabled, targetLanguage, translations],
  );

  return { enabled, request, get };
}
