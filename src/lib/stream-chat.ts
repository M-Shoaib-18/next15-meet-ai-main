import "server-only";

import { StreamChat } from "stream-chat";
import { env } from "./env";

export const streamChat = StreamChat.getInstance(
  env.NEXT_PUBLIC_STREAM_CHAT_API_KEY,
  env.STREAM_CHAT_SECRET_KEY
);
