/**
 * useVoiceCommands.test.ts
 *
 * Tests for the useVoiceCommands hook covering:
 * - Balance command: mock balance source, correct feedback text
 * - Deposit / withdraw: confirmation flow, cancel, timeout, invalid amounts
 * - Accessibility mode: live region used, speechSynthesis NOT called
 * - Wake word: commands before wake word are ignored; after it, accepted
 * - Unsupported browser fallback
 *
 * Real timers are used throughout (fake timers break testing-library's
 * waitFor polling). The confirmation-timeout test uses a short
 * confirmTimeoutMs so it resolves in milliseconds.
 */

import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useVoiceCommands } from "./useVoiceCommands";
import type { SpeechRecognitionCtor } from "@/lib/voiceAssistant";

// ---------------------------------------------------------------------------
// Fake SpeechRecognition
// ---------------------------------------------------------------------------

class FakeRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;

  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;

  start = vi.fn();
  stop = vi.fn();

  fireResult(transcript: string) {
    this.onresult?.({
      results: [
        Object.assign([{ transcript, confidence: 1 }], { isFinal: true }),
      ],
    } as unknown as SpeechRecognitionEvent);
  }

  fireError(error: string) {
    this.onerror?.({ error } as unknown as SpeechRecognitionErrorEvent);
  }
}

type FakeCtor = { new (): FakeRecognition } & { instances: FakeRecognition[] };

function makeFakeCtor(): FakeCtor {
  const instances: FakeRecognition[] = [];
  class Fake extends FakeRecognition {
    constructor() {
      super();
      instances.push(this);
    }
  }
  (Fake as unknown as FakeCtor).instances = instances;
  return Fake as unknown as FakeCtor;
}

function makeSynthesisMock() {
  return { cancel: vi.fn(), speak: vi.fn() } as unknown as SpeechSynthesis;
}

