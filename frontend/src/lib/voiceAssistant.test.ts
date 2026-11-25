/**
 * voiceAssistant.test.ts
 *
 * Unit tests for the pure functions and state machine in voiceAssistant.ts.
 * No browser APIs are required: all SpeechRecognition / speechSynthesis
 * objects are injected as fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseNumberWords,
  parseAmount,
  parseVoiceCommand,
  containsWakeWord,
  speak,
  VoiceAssistant,
  detectSpeechSupport,
  type VoiceCommand,
  type VoiceAssistantState,
  type SpeechRecognitionCtor,
} from "./voiceAssistant";

// ---------------------------------------------------------------------------
// parseNumberWords
// ---------------------------------------------------------------------------

describe("parseNumberWords", () => {
  it("parses simple English number words", () => {
    expect(parseNumberWords("one", "en")).toBe(1);
    expect(parseNumberWords("ten", "en")).toBe(10);
    expect(parseNumberWords("twenty", "en")).toBe(20);
    expect(parseNumberWords("one hundred", "en")).toBe(100);
    expect(parseNumberWords("one hundred fifty", "en")).toBe(150);
    expect(parseNumberWords("two hundred and fifty", "en")).toBe(250);
    expect(parseNumberWords("one thousand", "en")).toBe(1000);
  });

  it("parses Spanish number words", () => {
    expect(parseNumberWords("cien", "es")).toBe(100);
    expect(parseNumberWords("cincuenta", "es")).toBe(50);
    expect(parseNumberWords("dos", "es")).toBe(2);
  });

  it("parses French number words", () => {
    expect(parseNumberWords("cent", "fr")).toBe(100);
    expect(parseNumberWords("vingt", "fr")).toBe(20);
    expect(parseNumberWords("cinq", "fr")).toBe(5);
  });

  it("returns null for unrecognized text", () => {
    expect(parseNumberWords("hello world", "en")).toBeNull();
    expect(parseNumberWords("   ", "en")).toBeNull();
  });

  it("falls back to English for unknown locale", () => {
    expect(parseNumberWords("fifty", "de")).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// parseAmount
// ---------------------------------------------------------------------------

describe("parseAmount", () => {
  it("parses plain integers", () => {
    expect(parseAmount("100")).toBe(100);
    expect(parseAmount("50")).toBe(50);
    expect(parseAmount("1")).toBe(1);
  });

  it("parses decimal amounts with period", () => {
    expect(parseAmount("12.50")).toBe(12.5);
    expect(parseAmount("0.5")).toBe(0.5);
  });

  it("parses decimal amounts with comma", () => {
    expect(parseAmount("12,50")).toBe(12.5);
  });

  it("strips currency noise words", () => {
    expect(parseAmount("100 dollars")).toBe(100);
    expect(parseAmount("50 usdc")).toBe(50);
    expect(parseAmount("25 xlm")).toBe(25);
  });

  it("parses number words", () => {
    expect(parseAmount("one hundred", "en")).toBe(100);
    expect(parseAmount("fifty dollars", "en")).toBe(50);
  });

  it("returns null for zero", () => {
    expect(parseAmount("0")).toBeNull();
  });

  it("returns null for empty/garbage", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("hello")).toBeNull();
    expect(parseAmount("abc xyz")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseVoiceCommand — English
// ---------------------------------------------------------------------------

describe("parseVoiceCommand (en)", () => {
  const cases: [string, Partial<VoiceCommand>][] = [
    ["check balance", { type: "balance" }],
    ["my balance", { type: "balance" }],
    ["balance", { type: "balance" }],
    ["how much do i have", { type: "balance" }],
    ["deposit 100", { type: "deposit", amount: 100 }],
    ["deposit one hundred", { type: "deposit", amount: 100 }],
    ["deposit 50.50", { type: "deposit", amount: 50.5 }],
    ["put in 200", { type: "deposit", amount: 200 }],
    ["withdraw 50", { type: "withdraw", amount: 50 }],
    ["withdraw one hundred fifty", { type: "withdraw", amount: 150 }],
    ["take out 25", { type: "withdraw", amount: 25 }],
    ["confirm", { type: "confirm" }],
    ["yes", { type: "confirm" }],
    ["okay", { type: "confirm" }],
    ["cancel", { type: "cancel" }],
    ["no", { type: "cancel" }],
    ["stop", { type: "cancel" }],
  ];

  it.each(cases)('"%s" -> %s', (input, expected) => {
    const result = parseVoiceCommand(input, "en");
    for (const [k, v] of Object.entries(expected)) {
      expect(result[k as keyof VoiceCommand]).toBe(v);
    }
  });

  it("returns unrecognized for gibberish", () => {
    const result = parseVoiceCommand("asdf qwerty", "en");
    expect(result.type).toBe("unrecognized");
    if (result.type === "unrecognized") {
      expect(result.transcript).toBe("asdf qwerty");
    }
  });

  it("deposit without an amount returns unrecognized", () => {
    // "deposit" alone has no parseable amount
    const result = parseVoiceCommand("deposit", "en");
    expect(result.type).toBe("unrecognized");
  });

  it("is case-insensitive", () => {
    expect(parseVoiceCommand("CHECK BALANCE", "en").type).toBe("balance");
    expect(parseVoiceCommand("DEPOSIT 100", "en")).toEqual({ type: "deposit", amount: 100 });
  });
});

// ---------------------------------------------------------------------------
// parseVoiceCommand — Spanish
// ---------------------------------------------------------------------------

describe("parseVoiceCommand (es)", () => {
  it("recognizes 'saldo'", () => {
    expect(parseVoiceCommand("saldo", "es").type).toBe("balance");
  });
  it("recognizes 'depositar 100'", () => {
    const r = parseVoiceCommand("depositar 100", "es");
    expect(r).toEqual({ type: "deposit", amount: 100 });
  });
  it("recognizes 'retirar 50'", () => {
    const r = parseVoiceCommand("retirar 50", "es");
    expect(r).toEqual({ type: "withdraw", amount: 50 });
  });
  it("recognizes 'confirmar'", () => {
    expect(parseVoiceCommand("confirmar", "es").type).toBe("confirm");
  });
  it("recognizes 'cancelar'", () => {
    expect(parseVoiceCommand("cancelar", "es").type).toBe("cancel");
  });
});

// ---------------------------------------------------------------------------
// parseVoiceCommand — French
// ---------------------------------------------------------------------------

describe("parseVoiceCommand (fr)", () => {
  it("recognizes 'solde'", () => {
    expect(parseVoiceCommand("solde", "fr").type).toBe("balance");
  });
  it("recognizes 'déposer 100'", () => {
    const r = parseVoiceCommand("déposer 100", "fr");
    expect(r).toEqual({ type: "deposit", amount: 100 });
  });
  it("recognizes 'retirer 50'", () => {
    const r = parseVoiceCommand("retirer 50", "fr");
    expect(r).toEqual({ type: "withdraw", amount: 50 });
  });
  it("recognizes 'confirmer'", () => {
    expect(parseVoiceCommand("confirmer", "fr").type).toBe("confirm");
  });
  it("recognizes 'annuler'", () => {
    expect(parseVoiceCommand("annuler", "fr").type).toBe("cancel");
  });
});

// ---------------------------------------------------------------------------
// containsWakeWord
// ---------------------------------------------------------------------------

describe("containsWakeWord", () => {
  it("detects 'hey stow' in a transcript", () => {
    expect(containsWakeWord("Hey Stow, check my balance", "en")).toBe(true);
    expect(containsWakeWord("hey stow", "en")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(containsWakeWord("HEY STOW deposit 100", "en")).toBe(true);
  });

  it("returns false when wake word is absent", () => {
    expect(containsWakeWord("check balance", "en")).toBe(false);
    expect(containsWakeWord("hello there", "en")).toBe(false);
  });

  it("detects Spanish wake word", () => {
    expect(containsWakeWord("oye stow depositar", "es")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// speak
// ---------------------------------------------------------------------------

describe("speak", () => {
  it("calls synthesis.cancel() then synthesis.speak() with the right text", () => {
    const cancel = vi.fn();
    const speakFn = vi.fn();
    const synthesisMock = { cancel, speak: speakFn } as unknown as SpeechSynthesis;

    speak("Hello", synthesisMock, { lang: "en-US" });

    expect(cancel).toHaveBeenCalledOnce();
    expect(speakFn).toHaveBeenCalledOnce();
    const utterance: SpeechSynthesisUtterance = speakFn.mock.calls[0][0];
    expect(utterance.text).toBe("Hello");
    expect(utterance.lang).toBe("en-US");
  });

  it("sets the lang on the utterance", () => {
    const speakFn = vi.fn();
    const synthesisMock = { cancel: vi.fn(), speak: speakFn } as unknown as SpeechSynthesis;
    speak("Bonjour", synthesisMock, { lang: "fr-FR" });
    const utterance: SpeechSynthesisUtterance = speakFn.mock.calls[0][0];
    expect(utterance.lang).toBe("fr-FR");
  });
});

// ---------------------------------------------------------------------------
// detectSpeechSupport
// ---------------------------------------------------------------------------

describe("detectSpeechSupport", () => {
  it("returns false for both when neither API is present (jsdom default)", () => {
    const support = detectSpeechSupport();
    // jsdom doesn't ship with SpeechRecognition; both should be false
    expect(support.recognition).toBe(false);
    expect(support.synthesis).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VoiceAssistant state machine
// ---------------------------------------------------------------------------

/**
 * Minimal SpeechRecognition fake.
 * Calling start() records the fact; we can call onresult/onerror/onend
 * manually from tests to simulate browser events.
 */
class FakeRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;

  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;

  started = false;
  stopped = false;

  start() { this.started = true; }
  stop() { this.stopped = true; }

  /** Simulate the browser producing a transcript. */
  simulateResult(transcript: string) {
    this.onresult?.({
      results: [
        Object.assign([{ transcript, confidence: 1 }], { isFinal: true }),
      ],
    } as unknown as SpeechRecognitionEvent);
  }

  simulateError(error: string) {
    this.onerror?.({ error } as unknown as SpeechRecognitionErrorEvent);
  }

  simulateEnd() {
    this.onend?.();
  }
}

/** Fake constructor that tracks all instances created. */
function makeFakeCtor(): { Ctor: SpeechRecognitionCtor; instances: FakeRecognition[] } {
  const instances: FakeRecognition[] = [];
  class FakeCtor extends FakeRecognition {
    constructor() {
      super();
      instances.push(this);
    }
  }
  return { Ctor: FakeCtor as unknown as SpeechRecognitionCtor, instances };
}

function makeSynthesisMock() {
  return {
    cancel: vi.fn(),
    speak: vi.fn(),
  } as unknown as SpeechSynthesis;
}

describe("VoiceAssistant", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in idle state", () => {
    const { Ctor } = makeFakeCtor();
    const assistant = new VoiceAssistant(Ctor, null);
    expect(assistant.currentState).toBe("idle");
  });

  it("transitions to listening-wake when startWakeWordListening() is called", () => {
    const { Ctor, instances } = makeFakeCtor();
    const stateChanges: VoiceAssistantState[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onStateChange: (s) => stateChanges.push(s),
    });
    assistant.startWakeWordListening();
    expect(assistant.currentState).toBe("listening-wake");
    expect(instances.length).toBe(1);
    expect(instances[0].continuous).toBe(true);
  });

  it("transitions to listening-command when startCommandListening() is called", () => {
    const { Ctor, instances } = makeFakeCtor();
    const assistant = new VoiceAssistant(Ctor, null);
    assistant.startCommandListening();
    expect(assistant.currentState).toBe("listening-command");
    expect(instances[0].continuous).toBe(false);
  });

  it("ignores transcripts in wake-word mode that don't contain the wake word", () => {
    const { Ctor, instances } = makeFakeCtor();
    const commands: VoiceCommand[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onCommand: (c) => commands.push(c),
    });
    assistant.startWakeWordListening();
    instances[0].simulateResult("check balance");
    expect(commands).toHaveLength(0);
    expect(assistant.currentState).toBe("listening-wake");
  });

  it("transitions to listening-command after hearing the wake word", () => {
    const { Ctor, instances } = makeFakeCtor();
    const stateChanges: VoiceAssistantState[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onStateChange: (s) => stateChanges.push(s),
    });
    assistant.startWakeWordListening();
    instances[0].simulateResult("hey stow check my balance");

    // A new recognition should have been started in non-continuous mode
    expect(instances.length).toBe(2);
    expect(instances[1].continuous).toBe(false);
    expect(assistant.currentState).toBe("listening-command");
  });

  it("parses a command transcript after the wake word", () => {
    const { Ctor, instances } = makeFakeCtor();
    const commands: VoiceCommand[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onCommand: (c) => commands.push(c),
    });
    assistant.startWakeWordListening();
    instances[0].simulateResult("hey stow");
    instances[1].simulateResult("check balance");

    expect(commands).toEqual([{ type: "balance" }]);
    expect(assistant.currentState).toBe("idle");
  });

  it("parses a command directly in startCommandListening mode", () => {
    const { Ctor, instances } = makeFakeCtor();
    const commands: VoiceCommand[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onCommand: (c) => commands.push(c),
    });
    assistant.startCommandListening();
    instances[0].simulateResult("check balance");
    expect(commands).toEqual([{ type: "balance" }]);
  });

  it("enters awaiting-confirmation for a deposit command and emits onConfirmed on confirm", () => {
    const { Ctor, instances } = makeFakeCtor();
    const commands: VoiceCommand[] = [];
    const confirmed: VoiceCommand[] = [];
    const stateChanges: VoiceAssistantState[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onCommand: (c) => commands.push(c),
      onConfirmed: (c) => confirmed.push(c),
      onStateChange: (s) => stateChanges.push(s),
    });

    assistant.awaitConfirmation({ type: "deposit", amount: 100 });
    expect(assistant.currentState).toBe("awaiting-confirmation");

    // User says "confirm"
    const confirmInstance = instances[instances.length - 1];
    confirmInstance.simulateResult("confirm");

    // The confirmed money command routes through onConfirmed, not onCommand.
    expect(confirmed).toEqual([{ type: "deposit", amount: 100 }]);
    expect(commands).toHaveLength(0);
    expect(assistant.currentState).toBe("idle");
  });

  it("cancels the pending command when user says 'cancel' (emits cancel via onCommand)", () => {
    const { Ctor, instances } = makeFakeCtor();
    const commands: VoiceCommand[] = [];
    const confirmed: VoiceCommand[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onCommand: (c) => commands.push(c),
      onConfirmed: (c) => confirmed.push(c),
    });

    assistant.awaitConfirmation({ type: "withdraw", amount: 50 });
    const rec = instances[instances.length - 1];
    rec.simulateResult("cancel");

    expect(commands).toEqual([{ type: "cancel" }]);
    expect(confirmed).toHaveLength(0);
    expect(assistant.currentState).toBe("idle");
  });

  it("auto-cancels after the confirmation timeout (cancel via onCommand)", () => {
    const { Ctor } = makeFakeCtor();
    const commands: VoiceCommand[] = [];
    const confirmed: VoiceCommand[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onCommand: (c) => commands.push(c),
      onConfirmed: (c) => confirmed.push(c),
    });

    assistant.awaitConfirmation({ type: "deposit", amount: 100 }, 10000);
    expect(assistant.currentState).toBe("awaiting-confirmation");

    vi.advanceTimersByTime(10001);

    expect(commands).toEqual([{ type: "cancel" }]);
    expect(confirmed).toHaveLength(0);
    expect(assistant.currentState).toBe("idle");
  });

  it("does not execute a deposit before confirmation timeout fires", () => {
    const { Ctor } = makeFakeCtor();
    const commands: VoiceCommand[] = [];
    const confirmed: VoiceCommand[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onCommand: (c) => commands.push(c),
      onConfirmed: (c) => confirmed.push(c),
    });

    assistant.awaitConfirmation({ type: "deposit", amount: 100 }, 10000);

    // Advance only halfway — no command emitted yet
    vi.advanceTimersByTime(5000);
    expect(commands).toHaveLength(0);
    expect(confirmed).toHaveLength(0);

    // Now advance past the timeout
    vi.advanceTimersByTime(5001);
    expect(commands).toEqual([{ type: "cancel" }]);
    expect(confirmed).toHaveLength(0);
  });

  it("surfaces a 'not-allowed' error as a readable message", () => {
    const { Ctor, instances } = makeFakeCtor();
    const errors: string[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onError: (msg) => errors.push(msg),
    });
    assistant.startCommandListening();
    instances[0].simulateError("not-allowed");
    expect(errors[0]).toMatch(/microphone/i);
    expect(assistant.currentState).toBe("error");
  });

  it("does NOT surface no-speech as an error", () => {
    const { Ctor, instances } = makeFakeCtor();
    const errors: string[] = [];
    const stateChanges: VoiceAssistantState[] = [];
    const assistant = new VoiceAssistant(Ctor, null, {
      onError: (msg) => errors.push(msg),
      onStateChange: (s) => stateChanges.push(s),
    });
    assistant.startCommandListening();
    instances[0].simulateError("no-speech");
    expect(errors).toHaveLength(0);
    // State should not have transitioned to error
    expect(assistant.currentState).not.toBe("error");
  });

  it("stop() transitions back to idle and releases the microphone", () => {
    const { Ctor, instances } = makeFakeCtor();
    const assistant = new VoiceAssistant(Ctor, null);
    assistant.startCommandListening();
    expect(instances[0].started).toBe(true);

    assistant.stop();
    expect(instances[0].stopped).toBe(true);
    expect(assistant.currentState).toBe("idle");
  });

  it("speaks via speechSynthesis when speak() is called", () => {
    const { Ctor } = makeFakeCtor();
    const synthesis = makeSynthesisMock();
    const assistant = new VoiceAssistant(Ctor, synthesis, { lang: "en" });
    assistant.speak("Your balance is 100 XLM.");
    expect(synthesis.speak).toHaveBeenCalledOnce();
    const utterance: SpeechSynthesisUtterance = (synthesis.speak as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(utterance.text).toBe("Your balance is 100 XLM.");
    expect(utterance.lang).toBe("en");
  });

  it("sets lang on the recognition instance", () => {
    const { Ctor, instances } = makeFakeCtor();
    const assistant = new VoiceAssistant(Ctor, null, { lang: "es" });
    assistant.startCommandListening();
    expect(instances[0].lang).toBe("es");
  });

  it("restarts wake-word listening after onend fires (continuous mode)", () => {
    const { Ctor, instances } = makeFakeCtor();
    const assistant = new VoiceAssistant(Ctor, null);
    assistant.startWakeWordListening();
    expect(instances).toHaveLength(1);

    // Simulate the browser ending the session (e.g. silence timeout)
    instances[0].simulateEnd();

    // Should have started a fresh instance
    expect(instances).toHaveLength(2);
    expect(assistant.currentState).toBe("listening-wake");
  });

  it("sets error state when SpeechRecognition is unavailable", () => {
    const errors: string[] = [];
    const assistant = new VoiceAssistant(null, null, {
      onError: (msg) => errors.push(msg),
    });
    assistant.startCommandListening();
    expect(assistant.currentState).toBe("error");
    expect(errors[0]).toMatch(/not supported/i);
  });
});
