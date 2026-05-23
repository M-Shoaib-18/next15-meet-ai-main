import { eq, count } from "drizzle-orm";

import { db } from "@/db";
import { polarClient } from "@/lib/polar";
import { agents, meetings } from "@/db/schema";
import { TRPCError } from "@trpc/server";
import {
  createTRPCRouter,
  protectedProcedure,
} from "@/trpc/init";

export const premiumRouter = createTRPCRouter({
  getCurrentSubscription: protectedProcedure.query(async ({ ctx }) => {
    let customer: Awaited<ReturnType<typeof polarClient.customers.getStateExternal>> | null = null;
    try {
      customer = await polarClient.customers.getStateExternal({
        externalId: ctx.auth.user.id,
      });
    } catch {
      return null;
    }

    const subscription = customer.activeSubscriptions[0];

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
    let customer: Awaited<ReturnType<typeof polarClient.customers.getStateExternal>> | null = null;
    try {
      customer = await polarClient.customers.getStateExternal({
        externalId: ctx.auth.user.id,
      });
    } catch {
      customer = null;
    }

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