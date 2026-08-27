"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";

type Status = "idle" | "loading" | "success" | "error";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email)) {
      setStatus("error");
      setError("Please enter a valid email address.");
      return;
    }
    setStatus("loading");
    setError("");

    try {
      const response = await apiFetch("/api/waitlist", {
        method: "POST",
        body: JSON.stringify({ email }),
        skipAuth: true,
      });

      if (response.status === 409) {
        setStatus("success");
        setEmail("");
        return;
      }

      if (!response.ok) {
        let message = "Something went wrong. Please try again.";
        try {
          const data = await response.json();
          message = data.message || data.error || message;
        } catch {
          // response wasn't JSON, keep default message
        }
        throw new ApiError(message, response.status);
      }

      setStatus("success");
      setEmail("");
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof ApiError ? err.message : "Something went wrong. Please try again.",
      );
    }
  }

  if (status === "success") {
    return (
      <div className="mx-auto mt-9 flex max-w-md items-center justify-center gap-2 rounded-xl border border-brand/40 bg-brand/[0.07] px-5 py-3.5 text-sm font-medium text-foreground">
        <CheckCircle2 className="h-4 w-4 text-brand" />
        You&apos;re on the list — we&apos;ll be in touch.
      </div>
    );
  }

  return (
    <div className="mx-auto mt-9 w-full max-w-md">
      <form
        onSubmit={onSubmit}
        noValidate
        className="flex w-full flex-col gap-3 sm:flex-row"
      >
        <label htmlFor="waitlist-email" className="sr-only">
          Email address
        </label>
        <input
          id="waitlist-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          aria-invalid={status === "error"}
          aria-describedby={status === "error" ? "waitlist-error" : undefined}
          className="flex-1 rounded-xl border border-border bg-card px-4 py-3.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-brand/50"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="group flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand to-brand-2 px-6 py-3.5 text-sm font-semibold text-background shadow-xl shadow-brand/25 transition-transform hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:scale-100"
        >
          {status === "loading" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Joining…
            </>
          ) : (
            <>
              Join waitlist
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </>
          )}
        </button>
      </form>
      {status === "error" && (
        <p id="waitlist-error" role="alert" className="mt-2 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
