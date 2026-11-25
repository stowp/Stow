"use client";

import { useState, type FormEvent } from "react";
import { Fingerprint, KeyRound, Loader2, LogOut } from "lucide-react";
import { useSession } from "@/context/SessionProvider";
import { loginWithPasskey } from "@/lib/passkey";
import { verifyPin, type BiometricAccessSettings } from "@/lib/biometricAccess";

interface AppAccessLockProps {
  userId: string;
  settings: BiometricAccessSettings;
  onUnlock: () => void;
  onSignOut: () => void;
}

export default function AppAccessLock({
  userId,
  settings,
  onUnlock,
  onSignOut,
}: AppAccessLockProps) {
  const { setSession } = useSession();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"passkey" | "pin" | null>(null);

  const handlePasskeyUnlock = async () => {
    setPending("passkey");
    setError("");
    try {
      const result = await loginWithPasskey({
        requireUserVerification: true,
        credentialId: settings.credentialId,
      });
      if (result.user.id !== userId) {
        throw new Error("This passkey belongs to a different Stow account.");
      }
      setSession(result.access_token, { id: result.user.id }, result.user.stellar_address);
      onUnlock();
    } catch (unlockError) {
      setError(
        unlockError instanceof Error
          ? unlockError.message
          : "Could not verify with this device. Use your PIN instead.",
      );
    } finally {
      setPending(null);
    }
  };

  const handlePinUnlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(pin)) {
      setError("Enter your six-digit PIN.");
      return;
    }

    setPending("pin");
    setError("");
    try {
      if (await verifyPin(pin, settings)) {
        onUnlock();
      } else {
        setError("That PIN did not match. Try again or use your passkey.");
        setPin("");
      }
    } catch {
      setError("Could not verify your PIN. Use your passkey or sign out.");
    } finally {
      setPending(null);
    }
  };

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="grid min-h-screen place-items-center bg-background p-4"
    >
      <section
        aria-labelledby="app-unlock-title"
        aria-modal="true"
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl sm:p-8"
        role="dialog"
      >
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-brand/30 bg-brand/10">
          <KeyRound className="h-6 w-6 text-brand" aria-hidden="true" />
        </div>
        <h1 id="app-unlock-title" className="mt-5 text-center text-xl font-semibold text-foreground">
          Unlock Stow
        </h1>
        <p className="mt-2 text-center text-sm text-muted">
          Verify it&apos;s you to continue to your account.
        </p>
        <p className="mt-2 text-center text-xs text-muted">
          On shared devices, sign out when you are finished.
        </p>

        <button
          type="button"
          onClick={handlePasskeyUnlock}
          disabled={pending !== null}
          className="mt-6 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-[#06211e] transition-colors hover:bg-brand/90 disabled:opacity-60"
        >
          {pending === "passkey" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Fingerprint className="h-4 w-4" aria-hidden="true" />
          )}
          Unlock with biometrics
        </button>

        <div className="my-5 flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-border" />
          or use your PIN
          <span className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handlePinUnlock} className="space-y-3">
          <label htmlFor="app-unlock-pin" className="block text-sm font-medium text-foreground">
            Six-digit PIN
          </label>
          <input
            id="app-unlock-pin"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            pattern="[0-9]{6}"
            maxLength={6}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-full rounded-lg border border-border bg-background px-4 py-3 text-center text-lg text-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
            required
          />
          <button
            type="submit"
            disabled={pending !== null}
            className="min-h-10 w-full rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card/70 disabled:opacity-60"
          >
            {pending === "pin" ? "Checking PIN…" : "Unlock with PIN"}
          </button>
        </form>

        {error && (
          <p role="alert" className="mt-4 text-center text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={onSignOut}
          className="mx-auto mt-5 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </button>
      </section>
    </main>
  );
}