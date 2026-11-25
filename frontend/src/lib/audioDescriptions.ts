/**
 * Audio descriptions utility for accessibility.
 * Provides text-to-speech descriptions for visual content like charts.
 */

export interface AudioDescriptionOptions {
  /** Rate of speech (0.1 to 10, default 1) */
  rate?: number;
  /** Voice pitch (0 to 2, default 1) */
  pitch?: number;
  /** Volume (0 to 1, default 1) */
  volume?: number;
  /** Language code (default 'en-US') */
  lang?: string;
}

let speechSynthesis: SpeechSynthesis | null = null;
let speechSynthesisVoices: SpeechSynthesisVoice[] = [];

/**
 * Initialize speech synthesis (call on mount)
 */
export function initSpeechSynthesis() {
  if (typeof window === "undefined") return;

  speechSynthesis = window.speechSynthesis;

  const loadVoices = () => {
    speechSynthesisVoices = speechSynthesis?.getVoices() ?? [];
  };

  // Chrome loads voices asynchronously
  if (speechSynthesis?.onvoiceschanged !== undefined) {
    speechSynthesis?.addEventListener("voiceschanged", loadVoices);
  }

  loadVoices();
}

/**
 * Get available voices for a language
 */
export function getVoicesForLanguage(lang: string): SpeechSynthesisVoice[] {
  return speechSynthesisVoices.filter((voice) => voice.lang.startsWith(lang));
}

/**
 * Speak text using screen reader
 */
export function speak(
  text: string,
  options: AudioDescriptionOptions = {},
): boolean {
  if (typeof window === "undefined") return false;

  // Cancel any ongoing speech
  cancel();

  const synthesis = window.speechSynthesis;
  if (!synthesis) {
    console.warn("Speech synthesis not supported");
    return false;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = options.rate ?? 1;
  utterance.pitch = options.pitch ?? 1;
  utterance.volume = options.volume ?? 1;
  utterance.lang = options.lang ?? "en-US";

  // Find a voice for the language
  if (options.lang) {
    const voices = getVoicesForLanguage(options.lang);
    if (voices.length > 0) {
      utterance.voice = voices[0];
    }
  }

  synthesis.speak(utterance);
  return true;
}

/**
 * Cancel ongoing speech
 */
export function cancel() {
  if (typeof window === "undefined") return;
  window.speechSynthesis?.cancel();
}

/**
 * Pause speech
 */
export function pause() {
  if (typeof window === "undefined") return;
  window.speechSynthesis?.pause();
}

/**
 * Resume speech
 */
export function resume() {
  if (typeof window === "undefined") return;
  window.speechSynthesis?.resume();
}

/**
 * Check if speech is currently supported
 */
export function isSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Generate audio description for a chart
 */
export function describeChart(
  chartType: string,
  data: Array<{ label: string; value: number; unit?: string }>,
  summary?: string,
): string {
  const formattedData = data
    .map(
      (d) =>
        `${d.label}: ${d.value.toLocaleString()}${d.unit ? ` ${d.unit}` : ""}`,
    )
    .join(", ");

  return summary
    ? `${chartType} chart. ${summary} Data points: ${formattedData}.`
    : `${chartType} chart showing: ${formattedData}.`;
}

/**
 * Generate audio description for savings statistics
 */
export function describeSavingsStats(stats: {
  totalSaved: number;
  goalsCompleted: number;
  currentStreak: number;
  totalDeposits: number;
}): string {
  const parts = [
    `Total saved: ${stats.totalSaved.toLocaleString()} USDC.`,
    `Goals completed: ${stats.goalsCompleted}.`,
    `Current streak: ${stats.currentStreak} days.`,
    `Total deposits: ${stats.totalDeposits}.`,
  ];

  return parts.join(" ");
}

/**
 * Generate audio description for a savings goal
 */
export function describeGoal(goal: {
  name: string;
  targetAmount: number;
  currentAmount: number;
  deadline?: string;
}): string {
  const percent = Math.round((goal.currentAmount / goal.targetAmount) * 100);
  const remaining = goal.targetAmount - goal.currentAmount;

  let description = `Goal: ${goal.name}. Target: ${goal.targetAmount.toLocaleString()} USDC. Current: ${goal.currentAmount.toLocaleString()} USDC. Progress: ${percent} percent.`;

  if (remaining > 0) {
    description += ` ${remaining.toLocaleString()} USDC remaining.`;
  } else {
    description += " Goal achieved!";
  }

  if (goal.deadline) {
    description += ` Deadline: ${goal.deadline}.`;
  }

  return description;
}

/**
 * Generate audio description for a transaction
 */
export function describeTransaction(transaction: {
  type: "deposit" | "withdrawal" | "transfer";
  amount: number;
  currency?: string;
  recipient?: string;
  timestamp: string;
}): string {
  const currency = transaction.currency ?? "USDC";
  const formattedAmount = transaction.amount.toLocaleString();

  let description = `${transaction.type}: ${formattedAmount} ${currency}`;

  if (transaction.recipient) {
    description += ` to ${transaction.recipient}`;
  }

  description += `. ${transaction.timestamp}.`;

  return description;
}