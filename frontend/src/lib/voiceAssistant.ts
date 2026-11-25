/**
 * voiceAssistant.ts
 *
 * Framework-free module wrapping the Web Speech API (SpeechRecognition and
 * speechSynthesis). All objects are injected so the module is fully testable
 * without a real browser speech engine.
 *
 * Privacy note: this module sends no audio or transcripts to any server of
 * ours. The browser's built-in speech service (e.g. Google Speech for Chrome,
 * Apple's on-device engine for Safari) processes the audio according to its
 * own privacy policy. Users should be aware of this.
 */

// ---------------------------------------------------------------------------
// Minimal Web Speech API type declarations
//
// The Web Speech API (SpeechRecognition) isn't part of the standard DOM lib
// bundled with TypeScript, so we declare just enough of the surface this
// module relies on. speechSynthesis/SpeechSynthesisUtterance ARE in the DOM
// lib and need no declaration here.
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult extends ArrayLike<SpeechRecognitionAlternative> {
  isFinal: boolean;
}

interface SpeechRecognitionResultList extends ArrayLike<SpeechRecognitionResult> {
  length: number;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

export interface SpeechSupport {
  recognition: boolean;
  synthesis: boolean;
}

export function detectSpeechSupport(): SpeechSupport {
  const recognition =
    typeof window !== "undefined" &&
    (typeof (window as unknown as Record<string, unknown>)["SpeechRecognition"] === "function" ||
      typeof (window as unknown as Record<string, unknown>)["webkitSpeechRecognition"] === "function");

  const synthesis =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.speechSynthesis.speak === "function";

  return { recognition, synthesis };
}

// ---------------------------------------------------------------------------
// Command types
// ---------------------------------------------------------------------------

export type VoiceCommand =
  | { type: "balance" }
  | { type: "deposit"; amount: number }
  | { type: "withdraw"; amount: number }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "unrecognized"; transcript: string };

// ---------------------------------------------------------------------------
// Number-word tables
// ---------------------------------------------------------------------------

/** Map of number words to numeric values, per locale. */
const NUMBER_WORDS: Record<string, Record<string, number>> = {
  en: {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90,
    hundred: 100, thousand: 1000,
  },
  es: {
    cero: 0, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
    once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
    veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
    sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
    cien: 100, ciento: 100, mil: 1000,
  },
  fr: {
    zéro: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5,
    six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
    onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15,
    seize: 16, vingt: 20, trente: 30, quarante: 40, cinquante: 50,
    soixante: 60, cent: 100, mille: 1000,
  },
};

/**
 * Converts a string of number words into a number.
 * e.g. "one hundred fifty" -> 150, "deux cents" -> 200.
 * Returns null when the string contains no parseable number words.
 */
export function parseNumberWords(text: string, lang = "en"): number | null {
  const primary = lang.split("-")[0].toLowerCase();
  const table = NUMBER_WORDS[primary] ?? NUMBER_WORDS["en"];

  // Split on whitespace and noise words like "and"
  const words = text.toLowerCase().split(/[\s,]+/).filter(Boolean);

  let result = 0;
  let current = 0;
  let found = false;

  for (const word of words) {
    // Skip noise words
    if (word === "and" || word === "y" || word === "et") continue;

    const val = table[word];
    if (val === undefined) continue;
    found = true;

    if (val === 1000) {
      result += (current === 0 ? 1 : current) * 1000;
      current = 0;
    } else if (val === 100) {
      current = (current === 0 ? 1 : current) * 100;
    } else {
      current += val;
    }
  }

  if (!found) return null;
  return result + current;
}

/**
 * Extracts an amount from a transcript fragment.
 * Accepts:
 *   - plain integers: "100", "50"
 *   - decimals: "12.50", "12,50"
 *   - number words: "one hundred", "fifty dollars", "cien"
 * Returns null for zero, negative, or non-parseable input.
 */
