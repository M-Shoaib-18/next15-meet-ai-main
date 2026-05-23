import { z } from "zod";

// Coerce empty strings (from .env KEY="") to undefined so optional fields
// don't fail URL/min-length validation when left blank locally.
const emptyToUndefined = z.preprocess(
  (val) => (val === "" ? undefined : val),
  z.string().optional()
);

const serverEnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Better Auth
  BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
  BETTER_AUTH_URL: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().url("BETTER_AUTH_URL must be a valid URL (e.g. http://localhost:3000)").optional()
  ),

  // Auth providers
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),

  // Stream
  NEXT_PUBLIC_STREAM_VIDEO_API_KEY: z.string().min(1, "NEXT_PUBLIC_STREAM_VIDEO_API_KEY is required"),
  STREAM_VIDEO_SECRET_KEY: z.string().min(1, "STREAM_VIDEO_SECRET_KEY is required"),
  NEXT_PUBLIC_STREAM_CHAT_API_KEY: z.string().min(1, "NEXT_PUBLIC_STREAM_CHAT_API_KEY is required"),
  STREAM_CHAT_SECRET_KEY: z.string().min(1, "STREAM_CHAT_SECRET_KEY is required"),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),

  // Polar
  POLAR_ACCESS_TOKEN: z.string().min(1, "POLAR_ACCESS_TOKEN is required"),

  // Inngest
  INNGEST_EVENT_KEY: emptyToUndefined,
  INNGEST_SIGNING_KEY: emptyToUndefined,
});

const parsed = serverEnvSchema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Missing or invalid environment variables:\n${missing}`);
}

export const env = parsed.data;
