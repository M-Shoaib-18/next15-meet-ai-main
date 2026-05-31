import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { polar, checkout, portal, webhooks } from "@polar-sh/better-auth";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { env } from "./env";
import { polarClient } from "./polar";
import { isDisposableEmail } from "./disposable-email-domains";

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  logger: {
    // better-auth calls console.error internally before throwing on DB errors.
    // getSessionSafe() already handles the throw gracefully, so we suppress
    // the "Failed query" noise that Next.js dev mode forwards to the browser.
    log(level, message, ...args) {
      if (
        level === "error" &&
        typeof message === "string" &&
        message.startsWith("Failed query")
      ) {
        return;
      }
      (console[level as keyof Console] as typeof console.log)?.(message, ...args);
    },
  },
  plugins: [
    polar({
      client: polarClient,
      createCustomerOnSignUp: true,
      use: [
        checkout({
          authenticatedUsersOnly: true,
          successUrl: "/upgrade",
        }),
        portal(),
        ...(env.POLAR_WEBHOOK_SECRET
          ? [webhooks({ secret: env.POLAR_WEBHOOK_SECRET })]
          : []),
      ],
    }),
  ],
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Email verification removed in favor of spam protection that needs no
    // mail provider: rate limiting + disposable-email blocking + a honeypot
    // field on the sign-up form. Users are signed in immediately after sign-up.
    requireEmailVerification: false,
  },
  // Spam/abuse protection layer 1: rate limiting. Backed by Postgres (the
  // `rateLimit` table) so the limits hold across serverless instances in
  // production. Enabled in development too so behavior matches.
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60, // default window (seconds) for any non-custom path
    max: 100, // default max requests per window
    customRules: {
      "/sign-up/email": { window: 60, max: 5 },
      "/sign-in/email": { window: 60, max: 10 },
      "/forget-password": { window: 60, max: 5 },
    },
  },
  // Spam/abuse protection layer 2: reject obvious disposable email domains
  // before the user record is created. Throwing APIError surfaces a clean
  // message to the client.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (isDisposableEmail(user.email)) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Disposable email addresses are not allowed. Please use a permanent email.",
            });
          }
          return { data: user };
        },
      },
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
    },
  }),
});
