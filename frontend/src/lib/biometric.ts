/**
 * WebAuthn biometric authentication library.
 *
 * This module manages the full biometric login flow: device registration,
 * credential storage, authentication, and removal. It wraps the low-level
 * passkey ceremony functions from `@/lib/passkey` and persists registered
 * device descriptors in `localStorage` so the login page can show a prompt
 * on devices the user has previously enrolled.
 *
 * Key design decisions:
 * - Credential metadata (id, name, registered date) is stored locally so
 *   the login page works offline / before any API call. The actual public key
 *   lives on the server.
 * - `authenticateWithBiometric` accepts an optional credential id to scope
 *   the WebAuthn assertion to exactly the enrolled key on this device, which
 *   prevents the authenticator from offering roaming keys that belong to other
 *   accounts.
 * - Browser compatibility is checked before every ceremony so callers receive
 *   a clear error rather than a browser exception.
 */

import {
  loginWithPasskey,
  registerPasskey,
  PasskeyLoginError,
  PasskeyRegistrationError,
  type PasskeyLoginResult,
  type PasskeyRegistrationResult,
} from "@/lib/passkey";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

// ─── Storage ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = "stow-biometric-credentials";

export interface BiometricCredential {
  /** The WebAuthn credential id returned by the server at registration time. */
  credentialId: string;
  /** Human-readable device label shown in the UI (e.g. "iPhone 15" or "Work laptop"). */
  deviceName: string;
  /** ISO 8601 timestamp of when the credential was registered on this device. */
  registeredAt: string;
}

function readStoredCredentials(): BiometricCredential[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BiometricCredential =>
        typeof item?.credentialId === "string" &&
        typeof item?.deviceName === "string" &&
        typeof item?.registeredAt === "string",
    );
  } catch {
    return [];
  }
}

function writeStoredCredentials(credentials: BiometricCredential[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch {
    // localStorage unavailable (private mode, quota exceeded); silently
    // accept — the credential won't survive a reload, but the current tab works.
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Whether the current browser and platform supports WebAuthn / biometric auth.
 * Returns false in SSR environments and browsers without the API.
 */
export function isBiometricSupported(): boolean {
  if (typeof window === "undefined") return false;
  return browserSupportsWebAuthn();
}

/**
 * Returns all credentials registered on this device, sorted newest-first.
 * Returns an empty array when localStorage is unavailable or the data is
 * malformed.
 */
export function getRegisteredCredentials(): BiometricCredential[] {
  return readStoredCredentials().sort(
    (a, b) =>
      new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime(),
  );
}

/**
 * Returns true when at least one credential is stored on this device.
 */
export function hasBiometricCredential(): boolean {
  return readStoredCredentials().length > 0;
}

/** Errors that `registerBiometric` and `authenticateWithBiometric` may throw. */
export class BiometricError extends Error {
  /**
   * - `unsupported`: browser/platform does not support WebAuthn.
   * - `cancelled`: user dismissed the prompt.
   * - `registration-failed`: attestation or server registration failed.
   * - `authentication-failed`: assertion or server verification failed.
   */
  code:
    | "unsupported"
    | "cancelled"
    | "registration-failed"
    | "authentication-failed";

  constructor(
    message: string,
    code: BiometricError["code"],
  ) {
    super(message);
    this.name = "BiometricError";
    this.code = code;
  }
}

/**
 * Registers a new biometric credential for the authenticated user.
 *
 * Runs the full WebAuthn registration ceremony (begin → platform authenticator
 * → finish), stores the resulting credential descriptor locally, and returns
 * it. Requires a valid session (the registration endpoints are gated on
 * `@CurrentUser()` on the backend).
 *
 * @param deviceName - Human-readable label for this device (shown in the
 *   credential manager). Defaults to "This device".
 * @throws `BiometricError` with code `unsupported`, `cancelled`, or
 *   `registration-failed`.
 */
export async function registerBiometric(
  deviceName = "This device",
): Promise<BiometricCredential> {
  if (!isBiometricSupported()) {
    throw new BiometricError(
      "Biometric authentication is not supported in this browser.",
      "unsupported",
    );
  }

  let result: PasskeyRegistrationResult;
  try {
    result = await registerPasskey(deviceName, {
      requirePlatformAuthenticator: true,
    });
  } catch (err) {
    if (
      err instanceof PasskeyRegistrationError &&
      err.cancelled
    ) {
      throw new BiometricError(
        "Biometric setup was cancelled.",
        "cancelled",
      );
    }
    throw new BiometricError(
      err instanceof PasskeyRegistrationError
        ? err.message
        : "Could not register biometric authentication on this device.",
      "registration-failed",
    );
  }

  const credential: BiometricCredential = {
    credentialId: result.credential_id,
    deviceName,
    registeredAt: result.created_at,
  };

  const existing = readStoredCredentials();
  // Guard against duplicate registrations for the same credential id.
  const deduped = existing.filter(
    (c) => c.credentialId !== credential.credentialId,
  );
  writeStoredCredentials([...deduped, credential]);

  return credential;
}

/**
 * Authenticates the user with their registered biometric.
 *
 * When a `credentialId` is provided the WebAuthn assertion is scoped to that
 * key; without it the browser may show all passkeys for the relying party.
 * Returns the same session object as a regular passkey login.
 *
 * @throws `BiometricError` with code `unsupported`, `cancelled`, or
 *   `authentication-failed`.
 */
export async function authenticateWithBiometric(
  credentialId?: string,
): Promise<PasskeyLoginResult> {
  if (!isBiometricSupported()) {
    throw new BiometricError(
      "Biometric authentication is not supported in this browser.",
      "unsupported",
    );
  }

  try {
    return await loginWithPasskey({
      requireUserVerification: true,
      credentialId,
    });
  } catch (err) {
    if (err instanceof PasskeyLoginError && err.cancelled) {
      throw new BiometricError(
        "Biometric authentication was cancelled.",
        "cancelled",
      );
    }
    throw new BiometricError(
      err instanceof PasskeyLoginError
        ? err.message
        : "Biometric authentication failed. Please try again.",
      "authentication-failed",
    );
  }
}

/**
 * Removes a stored biometric credential from this device by id.
 *
 * This only removes the local metadata; the passkey record on the server is
 * unaffected. Call the backend's passkey removal endpoint separately if you
 * also want to revoke the server-side credential.
 */
export function removeBiometricCredential(credentialId: string): void {
  const updated = readStoredCredentials().filter(
    (c) => c.credentialId !== credentialId,
  );
  writeStoredCredentials(updated);
}

/**
 * Removes all locally stored biometric credentials from this device.
 */
export function clearAllBiometricCredentials(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
