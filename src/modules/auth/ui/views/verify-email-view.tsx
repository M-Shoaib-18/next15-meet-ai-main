"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { MailCheckIcon, OctagonAlertIcon } from "lucide-react";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";

export const VerifyEmailView = () => {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    await authClient.signOut();
    router.push("/sign-in");
  };

  const handleResend = () => {
    if (!email) {
      setError("Please enter your email address.");
      return;
    }
    setError(null);
    setPending(true);

    authClient.sendVerificationEmail(
      { email, callbackURL: "/" },
      {
        onSuccess: () => {
          setPending(false);
          setSent(true);
        },
        onError: ({ error }) => {
          setPending(false);
          setError(error.message);
        },
      }
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden p-0">
        <CardContent className="grid p-0 md:grid-cols-2">
          <div className="p-6 md:p-8 flex flex-col gap-6">
            <div className="flex flex-col items-center text-center gap-3">
              <MailCheckIcon className="size-10 text-primary" />
              <h1 className="text-2xl font-bold">Verify your email</h1>
              <p className="text-muted-foreground text-balance">
                Your account is not yet verified. Enter your email below to
                receive a new verification link.
              </p>
            </div>

            {sent ? (
              <Alert className="bg-primary/10 border-none">
                <MailCheckIcon className="h-4 w-4 !text-primary" />
                <AlertTitle>Verification link sent — check your inbox.</AlertTitle>
              </Alert>
            ) : (
              <>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={pending}
                />
                <Button
                  onClick={handleResend}
                  disabled={pending}
                  className="w-full"
                >
                  {pending ? "Sending…" : "Send verification email"}
                </Button>
              </>
            )}

            {!!error && (
              <Alert className="bg-destructive/10 border-none">
                <OctagonAlertIcon className="h-4 w-4 !text-destructive" />
                <AlertTitle>{error}</AlertTitle>
              </Alert>
            )}

            <div className="text-center text-sm">
              <button
                onClick={handleSignOut}
                className="underline underline-offset-4 text-sm"
              >
                Back to sign in
              </button>
            </div>
          </div>

          <div className="bg-radial from-sidebar-accent to-sidebar relative hidden md:flex flex-col gap-y-4 items-center justify-center">
            <Image src="/logo.svg" alt="Meet.AI Logo" width={92} height={92} priority />
            <p className="text-2xl font-semibold text-white">Meet.AI</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
