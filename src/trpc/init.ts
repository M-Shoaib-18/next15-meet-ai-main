import { db } from '@/db';
import { agents, meetings } from '@/db/schema';
import { auth } from '@/lib/auth';
import { polarClient } from '@/lib/polar';
import { MAX_FREE_AGENTS, MAX_FREE_MEETINGS } from '@/modules/premium/constants';
import { initTRPC, TRPCError } from '@trpc/server';
import { count, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { cache } from 'react';

export const createTRPCContext = cache(async () => {
  /**
   * @see: https://trpc.io/docs/server/context
   */
  return { userId: 'user_123' };
});

/**
 * Fetches the Polar customer state by externalId.
 * If not found (customer exists in Polar but externalId was never linked —
 * e.g. the user subscribed before signing up in the app, or the onSignUp hook
 * ran before the subscription was recorded), we repair the link by looking up
 * the customer by email and updating their externalId.
 */
export async function getCustomerState(userId: string, userEmail: string) {
  // Fast path: customer already linked by externalId
  try {
    return await polarClient.customers.getStateExternal({ externalId: userId });
  } catch {
    // Fall through to repair path
  }

  // Repair path: find customer by email and link externalId
  try {
    const { result } = await polarClient.customers.list({ email: userEmail });
    const existing = result.items[0];
    if (!existing) return null;

    if (existing.externalId !== userId) {
      await polarClient.customers.update({
        id: existing.id,
        customerUpdate: { externalId: userId },
      });
    }

    return await polarClient.customers.getStateExternal({ externalId: userId });
  } catch (err) {
    console.error("[polar] getCustomerState failed for userId=%s:", userId, err);
    return null;
  }
}
// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
const t = initTRPC.create({
  /**
   * @see https://trpc.io/docs/server/data-transformers
   */
  // transformer: superjson,
});
// Base router and procedure helpers
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure;
export const protectedProcedure = baseProcedure.use(async ({ ctx, next }) => {
  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  try {
    session = await auth.api.getSession({ headers: await headers() });
  } catch {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorized" });
  }

  if (!session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Unauthorized" });
  }

  return next({ ctx: { ...ctx, auth: session } });
});
export const premiumProcedure = (entity: "meetings" | "agents") =>
  protectedProcedure.use(async ({ ctx, next }) => {
    const customer = await getCustomerState(ctx.auth.user.id, ctx.auth.user.email);

    const [userMeetings] = await db
      .select({
        count: count(meetings.id),
      })
      .from(meetings)
      .where(eq(meetings.userId, ctx.auth.user.id));

    const [userAgents] = await db
      .select({
        count: count(agents.id),
      })
      .from(agents)
      .where(eq(agents.userId, ctx.auth.user.id));

    const isPremium = (customer?.activeSubscriptions.length ?? 0) > 0;
    const isFreeAgentLimitReached = userAgents.count >= MAX_FREE_AGENTS;
    const isFreeMeetingLimitReached = userMeetings.count >= MAX_FREE_MEETINGS;

    const shouldThrowMeetingError =
      entity === "meetings" && isFreeMeetingLimitReached && !isPremium;
    const shouldThrowAgentError =
      entity === "agents" && isFreeAgentLimitReached && !isPremium;

    if (shouldThrowMeetingError) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You have reached the maximum number of free meetings",
      });
    }

    if (shouldThrowAgentError) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You have reached the maximum number of free agents",
      });
    }

    return next({ ctx: { ...ctx, customer } });
  });