export function parseAmount(text: string, lang = "en"): number | null {
  const cleaned = text.trim();

  // Try a bare numeric literal first (with optional currency words stripped)
  const numericMatch = /(\d+(?:[.,]\d+)?)/.exec(cleaned);
  if (numericMatch) {
    const raw = numericMatch[1].replace(",", ".");
    const value = parseFloat(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }

  // Try number words
  const stripped = cleaned
    .replace(/dollars?|usd|usdc|xlm|euros?|pounds?|pesos?/gi, "")
    .trim();
  const wordValue = parseNumberWords(stripped, lang);
  if (wordValue !== null && wordValue > 0) return wordValue;

  return null;
}

// ---------------------------------------------------------------------------
// Per-language phrase tables
// ---------------------------------------------------------------------------

export interface PhraseTables {
  wakeWords: string[];
  balance: string[];
  deposit: string[];
  withdraw: string[];
  confirm: string[];
  cancel: string[];
}

export const PHRASE_TABLES: Record<string, PhraseTables> = {
  en: {
    wakeWords: ["hey stow", "hey sto"],
    balance: ["check balance", "my balance", "what is my balance", "balance", "how much do i have"],
    deposit: ["deposit", "add funds", "put in"],
    withdraw: ["withdraw", "take out", "remove"],
    confirm: ["confirm", "yes", "okay", "ok", "do it"],
    cancel: ["cancel", "no", "stop", "abort"],
  },
  es: {
    wakeWords: ["hey stow", "oye stow"],
    balance: ["consultar saldo", "mi saldo", "cuál es mi saldo", "saldo", "cuánto tengo"],
    deposit: ["depositar", "agregar fondos", "deposito"],
    withdraw: ["retirar", "retiro", "sacar"],
    confirm: ["confirmar", "sí", "si", "confirmo", "adelante"],
    cancel: ["cancelar", "no", "parar", "cancelar"],
  },
  fr: {
    wakeWords: ["hey stow", "salut stow"],
    balance: ["vérifier le solde", "mon solde", "quel est mon solde", "solde", "combien ai-je"],
    deposit: ["déposer", "ajouter des fonds", "dépôt"],
    withdraw: ["retirer", "retrait"],
    confirm: ["confirmer", "oui", "d'accord", "ok"],
    cancel: ["annuler", "non", "arrêter"],
  },
};

function getPhrases(lang: string): PhraseTables {
  const primary = lang.split("-")[0].toLowerCase();
  return PHRASE_TABLES[primary] ?? PHRASE_TABLES["en"];
}

// ---------------------------------------------------------------------------
// Command parser (pure, no browser APIs)
// ---------------------------------------------------------------------------

/**
 * Parses a speech transcript into a typed VoiceCommand.
 * This function is pure: no side effects, no browser APIs, fully testable.
 */
export function parseVoiceCommand(transcript: string, lang = "en"): VoiceCommand {
  const text = transcript.toLowerCase().trim();
  const phrases = getPhrases(lang);

  // Confirm
  if (phrases.confirm.some((p) => text === p || text.startsWith(p))) {
    return { type: "confirm" };
  }

  // Cancel
  if (phrases.cancel.some((p) => text === p || text.startsWith(p))) {
    return { type: "cancel" };
  }

  // Balance
  if (phrases.balance.some((p) => text.includes(p))) {
    return { type: "balance" };
  }

  // Deposit — look for a deposit keyword followed by an amount
  for (const keyword of phrases.deposit) {
    if (text.includes(keyword)) {
      const afterKeyword = text.slice(text.indexOf(keyword) + keyword.length).trim();
      const amount = parseAmount(afterKeyword || text, lang);
      if (amount !== null) {
        return { type: "deposit", amount };
      }
    }
  }

  // Withdraw — same pattern
  for (const keyword of phrases.withdraw) {
    if (text.includes(keyword)) {
      const afterKeyword = text.slice(text.indexOf(keyword) + keyword.length).trim();
      const amount = parseAmount(afterKeyword || text, lang);
      if (amount !== null) {
        return { type: "withdraw", amount };
      }
    }
  }

  return { type: "unrecognized", transcript };
}

/**
 * Returns true when the transcript contains the wake word for the given locale.
 */
export function containsWakeWord(transcript: string, lang = "en"): boolean {
  const text = transcript.toLowerCase();
  const phrases = getPhrases(lang);
  return phrases.wakeWords.some((w) => text.includes(w));
}

// ---------------------------------------------------------------------------
// Spoken feedback helpers
// ---------------------------------------------------------------------------

export interface SpeakOptions {
  lang?: string;
  rate?: number;
  pitch?: number;
}

/**
 * Speaks `text` using the injected speechSynthesis object.
 * Returns the utterance so callers can cancel it.
 *
 * Falls back to a plain object when `SpeechSynthesisUtterance` isn't defined
 * (e.g. jsdom) so the module stays testable without a full speech engine —
 * callers that only inspect `utterance.text`/`.lang` still work.
 */
export function speak(
  text: string,
  synthesis: SpeechSynthesis,
  options: SpeakOptions = {},
): SpeechSynthesisUtterance {
  synthesis.cancel();
  const hasUtteranceCtor =
    typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as { SpeechSynthesisUtterance?: unknown })
      .SpeechSynthesisUtterance === "function";
  const utterance = hasUtteranceCtor
    ? new (globalThis as unknown as { SpeechSynthesisUtterance: new (text: string) => SpeechSynthesisUtterance }).SpeechSynthesisUtterance(text)
    : ({ text, lang: "", rate: 1, pitch: 1 } as unknown as SpeechSynthesisUtterance);
  utterance.lang = options.lang ?? "en-US";
  utterance.rate = options.rate ?? 1;
  utterance.pitch = options.pitch ?? 1;
  synthesis.speak(utterance);
  return utterance;
}

