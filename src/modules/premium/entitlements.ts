// Plan tiers and what each one unlocks.
//
// A user's tier is derived from the NAME of their active Polar subscription
// product (case-insensitive). The real product names are:
//   - "Monthly basic"  → basic
//   - "yearly pro"      → pro
//   - "enterprise"      → enterprise
// Users with no active subscription are treated as "basic".
//
// Feature matrix (per the product spec):
//   basic      : meetings (auto-end at 1h)
//   pro        : basic + live subtitles/captions (all languages)
//   enterprise : pro + invite multiple people via link (built later)

export type PlanTier = "basic" | "pro" | "enterprise";

// Every plan caps a single meeting at 1 hour; the meeting auto-ends after this.
export const MAX_MEETING_DURATION_SECONDS = 60 * 60;

export interface Entitlements {
  tier: PlanTier;
  // Hard cap (seconds) for a single meeting before it auto-ends.
  maxMeetingDurationSeconds: number;
  // Live on-screen subtitles/captions — the caption overlay, the transcript
  // side panel, and the language picker. Pro and Enterprise only.
  captionsEnabled: boolean;
  // Invite other people into a meeting via a link. Enterprise only (future).
  invitesEnabled: boolean;
}

// Resolve a tier from a Polar product name. Order matters: check "enterprise"
// before "pro" so a name like "Enterprise Pro" wouldn't be mis-bucketed.
// Anything unrecognized (including no subscription) falls back to "basic".
export function resolveTier(productName: string | null | undefined): PlanTier {
  const name = (productName ?? "").toLowerCase();
  if (name.includes("enterprise")) return "enterprise";
  if (name.includes("pro")) return "pro";
  return "basic";
}

export function getEntitlements(tier: PlanTier): Entitlements {
  return {
    tier,
    maxMeetingDurationSeconds: MAX_MEETING_DURATION_SECONDS,
    captionsEnabled: tier === "pro" || tier === "enterprise",
    invitesEnabled: tier === "enterprise",
  };
}
