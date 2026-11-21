import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateWithBiometric,
  BiometricError,
  clearAllBiometricCredentials,
  getRegisteredCredentials,
  hasBiometricCredential,
  isBiometricSupported,
  registerBiometric,
  removeBiometricCredential,
} from "./biometric";
import { loginWithPasskey, PasskeyLoginError, registerPasskey, PasskeyRegistrationError } from "@/lib/passkey";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: vi.fn(),
}));

vi.mock("@/lib/passkey", () => ({
  loginWithPasskey: vi.fn(),
  registerPasskey: vi.fn(),
  PasskeyLoginError: class PasskeyLoginError extends Error {
    cancelled: boolean;
    constructor(message: string, cancelled = false) {
      super(message);
      this.name = "PasskeyLoginError";
      this.cancelled = cancelled;
    }
  },
  PasskeyRegistrationError: class PasskeyRegistrationError extends Error {
    cancelled: boolean;
    constructor(message: string, cancelled = false) {
      super(message);
      this.name = "PasskeyRegistrationError";
      this.cancelled = cancelled;
    }
  },
}));

const mockBrowserSupportsWebAuthn = vi.mocked(browserSupportsWebAuthn);
const mockLoginWithPasskey = vi.mocked(loginWithPasskey);
const mockRegisterPasskey = vi.mocked(registerPasskey);

const STORAGE_KEY = "stow-biometric-credentials";

function makeRegistrationResult(credentialId = "cred-1") {
  return {
    id: "row-1",
    credential_id: credentialId,
    device_type: "platform",
    backed_up: false,
    created_at: "2026-01-01T12:00:00.000Z",
  };
}

describe("isBiometricSupported", () => {
  it("returns true when browserSupportsWebAuthn returns true", () => {
    mockBrowserSupportsWebAuthn.mockReturnValue(true);
    expect(isBiometricSupported()).toBe(true);
  });

  it("returns false when browserSupportsWebAuthn returns false", () => {
    mockBrowserSupportsWebAuthn.mockReturnValue(false);
    expect(isBiometricSupported()).toBe(false);
  });
});

describe("credential storage helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("getRegisteredCredentials returns [] when nothing is stored", () => {
    expect(getRegisteredCredentials()).toEqual([]);
  });

  it("hasBiometricCredential returns false when nothing is stored", () => {
    expect(hasBiometricCredential()).toBe(false);
  });

  it("getRegisteredCredentials returns stored credentials sorted newest-first", () => {
    const credentials = [
      { credentialId: "cred-1", deviceName: "Phone", registeredAt: "2026-01-01T00:00:00.000Z" },
      { credentialId: "cred-2", deviceName: "Laptop", registeredAt: "2026-06-01T00:00:00.000Z" },
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));

    const result = getRegisteredCredentials();
    expect(result[0].credentialId).toBe("cred-2"); // newer first
    expect(result[1].credentialId).toBe("cred-1");
  });

  it("hasBiometricCredential returns true when credentials exist", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ credentialId: "c", deviceName: "d", registeredAt: "2026-01-01T00:00:00.000Z" }]),
    );
    expect(hasBiometricCredential()).toBe(true);
  });

  it("getRegisteredCredentials gracefully handles malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "not-json");
    expect(getRegisteredCredentials()).toEqual([]);
  });

  it("removeBiometricCredential removes only the targeted credential", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { credentialId: "cred-1", deviceName: "Phone", registeredAt: "2026-01-01T00:00:00.000Z" },
        { credentialId: "cred-2", deviceName: "Laptop", registeredAt: "2026-06-01T00:00:00.000Z" },
      ]),
    );

    removeBiometricCredential("cred-1");

    const remaining = getRegisteredCredentials();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].credentialId).toBe("cred-2");
  });

  it("clearAllBiometricCredentials removes everything", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { credentialId: "cred-1", deviceName: "Phone", registeredAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );

    clearAllBiometricCredentials();
    expect(getRegisteredCredentials()).toEqual([]);
  });
});

