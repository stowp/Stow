"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-red-500/30 bg-red-500/10 text-red-400">
        <AlertTriangle className="h-7 w-7" aria-hidden="true" />
      </div>
      <h1 className="text-xl font-semibold text-foreground">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">
        An unexpected error occurred. You can try again, or head back to the homepage.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={retry}
          className="group flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand to-brand-2 px-5 py-2.5 text-sm font-semibold text-background shadow-lg shadow-brand/20 transition-transform hover:scale-[1.03]"
        >
          <RefreshCw className="h-4 w-4 transition-transform group-hover:-rotate-180 duration-500" aria-hidden="true" />
          Try again
        </button>
        <Link
          href="/"
          className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-brand/40"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