function latestInstance(Ctor: FakeCtor): FakeRecognition {
  const instances = (Ctor as unknown as { instances: FakeRecognition[] }).instances;
  return instances[instances.length - 1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useVoiceCommands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports isSupported:false when recognitionCtor is null", () => {
    const { result } = renderHook(() =>
      useVoiceCommands({ recognitionCtor: null, synthesisMock: null }),
    );
    expect(result.current.isSupported).toBe(false);
  });

  it("reports isSupported:true when a recognitionCtor is provided", () => {
    const Ctor = makeFakeCtor();
    const { result } = renderHook(() =>
      useVoiceCommands({ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }),
    );
    expect(result.current.isSupported).toBe(true);
  });

  it("starts in idle status", () => {
    const Ctor = makeFakeCtor();
    const { result } = renderHook(() =>
      useVoiceCommands({ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }),
    );
    expect(result.current.status).toBe("idle");
  });

  // --- balance command ---

  it("feedback message contains the balance on a 'check balance' command", async () => {
    const Ctor = makeFakeCtor();
    const synthesis = makeSynthesisMock();
    const onBalance = vi.fn().mockResolvedValue("100 XLM");

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onBalance,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: synthesis,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("check balance"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/100 XLM/);
    });
    expect(onBalance).toHaveBeenCalledOnce();
  });

  it("feedback message is 'Balance is unavailable' when onBalance returns null", async () => {
    const Ctor = makeFakeCtor();
    const onBalance = vi.fn().mockResolvedValue(null);

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onBalance,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("check balance"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/unavailable/i);
    });
  });

  // --- speechSynthesis called in normal mode ---

  it("calls speechSynthesis.speak for balance feedback in normal mode", async () => {
    const Ctor = makeFakeCtor();
    const synthesis = makeSynthesisMock();
    const onBalance = vi.fn().mockResolvedValue("42 XLM");

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onBalance,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: synthesis,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("check balance"); });

    await waitFor(() => {
      expect(synthesis.speak).toHaveBeenCalled();
    });
  });

  // --- accessibility mode ---

  it("does NOT call speechSynthesis in accessibility mode", async () => {
    const Ctor = makeFakeCtor();
    const synthesis = makeSynthesisMock();
    const onBalance = vi.fn().mockResolvedValue("42 XLM");

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onBalance,
        accessibilityMode: true,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: synthesis,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("check balance"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/42 XLM/);
    });
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  // --- deposit confirmation flow ---

  it("shows a confirmation prompt for deposit; executes after confirm", async () => {
    const Ctor = makeFakeCtor();
    const onDeposit = vi.fn().mockResolvedValue("Deposit initiated.");

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onDeposit,
        confirmTimeoutMs: 60000,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("deposit 100"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/deposit 100/i);
      expect(result.current.feedbackMessage).toMatch(/confirm/i);
    });

    // Now say "confirm"
    act(() => { latestInstance(Ctor).fireResult("confirm"); });

    await waitFor(() => {
      expect(onDeposit).toHaveBeenCalledWith("100");
    });
    await waitFor(() => {
      expect(result.current.feedbackMessage).toBe("Deposit initiated.");
    });
  });

  it("cancels a deposit when user says 'cancel'", async () => {
    const Ctor = makeFakeCtor();
    const onDeposit = vi.fn();

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onDeposit,
        confirmTimeoutMs: 60000,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("deposit 100"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/confirm/i);
    });

    act(() => { latestInstance(Ctor).fireResult("cancel"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/cancelled/i);
    });
    expect(onDeposit).not.toHaveBeenCalled();
  });

  it("auto-cancels a deposit after the confirmation timeout and does NOT call onDeposit", async () => {
    const Ctor = makeFakeCtor();
    const onDeposit = vi.fn();

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onDeposit,
        confirmTimeoutMs: 100,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("deposit 100"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/confirm/i);
    });

    // Wait for the short (100ms) confirm timeout to fire and auto-cancel.
    await waitFor(
      () => {
        expect(result.current.status).toBe("idle");
      },
      { timeout: 2000 },
    );
    expect(onDeposit).not.toHaveBeenCalled();
  });

  // --- withdraw confirmation flow ---

  it("shows a confirmation prompt for withdraw; executes after confirm", async () => {
    const Ctor = makeFakeCtor();
    const onWithdraw = vi.fn().mockResolvedValue("Withdrawal complete.");

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onWithdraw,
        confirmTimeoutMs: 60000,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("withdraw 50"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/withdraw 50/i);
    });

    act(() => { latestInstance(Ctor).fireResult("confirm"); });

    await waitFor(() => {
      expect(onWithdraw).toHaveBeenCalledWith("50");
    });
  });

  // --- invalid amounts ---

  it("rejects a zero amount (treated as unrecognized) without calling onDeposit", async () => {
    const Ctor = makeFakeCtor();
    const onDeposit = vi.fn();

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onDeposit,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    // "deposit 0" — parseAmount returns null for 0, so command is unrecognized
    act(() => { latestInstance(Ctor).fireResult("deposit 0"); });

    await waitFor(() => {
      expect(result.current.lastCommand?.type).toBe("unrecognized");
    });
    expect(onDeposit).not.toHaveBeenCalled();
  });

  it("rejects an absurdly large amount with a feedback message", async () => {
    const Ctor = makeFakeCtor();
    const onDeposit = vi.fn();

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onDeposit,
        confirmTimeoutMs: 60000,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("deposit 9999999"); });

    await waitFor(() => {
      expect(result.current.feedbackMessage).toMatch(/too large/i);
    });
    expect(onDeposit).not.toHaveBeenCalled();
  });

  // --- wake word ---

  it("ignores commands that arrive before the wake word", async () => {
    const Ctor = makeFakeCtor();
    const onBalance = vi.fn().mockResolvedValue("100 XLM");

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onBalance,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startWakeWordListening(); });
    // Speak a command without the wake word first
    act(() => { latestInstance(Ctor).fireResult("check balance"); });

    // Should still be waiting for the wake word
    await waitFor(() => {
      expect(result.current.status).toBe("listening-wake");
    });
    expect(onBalance).not.toHaveBeenCalled();
  });

  it("accepts a command after the wake word is heard", async () => {
    const Ctor = makeFakeCtor();
    const onBalance = vi.fn().mockResolvedValue("100 XLM");

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onBalance,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startWakeWordListening(); });
    act(() => { latestInstance(Ctor).fireResult("hey stow"); });

    await waitFor(() => {
      expect(result.current.status).toBe("listening-command");
    });

    act(() => { latestInstance(Ctor).fireResult("check balance"); });

    await waitFor(() => {
      expect(onBalance).toHaveBeenCalledOnce();
    });
  });

  // --- stop ---

  it("stop() sets status to idle", () => {
    const Ctor = makeFakeCtor();
    const { result } = renderHook(() =>
      useVoiceCommands({ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }),
    );

    act(() => { result.current.startCommandListening(); });
    expect(result.current.status).toBe("listening-command");

    act(() => { result.current.stop(); });
    expect(result.current.status).toBe("idle");
  });

  // --- error surfaces ---

  it("sets errorMessage on a 'not-allowed' speech error", async () => {
    const Ctor = makeFakeCtor();

    const { result } = renderHook(() =>
      useVoiceCommands({ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireError("not-allowed"); });

    await waitFor(() => {
      expect(result.current.errorMessage).toMatch(/microphone/i);
      expect(result.current.status).toBe("error");
    });
  });

  // --- lastTranscript ---

  it("exposes the last transcript", async () => {
    const Ctor = makeFakeCtor();
    const onBalance = vi.fn().mockResolvedValue("5 XLM");

    const { result } = renderHook(() =>
      useVoiceCommands({
        lang: "en",
        onBalance,
        recognitionCtor: Ctor as unknown as SpeechRecognitionCtor,
        synthesisMock: null,
      }),
    );

    act(() => { result.current.startCommandListening(); });
    act(() => { latestInstance(Ctor).fireResult("check balance"); });

    await waitFor(() => {
      expect(result.current.lastTranscript).toBe("check balance");
    });
  });
});
