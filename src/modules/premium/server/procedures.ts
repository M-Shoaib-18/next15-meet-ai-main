import { eq, count } from "drizzle-orm";

import { db } from "@/db";
import { polarClient } from "@/lib/polar";
import { agents, meetings } from "@/db/schema";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedProcedure,
  getCustomerState,
} from "@/trpc/init";
import { getEntitlements, resolveTier } from "../entitlements";

export const premiumRouter = createTRPCRouter({
  /**
   * Resolves the current user's plan entitlements (tier + feature flags) from
   * their active Polar subscription product name. No subscription → "basic".
   * Used to gate meeting duration, live captions, and (future) invites.
   */
  getEntitlement: protectedProcedure.query(async ({ ctx }) => {
    const customer = await getCustomerState(ctx.auth.user.id, ctx.auth.user.email);
    const subscription = customer?.activeSubscriptions[0];

    let productName: string | null = null;
    if (subscription) {
      try {
        const product = await polarClient.products.get({
          id: subscription.productId,
        });
        productName = product.name;
      } catch {
        // Product lookup failed — fall back to basic entitlements below.
      }
    }

    return getEntitlements(resolveTier(productName));
  }),
  getCurrentSubscription: protectedProcedure.query(async ({ ctx }) => {
    const customer = await getCustomerState(ctx.auth.user.id, ctx.auth.user.email);

    const subscription = customer?.activeSubscriptions[0];

    if (!subscription) {
      return null;
    }

    const product = await polarClient.products.get({
      id: subscription.productId,
    });

    return product;
  }),
  getProducts: protectedProcedure.query(async () => {
    try {
      const products = await polarClient.products.list({
        isArchived: false,
        isRecurring: true,
        sorting: ["price_amount"],
      });
      return products.result.items;
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to load products. Please try again later.",
      });
    }
  }),
  getFreeUsage: protectedProcedure.query(async ({ ctx }) => {
    const customer = await getCustomerState(ctx.auth.user.id, ctx.auth.user.email);

    // Premium users: no free-usage cap to display
    const isActiveSubscriber = (customer?.activeSubscriptions.length ?? 0) > 0;
    if (isActiveSubscriber) {
      return null;
    }

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

    return {
      meetingCount: userMeetings.count,
      agentCount: userAgents.count,
    };
  }),
});