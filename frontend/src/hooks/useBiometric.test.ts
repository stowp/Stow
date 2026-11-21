import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBiometric } from "./useBiometric";
import {
  authenticateWithBiometric,
  clearAllBiometricCredentials,
  getRegisteredCredentials,
  hasBiometricCredential,
  isBiometricSupported,
  registerBiometric,
  removeBiometricCredential,
  BiometricError,
} from "@/lib/biometric";

vi.mock("@/lib/biometric", () => ({
  isBiometricSupported: vi.fn(),
  hasBiometricCredential: vi.fn(),
  getRegisteredCredentials: vi.fn(),
  authenticateWithBiometric: vi.fn(),
  registerBiometric: vi.fn(),
  removeBiometricCredential: vi.fn(),
  clearAllBiometricCredentials: vi.fn(),
  BiometricError: class BiometricError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "BiometricError";
      this.code = code;
    }
  },
}));

const mockIsBiometricSupported = vi.mocked(isBiometricSupported);
const mockHasBiometricCredential = vi.mocked(hasBiometricCredential);
const mockGetRegisteredCredentials = vi.mocked(getRegisteredCredentials);
const mockAuthenticateWithBiometric = vi.mocked(authenticateWithBiometric);
const mockRegisterBiometric = vi.mocked(registerBiometric);
const mockRemoveBiometricCredential = vi.mocked(removeBiometricCredential);
const mockClearAllBiometricCredentials = vi.mocked(clearAllBiometricCredentials);

const FAKE_CREDENTIAL = {
  credentialId: "cred-1",
  deviceName: "My Phone",
  registeredAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_SESSION = {
  access_token: "token-1",
  refresh_token: "refresh-1",
  user: { id: "user-1", stellar_address: "GADDR1" },
};

function setupSupported(withCredential = true) {
  mockIsBiometricSupported.mockReturnValue(true);
  mockHasBiometricCredential.mockReturnValue(withCredential);
  mockGetRegisteredCredentials.mockReturnValue(withCredential ? [FAKE_CREDENTIAL] : []);
}

function setupUnsupported() {
  mockIsBiometricSupported.mockReturnValue(false);
  mockHasBiometricCredential.mockReturnValue(false);
  mockGetRegisteredCredentials.mockReturnValue([]);
}

describe("useBiometric — initial state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reflects supported + credential enrolled", () => {
    setupSupported();
    const { result } = renderHook(() => useBiometric());

    expect(result.current.isSupported).toBe(true);
    expect(result.current.hasCredential).toBe(true);
    expect(result.current.credentials).toEqual([FAKE_CREDENTIAL]);
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("reflects unsupported browser", () => {
    setupUnsupported();
    const { result } = renderHook(() => useBiometric());

    expect(result.current.isSupported).toBe(false);
    expect(result.current.hasCredential).toBe(false);
    expect(result.current.status).toBe("unsupported");
  });

  it("reflects supported but no credential enrolled", () => {
    setupSupported(false);
    const { result } = renderHook(() => useBiometric());

    expect(result.current.isSupported).toBe(true);
    expect(result.current.hasCredential).toBe(false);
    expect(result.current.status).toBe("idle");
  });
});

describe("useBiometric — authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSupported();
  });

  it("sets status to 'authenticating' while the ceremony runs and 'success' on completion", async () => {
    let resolveAuth!: (v: typeof FAKE_SESSION) => void;
    mockAuthenticateWithBiometric.mockReturnValue(
      new Promise((res) => { resolveAuth = res; }),
    );

    const { result } = renderHook(() => useBiometric());

    act(() => { void result.current.authenticate(); });
    expect(result.current.status).toBe("authenticating");
    expect(result.current.isLoading).toBe(true);

    await act(async () => { resolveAuth(FAKE_SESSION); });
    expect(result.current.status).toBe("success");
    expect(result.current.isLoading).toBe(false);
  });

  it("returns the session result on success", async () => {
    mockAuthenticateWithBiometric.mockResolvedValue(FAKE_SESSION);

    const { result } = renderHook(() => useBiometric());
    let returnValue: typeof FAKE_SESSION | null | undefined;

    await act(async () => {
      returnValue = await result.current.authenticate("cred-1");
    });

    expect(returnValue).toEqual(FAKE_SESSION);
    expect(mockAuthenticateWithBiometric).toHaveBeenCalledWith("cred-1");
  });

  it("uses the most-recently enrolled credential when none is specified", async () => {
    mockAuthenticateWithBiometric.mockResolvedValue(FAKE_SESSION);

    const { result } = renderHook(() => useBiometric());
    await act(async () => { await result.current.authenticate(); });

    expect(mockAuthenticateWithBiometric).toHaveBeenCalledWith("cred-1");
  });

  it("sets status to 'cancelled' and returns null when the user dismisses", async () => {
    const { BiometricError: Err } = await import("@/lib/biometric");
    mockAuthenticateWithBiometric.mockRejectedValue(new Err("cancelled", "cancelled"));

    const { result } = renderHook(() => useBiometric());
    let returnValue: typeof FAKE_SESSION | null | undefined;

    await act(async () => {
      returnValue = await result.current.authenticate();
    });

    expect(result.current.status).toBe("cancelled");
    expect(result.current.error).toBeNull();
    expect(returnValue).toBeNull();
  });

  it("sets status to 'error' and surfaces the message on authentication failure", async () => {
    const { BiometricError: Err } = await import("@/lib/biometric");
    mockAuthenticateWithBiometric.mockRejectedValue(
      new Err("Passkey not recognised.", "authentication-failed"),
    );

    const { result } = renderHook(() => useBiometric());
    await act(async () => { await result.current.authenticate(); });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Passkey not recognised.");
  });

  it("sets status to 'unsupported' when BiometricError code is unsupported", async () => {
    const { BiometricError: Err } = await import("@/lib/biometric");
    mockAuthenticateWithBiometric.mockRejectedValue(
      new Err("Not supported", "unsupported"),
    );

    const { result } = renderHook(() => useBiometric());
    await act(async () => { await result.current.authenticate(); });

    expect(result.current.status).toBe("unsupported");
  });

  it("falls back to a generic error message for unexpected throws", async () => {
    mockAuthenticateWithBiometric.mockRejectedValue(new Error("network failure"));

    const { result } = renderHook(() => useBiometric());
    await act(async () => { await result.current.authenticate(); });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("failed");
  });
});

