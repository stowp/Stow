"use client";

/**
 * VoiceControl
 *
 * A mic toggle button with:
 * - Visible state (idle / listening for wake word / listening for command /
 *   awaiting confirmation / processing / error)
 * - An aria-live region announcing results to screen readers
 * - Full keyboard operation (Enter/Space to toggle)
 * - Accessibility mode: suppresses speechSynthesis and relies solely on
 *   the aria-live region, so it doesn't talk over a screen reader
 * - Privacy notice about the browser's speech service
 *
 * Renders nothing (returns null) when the browser doesn't support
 * SpeechRecognition, to avoid showing a broken control.
 */

import { useCallback, useId, useState } from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { useVoiceCommands, type UseVoiceCommandsOptions } from "@/hooks/useVoiceCommands";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VoiceControlProps {
  /** BCP 47 locale code from the app's I18nProvider. e.g. "en", "es", "fr". */
  lang?: string;
  /** Called when a "balance" command is confirmed. Should return the balance string. */
  onBalance?: () => Promise<string | null>;
  /** Called when a "deposit" command is confirmed with the decimal amount string. */
  onDeposit?: (amount: string) => Promise<string>;
  /** Called when a "withdraw" command is confirmed with the decimal amount string. */
  onWithdraw?: (amount: string) => Promise<string>;
  /**
   * When true, disables speechSynthesis feedback and uses only the aria-live
   * region. Defaults to false. Users running a screen reader should enable
   * this to avoid duplicate audio.
   */
  accessibilityMode?: boolean;
  /**
   * Optional class name for the container div.
   */
  className?: string;
  /**
   * Injected test doubles — see UseVoiceCommandsOptions.
   * @internal
   */
  _testOptions?: Pick<UseVoiceCommandsOptions, "recognitionCtor" | "synthesisMock">;
}

// ---------------------------------------------------------------------------
// Status label helpers
// ---------------------------------------------------------------------------

function statusLabel(
  status: ReturnType<typeof useVoiceCommands>["status"],
  lang: string,
): string {
  const primary = lang.split("-")[0];

  if (primary === "es") {
    switch (status) {
      case "idle": return "Asistente de voz inactivo";
      case "listening-wake": return "Escuchando… di Hey Stow";
      case "listening-command": return "Escuchando comando…";
      case "awaiting-confirmation": return "Esperando confirmación";
      case "processing": return "Procesando…";
      case "error": return "Error del asistente de voz";
    }
  }
  if (primary === "fr") {
    switch (status) {
      case "idle": return "Assistant vocal inactif";
      case "listening-wake": return "À l'écoute… dites Hey Stow";
      case "listening-command": return "À l'écoute d'une commande…";
      case "awaiting-confirmation": return "En attente de confirmation";
      case "processing": return "Traitement…";
      case "error": return "Erreur de l'assistant vocal";
    }
  }
  switch (status) {
    case "idle": return "Voice assistant idle";
    case "listening-wake": return "Listening… say Hey Stow";
    case "listening-command": return "Listening for command…";
    case "awaiting-confirmation": return "Awaiting confirmation";
    case "processing": return "Processing…";
    case "error": return "Voice assistant error";
  }
}

