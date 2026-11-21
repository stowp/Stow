import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BiometricLogin from "./BiometricLogin";
import { useBiometric } from "@/hooks/useBiometric";

vi.mock("@/hooks/useBiometric");

const mockUseBiometric = vi.mocked(useBiometric);

const FAKE_SESSION = {
  access_token: "token-1",
  refresh_token: "refresh-1",
  user: { id: "user-1", stellar_address: "GADDR1" },
};

/** Build a minimal useBiometric return value. `overrides` are merged in. */
function makeHook(overrides: Partial<ReturnType<typeof useBiometric>> = {}): ReturnType<typeof useBiometric> {
  const authenticate = vi.fn().mockResolvedValue(FAKE_SESSION);
  const fallback = vi.fn();
  const register = vi.fn();
  const removeCredential = vi.fn();
  const clearCredentials = vi.fn();
  const reset = vi.fn();

  return {
    isSupported: true,
    hasCredential: true,
    credentials: [
      { credentialId: "cred-1", deviceName: "My Phone", registeredAt: "2026-01-01T00:00:00.000Z" },
    ],
    status: "idle",
    error: null,
    isLoading: false,
    authenticate,
    register,
    removeCredential,
    clearCredentials,
    fallback,
    reset,
    ...overrides,
  };
}

describe("BiometricLogin — visibility", () => {
  it("renders nothing when biometrics are unsupported", () => {
    mockUseBiometric.mockReturnValue(makeHook({ isSupported: false, hasCredential: false }));
    const { container } = render(
      <BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no credential is registered on this device", () => {
    mockUseBiometric.mockReturnValue(makeHook({ hasCredential: false }));
    const { container } = render(
      <BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the biometric button when supported and a credential is registered", () => {
    mockUseBiometric.mockReturnValue(makeHook());
    render(<BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /sign in with biometrics/i }),
    ).toBeInTheDocument();
  });
});

describe("BiometricLogin — authentication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls authenticate and fires onSuccess with the session on a successful login", async () => {
    const authenticate = vi.fn().mockResolvedValue(FAKE_SESSION);
    const onSuccess = vi.fn();
    mockUseBiometric.mockReturnValue(makeHook({ authenticate }));

    render(<BiometricLogin onSuccess={onSuccess} onFallback={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with biometrics/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(FAKE_SESSION));
  });

  it("does not call onSuccess when authenticate returns null (error/cancel)", async () => {
    const authenticate = vi.fn().mockResolvedValue(null);
    const onSuccess = vi.fn();
    mockUseBiometric.mockReturnValue(makeHook({ authenticate }));

    render(<BiometricLogin onSuccess={onSuccess} onFallback={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with biometrics/i }));

    await waitFor(() => expect(authenticate).toHaveBeenCalled());
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("forwards the credentialId prop to authenticate", async () => {
    const authenticate = vi.fn().mockResolvedValue(FAKE_SESSION);
    mockUseBiometric.mockReturnValue(makeHook({ authenticate }));

    render(
      <BiometricLogin
        onSuccess={vi.fn()}
        onFallback={vi.fn()}
        credentialId="cred-xyz"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /sign in with biometrics/i }));

    await waitFor(() =>
      expect(authenticate).toHaveBeenCalledWith("cred-xyz"),
    );
  });

  it("disables the button and shows a loading label while authenticating", () => {
    mockUseBiometric.mockReturnValue(makeHook({ isLoading: true, status: "authenticating" }));

    render(<BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />);
    const button = screen.getByRole("button", { name: /waiting for biometric/i });
    expect(button).toBeDisabled();
  });
});

describe("BiometricLogin — error states", () => {
  it("shows an alert with the error message when status is 'error'", () => {
    mockUseBiometric.mockReturnValue(
      makeHook({ status: "error", error: "Passkey not recognised." }),
    );

    render(<BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Passkey not recognised.");
  });

  it("shows a 'try again' label on the button when status is 'error'", () => {
    mockUseBiometric.mockReturnValue(
      makeHook({ status: "error", error: "Failed." }),
    );

    render(<BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("shows a cancelled hint when status is 'cancelled'", () => {
    mockUseBiometric.mockReturnValue(makeHook({ status: "cancelled", error: null }));

    render(<BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/dismissed/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});

describe("BiometricLogin — fallback to password", () => {
  it("calls fallback() when the 'Use password instead' link is clicked", () => {
    const fallback = vi.fn();
    mockUseBiometric.mockReturnValue(makeHook({ fallback }));

    render(<BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /use password instead/i }));

    expect(fallback).toHaveBeenCalled();
  });

  it("fires onFallback when status changes to 'fallback'", async () => {
    const onFallback = vi.fn();
    // Start idle, then re-render with fallback status to simulate the hook update.
    const { rerender } = render(
      <BiometricLogin onSuccess={vi.fn()} onFallback={onFallback} />,
    );
    // Now simulate the hook returning fallback status (as would happen after fallback() is called).
    mockUseBiometric.mockReturnValue(makeHook({ status: "fallback" }));
    rerender(<BiometricLogin onSuccess={vi.fn()} onFallback={onFallback} />);

    await waitFor(() => expect(onFallback).toHaveBeenCalled());
  });
});

describe("BiometricLogin — autoPrompt", () => {
  it("triggers authenticate automatically on mount when autoPrompt is true", async () => {
    const authenticate = vi.fn().mockResolvedValue(FAKE_SESSION);
    const onSuccess = vi.fn();
    mockUseBiometric.mockReturnValue(makeHook({ authenticate }));

    render(
      <BiometricLogin onSuccess={onSuccess} onFallback={vi.fn()} autoPrompt />,
    );

    await waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
    expect(onSuccess).toHaveBeenCalledWith(FAKE_SESSION);
  });

  it("does not auto-prompt when isSupported is false", async () => {
    const authenticate = vi.fn();
    mockUseBiometric.mockReturnValue(
      makeHook({ authenticate, isSupported: false, hasCredential: false }),
    );

    render(
      <BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} autoPrompt />,
    );

    await act(async () => {});
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("does not auto-prompt when hasCredential is false", async () => {
    const authenticate = vi.fn();
    mockUseBiometric.mockReturnValue(
      makeHook({ authenticate, hasCredential: false }),
    );

    render(
      <BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} autoPrompt />,
    );

    await act(async () => {});
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("does not auto-prompt when autoPrompt is false (default)", async () => {
    const authenticate = vi.fn();
    mockUseBiometric.mockReturnValue(makeHook({ authenticate }));

    render(<BiometricLogin onSuccess={vi.fn()} onFallback={vi.fn()} />);

    await act(async () => {});
    expect(authenticate).not.toHaveBeenCalled();
  });
});