// ---------------------------------------------------------------------------
// SpeechRecognition constructor (handles webkit prefix)
// ---------------------------------------------------------------------------

export type SpeechRecognitionCtor =
  new () => SpeechRecognition;

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  if (typeof w["SpeechRecognition"] === "function") {
    return w["SpeechRecognition"] as SpeechRecognitionCtor;
  }
  if (typeof w["webkitSpeechRecognition"] === "function") {
    return w["webkitSpeechRecognition"] as SpeechRecognitionCtor;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Voice assistant state machine
// ---------------------------------------------------------------------------

export type VoiceAssistantState =
  | "idle"
  | "listening-wake"      // continuous, waiting for "Hey Stow"
  | "listening-command"   // one-shot, waiting for a command
  | "awaiting-confirmation" // read back an amount, waiting for confirm/cancel
  | "processing"
  | "error";

export interface VoiceAssistantOptions {
  /** BCP 47 locale, e.g. "en", "es", "fr". Defaults to "en". */
  lang?: string;
  /** Called when state changes. */
  onStateChange?: (state: VoiceAssistantState) => void;
  /** Called when a final transcript is produced. */
  onTranscript?: (transcript: string) => void;
  /** Called when a command is parsed (initial parse — before confirmation). */
  onCommand?: (command: VoiceCommand) => void;
  /**
   * Called only when a pending deposit/withdraw command is confirmed by
   * the user (or auto-cancelled emits a "cancel" command via onCommand).
   * Distinct from onCommand so callers can execute the action without
   * re-detecting whether it's the first parse or the confirmed re-emission.
   */
  onConfirmed?: (command: Extract<VoiceCommand, { type: "deposit" | "withdraw" }>) => void;
  /** Called when an error occurs. */
  onError?: (message: string) => void;
  /**
   * When true, commands are accepted without requiring the wake word first.
   * (Used in button-triggered mode.)
   */
  skipWakeWord?: boolean;
}

/**
 * VoiceAssistant manages a SpeechRecognition instance through the state
 * machine. All browser objects are injected; pass fakes for testing.
 */
export class VoiceAssistant {
  private recognition: SpeechRecognition | null = null;
  private state: VoiceAssistantState = "idle";
  private pendingCommand: Extract<VoiceCommand, { type: "deposit" | "withdraw" }> | null = null;
  private confirmTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // Set true by awaitConfirmation so handleTranscript knows the callback
  // entered the confirmation state and shouldn't force state back to idle.
  private confirmationEntered = false;
  readonly lang: string;

  constructor(
    private readonly RecognitionCtor: SpeechRecognitionCtor | null,
    private readonly synthesis: SpeechSynthesis | null,
    private readonly options: VoiceAssistantOptions = {},
  ) {
    this.lang = options.lang ?? "en";
  }

  get currentState(): VoiceAssistantState {
    return this.state;
  }

  private setState(next: VoiceAssistantState): void {
    this.state = next;
    this.options.onStateChange?.(next);
  }

  /**
   * Starts continuous listening for the wake word.
   */
  startWakeWordListening(): void {
    if (!this.RecognitionCtor) {
      this.setState("error");
      this.options.onError?.("Speech recognition is not supported in this browser.");
      return;
    }
    this.stopRecognition();
    this.setState("listening-wake");
    this.startRecognition(true);
  }

  /**
   * Starts single-utterance command listening (bypasses wake word).
   * Used when the user presses the mic button.
   */
  startCommandListening(): void {
    if (!this.RecognitionCtor) {
      this.setState("error");
      this.options.onError?.("Speech recognition is not supported in this browser.");
      return;
    }
    this.stopRecognition();
    this.setState("listening-command");
    this.startRecognition(false);
  }

  stop(): void {
    this.clearConfirmTimeout();
    this.stopRecognition();
    this.pendingCommand = null;
    this.setState("idle");
  }

  private stopRecognition(): void {
    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {
        // Ignore — already stopped or never started.
      }
      this.recognition = null;
    }
  }

  private startRecognition(continuous: boolean): void {
    if (!this.RecognitionCtor) return;

    const rec = new this.RecognitionCtor();
    rec.lang = this.lang;
    rec.continuous = continuous;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (event: SpeechRecognitionEvent) => {
      const last = event.results[event.results.length - 1];
      const transcript = last[0].transcript.trim();
      this.options.onTranscript?.(transcript);
      this.handleTranscript(transcript);
    };

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are benign; don't surface them as errors.
      if (event.error === "no-speech" || event.error === "aborted") return;
      this.setState("error");
      this.options.onError?.(
        event.error === "not-allowed"
          ? "Microphone access was denied. Please allow microphone access and try again."
          : `Speech recognition error: ${event.error}`,
      );
    };

    rec.onend = () => {
      // If we're still supposed to be listening for the wake word, restart.
      if (this.state === "listening-wake") {
        this.startRecognition(true);
      }
    };

    this.recognition = rec;
    rec.start();
  }

  private handleTranscript(transcript: string): void {
    if (this.state === "awaiting-confirmation") {
      this.handleConfirmationTranscript(transcript);
      return;
    }

    if (this.state === "listening-wake") {
      if (containsWakeWord(transcript, this.lang) || this.options.skipWakeWord) {
        this.stopRecognition();
        this.setState("listening-command");
        this.startRecognition(false);
      }
      // Ignore transcripts that don't contain the wake word.
      return;
    }

    if (this.state === "listening-command") {
      this.stopRecognition();
      this.setState("processing");
      const command = parseVoiceCommand(transcript, this.lang);
      this.confirmationEntered = false;
      this.options.onCommand?.(command);
      // onCommand may have entered confirmation (deposit/withdraw ->
      // awaitConfirmation). Only return to idle if it did not.
      if (!this.confirmationEntered) {
        this.setState("idle");
      }
    }
  }

  private handleConfirmationTranscript(transcript: string): void {
    this.stopRecognition();
    this.clearConfirmTimeout();

    const command = parseVoiceCommand(transcript, this.lang);
    if (command.type === "confirm" && this.pendingCommand) {
      const confirmed = this.pendingCommand;
      this.pendingCommand = null;
      this.setState("processing");
      this.options.onConfirmed?.(confirmed);
      this.setState("idle");
    } else {
      // cancel or unrecognized — treat as cancel
      this.pendingCommand = null;
      this.setState("idle");
      this.options.onCommand?.({ type: "cancel" });
    }
  }

  /**
   * Enters the confirmation state for a pending money command.
   * The caller is responsible for reading back the amount and asking
   * for confirm/cancel before calling this.
   */
  awaitConfirmation(
    command: Extract<VoiceCommand, { type: "deposit" | "withdraw" }>,
    timeoutMs = 15000,
  ): void {
    this.pendingCommand = command;
    this.confirmationEntered = true;
    this.setState("awaiting-confirmation");
    this.startRecognition(false);

    this.confirmTimeoutId = setTimeout(() => {
      this.pendingCommand = null;
      this.stopRecognition();
      this.setState("idle");
      this.options.onCommand?.({ type: "cancel" });
    }, timeoutMs);
  }

  private clearConfirmTimeout(): void {
    if (this.confirmTimeoutId !== null) {
      clearTimeout(this.confirmTimeoutId);
      this.confirmTimeoutId = null;
    }
  }

  /**
   * Speaks text via speechSynthesis (no-op when synthesis is unavailable or null).
   */
  speak(text: string): void {
    if (!this.synthesis) return;
    speak(text, this.synthesis, { lang: this.lang });
  }
}
