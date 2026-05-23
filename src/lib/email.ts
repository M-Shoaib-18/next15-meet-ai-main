/**
 * Email dispatcher — currently a console mock for local development.
 * To switch to a real provider, replace the body of `sendVerificationEmail`
 * with a Resend / Nodemailer call and add the relevant env vars to src/lib/env.ts.
 */

interface VerificationEmailPayload {
  to: string;
  url: string;
}

export async function sendVerificationEmail({ to, url }: VerificationEmailPayload): Promise<void> {
  // --- MOCK: replace this block with a real email provider ---
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("[EMAIL VERIFICATION]");
  console.log(`  To : ${to}`);
  console.log(`  URL: ${url}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  // --- END MOCK ---
}
