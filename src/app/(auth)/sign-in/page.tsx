import { redirect } from "next/navigation";

import { getSessionSafe } from "@/lib/session";
import { SignInView } from "@/modules/auth/ui/views/sign-in-view";

const Page = async () => {
  const session = await getSessionSafe();

  if (session?.user.emailVerified) {
    redirect("/");
  }

  if (session && !session.user.emailVerified) {
    redirect("/verify-email");
  }

  return <SignInView />;
};

export default Page;