describe("useBiometric — register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSupported();
  });

  it("sets status to 'registering' during registration", async () => {
    let resolveReg!: (v: typeof FAKE_CREDENTIAL) => void;
    mockRegisterBiometric.mockReturnValue(
      new Promise((res) => { resolveReg = res; }),
    );

    const { result } = renderHook(() => useBiometric());

    act(() => { void result.current.register("My Phone"); });
    expect(result.current.status).toBe("registering");
    expect(result.current.isLoading).toBe(true);

    await act(async () => { resolveReg(FAKE_CREDENTIAL); });
    expect(result.current.status).toBe("idle");
  });

  it("returns the new credential and refreshes the credential list", async () => {
    mockRegisterBiometric.mockResolvedValue(FAKE_CREDENTIAL);
    const newList = [FAKE_CREDENTIAL, { ...FAKE_CREDENTIAL, credentialId: "cred-2", deviceName: "Laptop" }];
    mockGetRegisteredCredentials
      .mockReturnValueOnce([FAKE_CREDENTIAL]) // initial render
      .mockReturnValueOnce(newList);           // after register

    const { result } = renderHook(() => useBiometric());
    let credential: typeof FAKE_CREDENTIAL | null | undefined;

    await act(async () => {
      credential = await result.current.register("My Phone");
    });

    expect(credential).toEqual(FAKE_CREDENTIAL);
    expect(mockRegisterBiometric).toHaveBeenCalledWith("My Phone");
  });

  it("sets status to 'cancelled' when registration is dismissed", async () => {
    const { BiometricError: Err } = await import("@/lib/biometric");
    mockRegisterBiometric.mockRejectedValue(new Err("cancelled", "cancelled"));

    const { result } = renderHook(() => useBiometric());
    await act(async () => { await result.current.register(); });

    expect(result.current.status).toBe("cancelled");
    expect(result.current.error).toBeNull();
  });

  it("sets status to 'error' on registration failure", async () => {
    const { BiometricError: Err } = await import("@/lib/biometric");
    mockRegisterBiometric.mockRejectedValue(
      new Err("Server rejected", "registration-failed"),
    );

    const { result } = renderHook(() => useBiometric());
    await act(async () => { await result.current.register(); });

    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("Server rejected");
  });
});

describe("useBiometric — credential management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSupported();
  });

  it("removeCredential calls the library function and refreshes the list", () => {
    const updatedList = [{ ...FAKE_CREDENTIAL, credentialId: "cred-2", deviceName: "Laptop" }];
    mockGetRegisteredCredentials
      .mockReturnValueOnce([FAKE_CREDENTIAL])
      .mockReturnValueOnce(updatedList);

    const { result } = renderHook(() => useBiometric());

    act(() => { result.current.removeCredential("cred-1"); });

    expect(mockRemoveBiometricCredential).toHaveBeenCalledWith("cred-1");
    expect(result.current.credentials).toEqual(updatedList);
  });

  it("clearCredentials empties the credential list", () => {
    const { result } = renderHook(() => useBiometric());

    act(() => { result.current.clearCredentials(); });

    expect(mockClearAllBiometricCredentials).toHaveBeenCalled();
    expect(result.current.credentials).toEqual([]);
  });
});

describe("useBiometric — fallback and reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSupported();
  });

  it("fallback() sets status to 'fallback'", () => {
    const { result } = renderHook(() => useBiometric());

    act(() => { result.current.fallback(); });

    expect(result.current.status).toBe("fallback");
    expect(result.current.error).toBeNull();
  });

  it("reset() returns status to 'idle' and clears the error", async () => {
    const { BiometricError: Err } = await import("@/lib/biometric");
    mockAuthenticateWithBiometric.mockRejectedValue(
      new Err("failed", "authentication-failed"),
    );

    const { result } = renderHook(() => useBiometric());
    await act(async () => { await result.current.authenticate(); });
    expect(result.current.status).toBe("error");

    act(() => { result.current.reset(); });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("reset() sets status to 'unsupported' when the browser is unsupported", () => {
    setupUnsupported();
    const { result } = renderHook(() => useBiometric());

    act(() => { result.current.reset(); });

    expect(result.current.status).toBe("unsupported");
  });
});