describe("registerBiometric", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockBrowserSupportsWebAuthn.mockReturnValue(true);
  });

  it("throws BiometricError(unsupported) when WebAuthn is unavailable", async () => {
    mockBrowserSupportsWebAuthn.mockReturnValue(false);

    await expect(registerBiometric()).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(mockRegisterPasskey).not.toHaveBeenCalled();
  });

  it("completes registration and stores the credential locally", async () => {
    mockRegisterPasskey.mockResolvedValue(makeRegistrationResult("cred-abc"));

    const credential = await registerBiometric("My Phone");

    expect(mockRegisterPasskey).toHaveBeenCalledWith("My Phone", {
      requirePlatformAuthenticator: true,
    });
    expect(credential.credentialId).toBe("cred-abc");
    expect(credential.deviceName).toBe("My Phone");
    expect(credential.registeredAt).toBe("2026-01-01T12:00:00.000Z");

    // Persisted to storage
    const stored = getRegisteredCredentials();
    expect(stored).toHaveLength(1);
    expect(stored[0].credentialId).toBe("cred-abc");
  });

  it("uses 'This device' as the default device name", async () => {
    mockRegisterPasskey.mockResolvedValue(makeRegistrationResult());

    const credential = await registerBiometric();
    expect(mockRegisterPasskey).toHaveBeenCalledWith("This device", expect.anything());
    expect(credential.deviceName).toBe("This device");
  });

  it("deduplicates re-registrations of the same credential id", async () => {
    mockRegisterPasskey.mockResolvedValue(makeRegistrationResult("cred-dup"));

    await registerBiometric("First name");
    await registerBiometric("Updated name");

    const stored = getRegisteredCredentials();
    expect(stored).toHaveLength(1);
    expect(stored[0].deviceName).toBe("Updated name");
  });

  it("throws BiometricError(cancelled) when the user dismisses the prompt", async () => {
    const { PasskeyRegistrationError: Err } = await import("@/lib/passkey");
    mockRegisterPasskey.mockRejectedValue(new Err("cancelled", true));

    await expect(registerBiometric()).rejects.toMatchObject({ code: "cancelled" });
    expect(getRegisteredCredentials()).toHaveLength(0);
  });

  it("throws BiometricError(registration-failed) on a non-cancellation error", async () => {
    const { PasskeyRegistrationError: Err } = await import("@/lib/passkey");
    mockRegisterPasskey.mockRejectedValue(new Err("Server error"));

    await expect(registerBiometric()).rejects.toMatchObject({ code: "registration-failed" });
  });

  it("supports registering credentials from multiple devices", async () => {
    mockRegisterPasskey
      .mockResolvedValueOnce(makeRegistrationResult("cred-phone"))
      .mockResolvedValueOnce(makeRegistrationResult("cred-laptop"));

    await registerBiometric("Phone");
    await registerBiometric("Laptop");

    const stored = getRegisteredCredentials();
    expect(stored).toHaveLength(2);
  });
});

describe("authenticateWithBiometric", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowserSupportsWebAuthn.mockReturnValue(true);
  });

  it("throws BiometricError(unsupported) when WebAuthn is unavailable", async () => {
    mockBrowserSupportsWebAuthn.mockReturnValue(false);

    await expect(authenticateWithBiometric()).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(mockLoginWithPasskey).not.toHaveBeenCalled();
  });

  it("resolves with the session on a successful assertion", async () => {
    const session = {
      access_token: "token-1",
      refresh_token: "refresh-1",
      user: { id: "user-1", stellar_address: "GADDR1" },
    };
    mockLoginWithPasskey.mockResolvedValue(session);

    const result = await authenticateWithBiometric("cred-1");

    expect(mockLoginWithPasskey).toHaveBeenCalledWith({
      requireUserVerification: true,
      credentialId: "cred-1",
    });
    expect(result).toEqual(session);
  });

  it("passes undefined credentialId when none is provided", async () => {
    mockLoginWithPasskey.mockResolvedValue({
      access_token: "t",
      refresh_token: "r",
      user: { id: "u", stellar_address: "G" },
    });

    await authenticateWithBiometric();

    expect(mockLoginWithPasskey).toHaveBeenCalledWith({
      requireUserVerification: true,
      credentialId: undefined,
    });
  });

  it("throws BiometricError(cancelled) when the user dismisses the prompt", async () => {
    const { PasskeyLoginError: Err } = await import("@/lib/passkey");
    mockLoginWithPasskey.mockRejectedValue(new Err("cancelled", true));

    await expect(authenticateWithBiometric()).rejects.toMatchObject({ code: "cancelled" });
  });

  it("throws BiometricError(authentication-failed) on a non-cancellation error", async () => {
    const { PasskeyLoginError: Err } = await import("@/lib/passkey");
    mockLoginWithPasskey.mockRejectedValue(new Err("Passkey not recognised"));

    await expect(authenticateWithBiometric()).rejects.toMatchObject({
      code: "authentication-failed",
    });
  });

  it("throws BiometricError(authentication-failed) for unexpected errors", async () => {
    mockLoginWithPasskey.mockRejectedValue(new Error("network failure"));

    await expect(authenticateWithBiometric()).rejects.toMatchObject({
      code: "authentication-failed",
    });
  });
});
