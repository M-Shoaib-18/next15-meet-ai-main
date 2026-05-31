/**
 * Curated blocklist of common disposable / temporary email domains.
 *
 * Used to reject obvious throwaway addresses at sign-up (see databaseHooks in
 * src/lib/auth.ts). This is intentionally a small, high-signal list rather than
 * an exhaustive one — it catches the overwhelming majority of spam signups
 * without any external service or network call, so it behaves identically in
 * development and production. Add domains here as needed.
 */
export const DISPOSABLE_EMAIL_DOMAINS = new Set<string>([
  "0clock.net",
  "10minutemail.com",
  "10minutemail.net",
  "20minutemail.com",
  "33mail.com",
  "anonbox.net",
  "anonymbox.com",
  "burnermail.io",
  "deadaddress.com",
  "discard.email",
  "discardmail.com",
  "dispostable.com",
  "dropmail.me",
  "emailondeck.com",
  "fakeinbox.com",
  "fakemail.net",
  "fakemailgenerator.com",
  "getairmail.com",
  "getnada.com",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxbear.com",
  "inboxkitten.com",
  "jetable.org",
  "mail-temp.com",
  "mail7.io",
  "mailcatch.com",
  "maildrop.cc",
  "maileater.com",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mailsac.com",
  "mailtothis.com",
  "mehmail.com",
  "mintemail.com",
  "mohmal.com",
  "moakt.com",
  "mytemp.email",
  "nada.email",
  "nowmymail.com",
  "objectmail.com",
  "owlymail.com",
  "rootfest.net",
  "sharklasers.com",
  "spam4.me",
  "spambox.us",
  "spamgourmet.com",
  "tempemail.com",
  "tempinbox.com",
  "tempmail.com",
  "tempmail.net",
  "tempmailo.com",
  "tempr.email",
  "temp-mail.org",
  "throwawaymail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "wegwerfmail.de",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "zetmail.com",
]);

/**
 * Returns true if the given email address uses a known disposable domain.
 */
export function isDisposableEmail(email: string): boolean {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}
