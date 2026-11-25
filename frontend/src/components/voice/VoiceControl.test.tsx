/**
 * VoiceControl.test.tsx
 *
 * Component tests covering:
 * - Unsupported browser: renders an explanatory message, no button
 * - Supported browser: button with correct accessible name and aria-pressed
 * - Keyboard operation: Enter / Space toggle
 * - Live region announces feedback and errors
 * - Accessibility mode toggle: speechSynthesis not called
 * - Privacy notice presence
 * - Wake-word link
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import VoiceControl from "./VoiceControl";
import type { SpeechRecognitionCtor } from "@/lib/voiceAssistant";

// ---------------------------------------------------------------------------
// Fake SpeechRecognition (same shape as the one in useVoiceCommands.test.ts)
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

describe("VoiceControl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an explanatory message when the browser is unsupported", () => {
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: null, synthesisMock: null }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/not supported/i);
    expect(screen.queryByRole("button", { name: /voice/i })).toBeNull();
  });

  it("renders the mic toggle button with an accessible name", () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    expect(btn).toBeDefined();
  });

  it("button has aria-pressed=false when idle", () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("button has aria-pressed=true while listening", async () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(btn).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("clicking the active button stops listening", async () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    fireEvent.click(btn); // start
    await waitFor(() => expect(btn).toHaveAttribute("aria-pressed", "true"));

    fireEvent.click(btn); // stop
    await waitFor(() => expect(btn).toHaveAttribute("aria-pressed", "false"));
  });

  it("responds to Enter key to start listening", async () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    fireEvent.keyDown(btn, { key: "Enter" });
    await waitFor(() => {
      expect(btn).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("responds to Space key to start listening", async () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    fireEvent.keyDown(btn, { key: " " });
    await waitFor(() => {
      expect(btn).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("live region announces feedback when a command result arrives", async () => {
    const Ctor = makeFakeCtor();
    const onBalance = vi.fn().mockResolvedValue("42 XLM");

    render(
      <VoiceControl
        lang="en"
        onBalance={onBalance}
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );

    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    fireEvent.click(btn);

    // Fire a "check balance" transcript
    act(() => {
      latestInstance(Ctor).fireResult("check balance");
    });

    await waitFor(() => {
      const liveRegion = document.querySelector('[aria-live="polite"]');
      expect(liveRegion?.textContent).toMatch(/42 XLM/);
    });
  });

  it("accessibility mode toggle checkbox is present and labeled", () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    const checkbox = screen.getByRole("checkbox", { name: /accessibility mode/i });
    expect(checkbox).toBeDefined();
  });

  it("speechSynthesis is NOT called when accessibility mode is on", async () => {
    const Ctor = makeFakeCtor();
    const synthesis = makeSynthesisMock();
    const onBalance = vi.fn().mockResolvedValue("10 XLM");

    render(
      <VoiceControl
        lang="en"
        onBalance={onBalance}
        accessibilityMode
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: synthesis }}
      />,
    );

    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    fireEvent.click(btn);

    act(() => { latestInstance(Ctor).fireResult("check balance"); });

    await waitFor(() => {
      expect(onBalance).toHaveBeenCalled();
    });
    expect(synthesis.speak).not.toHaveBeenCalled();
  });

  it("renders the privacy notice", () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    expect(screen.getByText(/browser('s)? speech service/i)).toBeDefined();
  });

  it("renders the wake-word link", () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    expect(screen.getByText(/hey stow/i)).toBeDefined();
  });

  it("displays an error message in the visible feedback area", async () => {
    const Ctor = makeFakeCtor();
    render(
      <VoiceControl
        lang="en"
        _testOptions={{ recognitionCtor: Ctor as unknown as SpeechRecognitionCtor, synthesisMock: null }}
      />,
    );
    const btn = screen.getByRole("button", { name: /start voice assistant/i });
    fireEvent.click(btn);

    act(() => { latestInstance(Ctor).fireError("not-allowed"); });

    await waitFor(() => {
      // The error surfaces in both the aria-live region and the visible
      // feedback block; assert it's present in the DOM.
      expect(screen.getAllByText(/microphone/i).length).toBeGreaterThan(0);
    });
  });
});
