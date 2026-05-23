import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { polar, checkout, portal } from "@polar-sh/better-auth";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { env } from "./env";
import { polarClient } from "./polar";
import { sendVerificationEmail } from "./email";

export const auth = betterAuth({
  // baseURL tells Better Auth how to construct verification/callback URLs.
  // Falls back to the request origin when not set (fine for local dev once
  // BETTER_AUTH_URL is set to http://localhost:3000 in .env).
  baseURL: env.BETTER_AUTH_URL,
  // A stable secret is required so that session and verification tokens
  // remain valid across server restarts.
  secret: env.BETTER_AUTH_SECRET,
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
    requireEmailVerification: true,
    sendVerificationEmail: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
      await sendVerificationEmail({ to: user.email, url });
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
    },
  }),
});
