"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { useGroupDetail } from "@/hooks/useGroupDetail";
import ErrorRetry from "@/components/ui/ErrorRetry";
import { formatStroopsAmount } from "@/lib/currency";

export default function GroupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    params.then(({ id: resolvedId }) => {
      if (!cancelled) setId(resolvedId);
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  const { group, status, error, refetch } = useGroupDetail(id);

  if (id === null || status === "loading") {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted">
            Loading group...
          </div>
        </div>
      </div>
    );
  }

  if (status === "not-found") {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <h2 className="text-xl font-semibold text-foreground mb-2">
              Group not found
            </h2>
            <p className="text-muted">
              This group doesn&apos;t exist or may have been removed.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="mx-auto max-w-2xl">
          <ErrorRetry error={error} onRetry={refetch} />
        </div>
      </div>
    );
  }

  if (!group) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Users className="h-8 w-8 text-brand" />
            <h1 className="text-3xl font-semibold text-foreground">
              {group.name}
            </h1>
          </div>
          <span
            className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${
              group.settled
                ? "bg-muted/20 text-muted"
                : "bg-brand/10 text-brand"
            }`}
          >
            {group.settled ? "Closed" : "Open"}
          </span>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 mb-6">
          <p className="text-sm text-muted mb-1">Pooled balance</p>
          <p className="text-2xl font-semibold text-foreground">
            {formatStroopsAmount(group.balance)} XLM
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">
            Members
          </h2>
          {group.members.length === 0 ? (
            <p className="text-muted">No members yet.</p>
          ) : (
            <ul className="space-y-3">
              {group.members.map((member) => (
                <li
                  key={member.address}
                  className="flex items-center justify-between border-t border-border pt-3 first:border-t-0 first:pt-0"
                >
                  <span className="font-mono text-sm text-foreground">
                    {member.address}
                  </span>
                  <span className="text-sm text-muted">
                    {formatStroopsAmount(member.contributed)} XLM
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
