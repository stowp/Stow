"use client";

import { PartyPopper } from "lucide-react";
import { useSession } from "@/context/SessionProvider";
import SocialFeed from "@/components/social/SocialFeed";

/** Community feed of shared savings achievements. */
export default function SocialPage() {
  const { user } = useSession();

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center gap-3">
          <PartyPopper className="h-8 w-8 text-brand" aria-hidden="true" />
          <h1 className="text-3xl font-semibold text-foreground">Community</h1>
        </div>
        <SocialFeed currentUserId={user?.id ?? null} />
      </div>
    </div>
  );
}
