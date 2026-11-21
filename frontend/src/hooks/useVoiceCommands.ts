"use client";

/**
 * useVoiceCommands
 *
 * Wires the VoiceAssistant state machine to React state, connects parsed
 * commands to the app's existing deposit/withdraw/balance functions, and
 * provides spoken + written feedback. The hook manages the lifecycle:
 * it stops listening when the tab is hidden or the component unmounts,
 * and always releases the microphone.
 *
 * Money commands (deposit/withdraw) never execute on first parse. The
 * VoiceAssistant reads back the amount, enters an awaiting-confirmation
 * state, and only fires `onConfirmed` after the user says "confirm".
 * A timeout (or "cancel") cancels the pending command.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  VoiceAssistant,
  getSpeechRecognitionCtor,
  type VoiceCommand,
  type VoiceAssistantState,
  type SpeechRecognitionCtor,
} from "@/lib/voiceAssistant";
import type { Locale } from "@/i18n/config";

// ---------------------------------------------------------------------------
// Confirmation-prompt text, per locale
// ---------------------------------------------------------------------------

function confirmationPrompt(
  command: Extract<VoiceCommand, { type: "deposit" | "withdraw" }>,
  lang: string,
): string {
  const primary = lang.split("-")[0] as Locale;
  const amount = command.amount;
  if (primary === "es") {
    return command.type === "deposit"
      ? `Depositar ${amount}. Di "confirmar" o "cancelar".`
      : `Retirar ${amount}. Di "confirmar" o "cancelar".`;
  }
  if (primary === "fr") {
    return command.type === "deposit"
      ? `Déposer ${amount} ? Dites "confirmer" ou "annuler".`
      : `Retirer ${amount} ? Dites "confirmer" ou "annuler".`;
  }
  return command.type === "deposit"
    ? `Deposit ${amount}? Say "confirm" or "cancel".`
    : `Withdraw ${amount}? Say "confirm" or "cancel".`;
}

function cancelledMessage(lang: string): string {
  const primary = lang.split("-")[0];
  if (primary === "es") return "Cancelado.";
  if (primary === "fr") return "Annulé.";
  return "Cancelled.";
}

function unrecognizedMessage(lang: string): string {
  if (lang.startsWith("es")) return "No entendí eso. Intenta: saldo, depositar 100, retirar 50.";
  if (lang.startsWith("fr")) return "Je n'ai pas compris. Essayez : solde, déposer 100, retirer 50.";
  return "I didn't catch that. Try: check balance, deposit 100, withdraw 50.";
}

// ---------------------------------------------------------------------------
// Amount validation
// ---------------------------------------------------------------------------

const MAX_VOICE_AMOUNT = 1_000_000;

function validateAmount(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Amount must be greater than zero.";
  if (amount > MAX_VOICE_AMOUNT) {
    return `Amount ${amount} is too large. Please use the app directly for amounts over ${MAX_VOICE_AMOUNT}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

export type VoiceCommandStatus =
  | "idle"
  | "listening-wake"
  | "listening-command"
  | "awaiting-confirmation"
  | "processing"
  | "error";

export interface UseVoiceCommandsOptions {
  /** BCP 47 locale code from the app's I18nProvider. e.g. "en", "es", "fr" */
  lang?: string;
  /** Called when a "balance" command is confirmed. Should return the balance string to announce. */
  onBalance?: () => Promise<string | null>;
  /**
   * Called when a "deposit" command is confirmed. Receives the decimal amount
   * string (e.g. "100"). Should execute the deposit and return a result message.
   */
  onDeposit?: (amount: string) => Promise<string>;
  /**
   * Called when a "withdraw" command is confirmed. Receives the decimal amount
   * string. Should execute the withdrawal and return a result message.
   */
  onWithdraw?: (amount: string) => Promise<string>;
  /**
   * When true, the hook uses text-only feedback (aria-live region) and
   * does NOT call speechSynthesis, so it doesn't talk over a screen reader.
   */
  accessibilityMode?: boolean;
  /** How long to wait for a confirm/cancel before auto-cancelling, in ms. */
  confirmTimeoutMs?: number;
  /**
   * Injected SpeechRecognition constructor for testing.
   * Production code leaves this undefined and uses getSpeechRecognitionCtor().
   */
  recognitionCtor?: SpeechRecognitionCtor | null;
  /**
   * Injected speechSynthesis for testing. Production code uses window.speechSynthesis.
   */
  synthesisMock?: SpeechSynthesis | null;
}

