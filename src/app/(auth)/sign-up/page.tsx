import { redirect } from "next/navigation";

import { getSessionSafe } from "@/lib/session";
import { SignUpView } from "@/modules/auth/ui/views/sign-up-view";

const Page = async () => {
  const session = await getSessionSafe();

  if (session?.user.emailVerified) {
    redirect("/");
  }

  if (session && !session.user.emailVerified) {
    redirect("/verify-email");
  }

  return <SignUpView />;
};

export default Page;
