import { useState } from "react";
import { SearchIcon } from "lucide-react";
import Highlighter from "react-highlight-words";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "@/trpc/client";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { generateAvatarUri } from "@/lib/avatar";

interface Props {
  meetingId: string;
  // Wall-clock time the meeting went active (meetings.startedAt). Caption
  // timestamps are offsets from this exact instant. May arrive as a Date or an
  // ISO string depending on serialization; `new Date(...)` handles both.
  startedAt: Date | string | null;
}

// Render a millisecond offset as HH:MM:SS (e.g. 00:05:23). Used to show how far
// into the meeting each line was spoken.
const formatElapsed = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

export const Transcript = ({ meetingId, startedAt }: Props) => {
  const trpc = useTRPC();
  const { data } = useQuery(trpc.meetings.getTranscript.queryOptions({ id: meetingId }))

  const [searchQuery, setSearchQuery] = useState("");
  const allItems = data ?? [];

  // start_ts is an absolute epoch timestamp (ms) for realtime-saved transcripts.
  // Anchor every line to the meeting's actual start (meetings.startedAt) so each
  // offset is the EXACT moment that line was spoken — not relative to the first
  // line. If startedAt is somehow missing, fall back to the earliest line so we
  // still render sane offsets instead of huge epoch numbers.
  const baseTs = startedAt
    ? new Date(startedAt).getTime()
    : allItems.length
      ? Math.min(...allItems.map((item) => item.start_ts))
      : 0;

  const filteredData = allItems.filter((item) =>
    item.text.toString().toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="bg-white rounded-lg border px-4 py-5 flex flex-col gap-y-4 w-full">
      <p className="text-sm font-medium">Transcript</p>
      <div className="relative">
        <Input
          placeholder="Search Transcript"
          className="pl-7 h-9 w-[240px]"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
      </div>
      <ScrollArea>
        <div className="flex flex-col gap-y-4">
          {filteredData.map((item, index) => {
            return (
              <div
                // start_ts can repeat across items (e.g. agent/user lines saved
                // with the same timestamp), so combine it with the index to keep
                // React keys unique.
                key={`${item.start_ts}-${index}`}
                className="flex flex-col gap-y-2 hover:bg-muted p-4 rounded-md border"
              >
                <div className="flex gap-x-2 items-center">
                  <Avatar className="size-6">
                    <AvatarImage
                      src={item.user.image ?? generateAvatarUri({ seed: item.user.name, variant: "initials" })}
                      alt="User Avatar"
                    />
                  </Avatar>
                  <p className="text-sm font-medium">{item.user.name}</p>
                  <p className="text-sm text-blue-500 font-medium">
                    {formatElapsed(item.start_ts - baseTs)}
                  </p>
                </div>
                <Highlighter
                  className="text-sm text-neutral-700"
                  highlightClassName="bg-yellow-200"
                  searchWords={[searchQuery]}
                  autoEscape={true}
                  textToHighlight={item.text}
                />
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
};