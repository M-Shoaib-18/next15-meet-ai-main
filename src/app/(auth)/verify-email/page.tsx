import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { VerifyEmailView } from "@/modules/auth/ui/views/verify-email-view";

const Page = async () => {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  // Already verified — send straight to the dashboard
  if (session?.user.emailVerified) {
    redirect("/");
  }

  return <VerifyEmailView />;
};

export default Page;
