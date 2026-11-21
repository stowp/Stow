/**
 * useBiometric — React hook for biometric authentication.
 *
 * Encapsulates all state for the biometric login flow:
 * - detecting support and registered credentials on this device
 * - triggering authentication (with fallback tracking)
 * - registering new credentials (setup flow in Settings)
 * - removing credentials
 *
 * The hook is intentionally side-effect-free on mount so it's safe to
 * instantiate in multiple components without duplicate work.
 */

import { useCallback, useEffect, useState } from "react";
import {
  authenticateWithBiometric,
  clearAllBiometricCredentials,
  getRegisteredCredentials,
  isBiometricSupported,
  registerBiometric,
  removeBiometricCredential,
  BiometricError,
  type BiometricCredential,
} from "@/lib/biometric";
import type { PasskeyLoginResult } from "@/lib/passkey";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BiometricStatus =
  | "idle"
  | "authenticating"
  | "registering"
  | "success"
  | "error"
  | "cancelled"
  | "unsupported"
  | "fallback";

export interface UseBiometricReturn {
  /** Whether the platform supports WebAuthn biometrics. */
  isSupported: boolean;
  /** Whether at least one credential is stored on this device. */
  hasCredential: boolean;
  /** All credentials stored on this device, newest-first. */
  credentials: BiometricCredential[];
  /** Current flow status. */
  status: BiometricStatus;
  /** User-facing error message when `status === "error"`. */
  error: string | null;
  /** True while an async operation is in progress. */
  isLoading: boolean;
  /**
   * Trigger biometric authentication. Uses the most-recently registered
   * credential by default; pass a specific `credentialId` to override.
   * Resolves with the session on success; rejects with `BiometricError` on
   * failure (the hook also sets `status` and `error` for you).
   */
  authenticate: (credentialId?: string) => Promise<PasskeyLoginResult | null>;
  /**
   * Register a new biometric credential for the current authenticated user.
   * Intended for the Settings setup flow.
   */
  register: (deviceName?: string) => Promise<BiometricCredential | null>;
  /**
   * Remove a credential from this device by id.
   */
  removeCredential: (credentialId: string) => void;
  /**
   * Remove all credentials from this device.
   */
  clearCredentials: () => void;
  /**
   * Signal that the user chose to fall back to password instead of biometric.
   * Sets `status` to `"fallback"`.
   */
  fallback: () => void;
  /** Reset status and error back to idle. */
  reset: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useBiometric(): UseBiometricReturn {
  const [isSupported] = useState<boolean>(() => isBiometricSupported());
  const [credentials, setCredentials] = useState<BiometricCredential[]>(() =>
    getRegisteredCredentials(),
  );
  const [status, setStatus] = useState<BiometricStatus>(() =>
    isBiometricSupported() ? "idle" : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);

  // Keep credentials in sync after storage changes from other tabs / components.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "stow-biometric-credentials") {
        setCredentials(getRegisteredCredentials());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const refreshCredentials = useCallback(() => {
    setCredentials(getRegisteredCredentials());
  }, []);

  const authenticate = useCallback(
    async (credentialId?: string): Promise<PasskeyLoginResult | null> => {
      setStatus("authenticating");
      setError(null);

      // Pick the most-recently registered credential when none is specified.
      const targetId =
        credentialId ?? getRegisteredCredentials()[0]?.credentialId;

      try {
        const result = await authenticateWithBiometric(targetId);
        setStatus("success");
        return result;
      } catch (err) {
        if (err instanceof BiometricError) {
          if (err.code === "cancelled") {
            setStatus("cancelled");
            setError(null);
          } else if (err.code === "unsupported") {
            setStatus("unsupported");
            setError(err.message);
          } else {
            setStatus("error");
            setError(err.message);
          }
        } else {
          setStatus("error");
          setError("Biometric authentication failed. Please try again.");
        }
        return null;
      }
    },
    [],
  );

  const register = useCallback(
    async (deviceName?: string): Promise<BiometricCredential | null> => {
      setStatus("registering");
      setError(null);

      try {
        const credential = await registerBiometric(deviceName);
        refreshCredentials();
        setStatus("idle");
        return credential;
      } catch (err) {
        if (err instanceof BiometricError) {
          if (err.code === "cancelled") {
            setStatus("cancelled");
            setError(null);
          } else if (err.code === "unsupported") {
            setStatus("unsupported");
            setError(err.message);
          } else {
            setStatus("error");
            setError(err.message);
          }
        } else {
          setStatus("error");
          setError("Could not register biometric authentication. Please try again.");
        }
        return null;
      }
    },
    [refreshCredentials],
  );

  const removeCredential = useCallback(
    (credentialId: string) => {
      removeBiometricCredential(credentialId);
      refreshCredentials();
    },
    [refreshCredentials],
  );

  const clearCredentials = useCallback(() => {
    clearAllBiometricCredentials();
    setCredentials([]);
  }, []);

  const fallback = useCallback(() => {
    setStatus("fallback");
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setStatus(isSupported ? "idle" : "unsupported");
    setError(null);
  }, [isSupported]);

  return {
    isSupported,
    hasCredential: credentials.length > 0,
    credentials,
    status,
    error,
    isLoading: status === "authenticating" || status === "registering",
    authenticate,
    register,
    removeCredential,
    clearCredentials,
    fallback,
    reset,
  };
}
