"use client";

import "./globals.css";

export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-full flex flex-col" style={{ background: "#05070d", color: "#eef2ff" }}>
        <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="mt-2 max-w-sm text-sm" style={{ color: "#9aa6c4" }}>
            The app hit an unexpected error. Please try again.
          </p>
          <button
            onClick={retry}
            className="mt-6 rounded-xl px-5 py-2.5 text-sm font-semibold"
            style={{
              background: "linear-gradient(to right, #2dd4bf, #6366f1)",
              color: "#05070d",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