function micButtonLabel(
  isActive: boolean,
  lang: string,
): string {
  const primary = lang.split("-")[0];
  if (primary === "es") return isActive ? "Detener asistente de voz" : "Iniciar asistente de voz";
  if (primary === "fr") return isActive ? "Arrêter l'assistant vocal" : "Démarrer l'assistant vocal";
  return isActive ? "Stop voice assistant" : "Start voice assistant";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VoiceControl({
  lang = "en",
  onBalance,
  onDeposit,
  onWithdraw,
  accessibilityMode = false,
  className = "",
  _testOptions,
}: VoiceControlProps) {
  const liveRegionId = useId();
  const statusId = useId();

  // Local accessibility-mode toggle so the user can flip it in the UI
  const [a11yMode, setA11yMode] = useState(accessibilityMode);

  const {
    status,
    isSupported,
    feedbackMessage,
    errorMessage,
    startWakeWordListening,
    startCommandListening,
    stop,
  } = useVoiceCommands({
    lang,
    onBalance,
    onDeposit,
    onWithdraw,
    accessibilityMode: a11yMode,
    ...(_testOptions ?? {}),
  });

  const isActive =
    status === "listening-wake" ||
    status === "listening-command" ||
    status === "awaiting-confirmation" ||
    status === "processing";

  const handleToggle = useCallback(() => {
    if (isActive) {
      stop();
    } else {
      // Button-triggered: skip wake word, go straight to command listening.
      startCommandListening();
    }
  }, [isActive, stop, startCommandListening]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleToggle();
      }
    },
    [handleToggle],
  );

  // If not supported, render an explanatory message rather than a broken button.
  if (!isSupported) {
    return (
      <div
        role="status"
        aria-label="Voice assistant unavailable"
        className={`text-sm text-muted ${className}`}
      >
        Voice commands are not supported in this browser. Try Chrome or Edge.
      </div>
    );
  }

  const label = micButtonLabel(isActive, lang);
  const statLabel = statusLabel(status, lang);

  // Icon selection
  const Icon =
    status === "processing"
      ? Loader2
      : isActive
        ? Mic
        : MicOff;

  // Ring color by state
  const ringColor =
    status === "error"
      ? "ring-red-400 text-red-400"
      : status === "awaiting-confirmation"
        ? "ring-yellow-400 text-yellow-400"
        : isActive
          ? "ring-brand text-brand"
          : "ring-border text-muted";

  return (
    <div className={`flex flex-col items-start gap-2 ${className}`}>
      {/* Mic toggle button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          aria-label={label}
          aria-pressed={isActive}
          aria-describedby={statusId}
          className={`inline-flex items-center justify-center rounded-full border p-3 transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand/50 ${ringColor} hover:bg-card`}
        >
          <Icon
            className={`h-5 w-5 ${status === "processing" ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
        </button>

        {/* Status text shown next to the button */}
        <span
          id={statusId}
          className="text-sm text-muted"
          aria-live="off"
        >
          {statLabel}
        </span>
      </div>

      {/* Wake-word hint when idle */}
      {status === "idle" && (
        <div className="ml-1 flex items-center gap-3">
          <button
            type="button"
            onClick={startWakeWordListening}
            className="text-xs text-brand underline-offset-2 hover:underline focus:outline-none focus:ring-1 focus:ring-brand/50 rounded"
          >
            {lang.startsWith("es")
              ? 'Escuchar "Hey Stow"'
              : lang.startsWith("fr")
                ? 'Écouter "Hey Stow"'
                : 'Listen for "Hey Stow"'}
          </button>
        </div>
      )}

      {/* Accessibility mode toggle */}
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={a11yMode}
          onChange={(e) => setA11yMode(e.target.checked)}
          className="h-3 w-3 rounded focus:ring-brand/50"
          aria-label={
            lang.startsWith("es")
              ? "Modo accesibilidad: usar solo texto"
              : lang.startsWith("fr")
                ? "Mode accessibilité : texte uniquement"
                : "Accessibility mode: text only"
          }
        />
        {lang.startsWith("es")
          ? "Solo texto (sin voz)"
          : lang.startsWith("fr")
            ? "Texte uniquement"
            : "Text only (no speech)"}
      </label>

      {/* Privacy notice */}
      <p className="text-xs text-muted/70 max-w-xs">
        {lang.startsWith("es")
          ? "Audio procesado por el servicio de voz del navegador, no por Stow."
          : lang.startsWith("fr")
            ? "Audio traité par le service vocal du navigateur, pas par Stow."
            : "Audio is processed by your browser's speech service, not by Stow."}
      </p>

      {/* Aria-live region: announces all feedback and errors to screen readers */}
      <div
        id={liveRegionId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {errorMessage || feedbackMessage}
      </div>

      {/* Visible feedback message (for sighted users) */}
      {(feedbackMessage || errorMessage) && (
        <div
          className={`mt-1 max-w-xs rounded-lg border px-3 py-2 text-sm ${
            errorMessage
              ? "border-red-400/30 bg-red-400/10 text-red-400"
              : "border-border bg-card text-foreground"
          }`}
          aria-hidden="true"
        >
          {errorMessage || feedbackMessage}
        </div>
      )}
    </div>
  );
}