export interface UseVoiceCommandsReturn {
  /** Current state of the voice assistant. */
  status: VoiceCommandStatus;
  /** Whether Speech Recognition is available in this browser. */
  isSupported: boolean;
  /** The last raw transcript received from the speech engine. */
  lastTranscript: string;
  /** The last feedback message (for aria-live and UI display). */
  feedbackMessage: string;
  /** The last parsed command (useful for displaying in the UI). */
  lastCommand: VoiceCommand | null;
  /** Error message when status === "error". */
  errorMessage: string;
  /**
   * Starts continuous wake-word listening.
   * Commands are accepted only after "Hey Stow" is heard.
   */
  startWakeWordListening: () => void;
  /**
   * Starts single-utterance command listening directly (button-triggered).
   * No wake word required.
   */
  startCommandListening: () => void;
  /** Stops all listening and releases the microphone. */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVoiceCommands(
  options: UseVoiceCommandsOptions = {},
): UseVoiceCommandsReturn {
  const { lang = "en", confirmTimeoutMs = 15000 } = options;

  const [status, setStatus] = useState<VoiceCommandStatus>("idle");
  const [isSupported, setIsSupported] = useState(false);
  const [lastTranscript, setLastTranscript] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [lastCommand, setLastCommand] = useState<VoiceCommand | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  // Stable ref to the latest options so the assistant's callbacks (created
  // once per lang) always read current values without recreating the assistant.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const assistantRef = useRef<VoiceAssistant | null>(null);

  // Create the VoiceAssistant once (recreated only when lang changes).
  useEffect(() => {
    const ctor =
      options.recognitionCtor !== undefined
        ? options.recognitionCtor
        : getSpeechRecognitionCtor();
    const synthesis =
      options.synthesisMock !== undefined
        ? options.synthesisMock
        : typeof window !== "undefined" && "speechSynthesis" in window
          ? window.speechSynthesis
          : null;

    // isSupported reflects whether a recognition engine is available
    // (injected for tests, or the browser's SpeechRecognition/webkit prefix).
    // SpeechRecognition availability isn't known during SSR; this is the
    // correct client-only detection point, mirroring the repo's existing
    // client-detection-after-mount pattern (see useSavingsSummary).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsSupported(ctor !== null);

    const assistant = new VoiceAssistant(ctor, synthesis, {
      lang,
      onStateChange: (state: VoiceAssistantState) => {
        setStatus(state as VoiceCommandStatus);
        if (state !== "error") setErrorMessage("");
      },
      onTranscript: (t: string) => setLastTranscript(t),
      onError: (msg: string) => {
        setErrorMessage(msg);
        setStatus("error");
      },
      onCommand: (command: VoiceCommand) => {
        setLastCommand(command);
        const opts = optionsRef.current;
        const speakUnlessA11y = (msg: string) => {
          setFeedbackMessage(msg);
          if (!opts.accessibilityMode) assistant.speak(msg);
        };

        switch (command.type) {
          case "balance": {
            // Balance is the only sensitive data we read back by voice.
            void (async () => {
              const balance = opts.onBalance ? await opts.onBalance() : null;
              speakUnlessA11y(
                balance != null
                  ? `Your balance is ${balance}.`
                  : "Balance is unavailable right now.",
              );
            })();
            break;
          }

          case "deposit":
          case "withdraw": {
            const validationErr = validateAmount(command.amount);
            if (validationErr) {
              speakUnlessA11y(validationErr);
              break;
            }
            // Read back the amount and ask for confirmation; do NOT execute.
            speakUnlessA11y(confirmationPrompt(command, lang));
            assistant.awaitConfirmation(command, optionsRef.current.confirmTimeoutMs ?? confirmTimeoutMs);
            break;
          }

          case "cancel": {
            speakUnlessA11y(cancelledMessage(lang));
            break;
          }

          case "unrecognized": {
            speakUnlessA11y(unrecognizedMessage(lang));
            break;
          }

          // "confirm" never reaches onCommand on its own — it's consumed by the
          // confirmation state machine and routed to onConfirmed below.
          case "confirm":
            break;
        }
      },
      onConfirmed: (command) => {
        const opts = optionsRef.current;
        const speakUnlessA11y = (msg: string) => {
          setFeedbackMessage(msg);
          if (!opts.accessibilityMode) assistant.speak(msg);
        };
        // Execute the actual transaction via the app's existing functions.
        void (async () => {
          try {
            const amountStr = String(command.amount);
            const result =
              command.type === "deposit"
                ? opts.onDeposit
                  ? await opts.onDeposit(amountStr)
                  : "Deposit started."
                : opts.onWithdraw
                  ? await opts.onWithdraw(amountStr)
                  : "Withdrawal started.";
            speakUnlessA11y(result);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "An error occurred.";
            speakUnlessA11y(`Failed: ${msg}`);
          }
        })();
      },
    });

    assistantRef.current = assistant;

    return () => {
      assistant.stop();
      assistantRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // Stop listening when the tab becomes hidden (and on unmount, via cleanup).
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        assistantRef.current?.stop();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const startWakeWordListening = useCallback(() => {
    assistantRef.current?.startWakeWordListening();
  }, []);

  const startCommandListening = useCallback(() => {
    assistantRef.current?.startCommandListening();
  }, []);

  const stop = useCallback(() => {
    assistantRef.current?.stop();
  }, []);

  return {
    status,
    isSupported,
    lastTranscript,
    feedbackMessage,
    lastCommand,
    errorMessage,
    startWakeWordListening,
    startCommandListening,
    stop,
  };
}
