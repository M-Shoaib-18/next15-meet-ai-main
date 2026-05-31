import { redirect } from "next/navigation";

import { getSessionSafe } from "@/lib/session";
import { VerifyEmailView } from "@/modules/auth/ui/views/verify-email-view";

const Page = async () => {
  const session = await getSessionSafe();

  if (!session) {
    redirect("/sign-in");
  }

  if (session.user.emailVerified) {
    redirect("/");
  }

  return <VerifyEmailView />;
};

export default Page;
