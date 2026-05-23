import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Safe wrapper around auth.api.getSession that returns null instead of
 * throwing when the database is temporarily unavailable or the session
 * token is invalid. All server components and route handlers should use
 * this instead of calling auth.api.getSession directly.
 */
export async function getSessionSafe() {
  try {
    return await auth.api.getSession({ headers: await headers() });
  } catch {
    return null;
  }
}
