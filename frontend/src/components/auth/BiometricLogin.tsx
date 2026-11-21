"use client";

/**
 * BiometricLogin — login-page biometric prompt.
 *
 * Shows when the device has a registered biometric credential. Handles:
 * - automatic prompt on mount (opt-in via `autoPrompt`)
 * - manual retry after a failed / cancelled attempt
 * - explicit fallback to password
 * - browser-compatibility guard (renders nothing when unsupported)
 *
 * Props keep the component decoupled from routing: the caller supplies
 * `onSuccess` and `onFallback` callbacks.
 */

import { useEffect, useRef } from "react";
import { Fingerprint, Loader2, AlertCircle, ArrowRight } from "lucide-react";
import { useBiometric } from "@/hooks/useBiometric";
import type { PasskeyLoginResult } from "@/lib/passkey";

export interface BiometricLoginProps {
  /**
   * Called with the full session payload when biometric auth succeeds.
   * The parent is responsible for storing the session and navigating.
   */
  onSuccess: (result: PasskeyLoginResult) => void;
  /**
   * Called when the user explicitly chooses to fall back to password,
   * or when biometric is unavailable / unsupported.
   */
  onFallback: () => void;
  /**
   * When true the biometric prompt fires automatically on mount.
   * Useful for the login page where you want to surface the prompt
   * without a manual click on first visit.
   * @default false
   */
  autoPrompt?: boolean;
  /**
   * Optional credential id to scope the WebAuthn assertion to a specific
   * registered key on this device. Defaults to the most-recently enrolled one.
   */
  credentialId?: string;
  /**
   * Optional class name forwarded to the root element.
   */
  className?: string;
}

export default function BiometricLogin({
  onSuccess,
  onFallback,
  autoPrompt = false,
  credentialId,
  className,
}: BiometricLoginProps) {
  const { isSupported, hasCredential, status, error, isLoading, authenticate, fallback } =
    useBiometric();

  // Track whether we've already fired the auto-prompt so React Strict Mode
  // double-invocation doesn't send two simultaneous WebAuthn ceremonies.
  const autoPromptFired = useRef(false);

  useEffect(() => {
    if (!autoPrompt || autoPromptFired.current) return;
    if (!isSupported || !hasCredential) return;
    autoPromptFired.current = true;

    authenticate(credentialId).then((result) => {
      if (result) onSuccess(result);
    });
    // The deps list intentionally omits `authenticate` and `onSuccess` because
    // they're stable callbacks and we only want this to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrompt, isSupported, hasCredential, credentialId]);

  // Propagate fallback() calls to the parent so the parent can switch to
  // the password form without needing to monitor `status` itself.
  useEffect(() => {
    if (status === "fallback") {
      onFallback();
    }
  }, [status, onFallback]);

  // Nothing to show if the browser/platform doesn't support WebAuthn or if
  // no credential has been registered on this device.
  if (!isSupported || !hasCredential) {
    return null;
  }

  const handleAuthenticate = async () => {
    const result = await authenticate(credentialId);
    if (result) onSuccess(result);
  };

  const handleFallback = () => {
    fallback();
    // `onFallback` will be called via the status effect above.
  };

  const isError = status === "error";
  const isCancelled = status === "cancelled";
  const showRetry = isError || isCancelled;

  return (
    <div className={className}>
      {/* Primary biometric button */}
      <button
        type="button"
        onClick={handleAuthenticate}
        disabled={isLoading}
        aria-label={isLoading ? "Waiting for biometric…" : "Sign in with biometrics"}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand to-brand-2 px-6 py-3.5 text-sm font-semibold text-background shadow-lg shadow-brand/25 transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
      >
        {isLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Waiting for biometric…
          </>
        ) : (
          <>
            <Fingerprint className="h-4 w-4" aria-hidden="true" />
            {showRetry ? "Try again" : "Sign in with biometrics"}
          </>
        )}
      </button>

      {/* Error / cancelled feedback */}
      {isError && error && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-left text-sm text-red-400"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      {isCancelled && (
        <p role="status" className="mt-3 text-center text-sm text-muted">
          Biometric prompt was dismissed. Tap the button to try again.
        </p>
      )}

      {/* Fallback to password */}
      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={handleFallback}
          className="inline-flex items-center gap-1 text-sm text-muted underline-offset-2 hover:text-foreground hover:underline focus:outline-none focus:ring-2 focus:ring-brand/50 rounded"
        >
          Use password instead
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
