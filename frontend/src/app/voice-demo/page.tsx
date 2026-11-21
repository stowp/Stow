"use client";

/**
 * Voice demo route.
 *
 * Mounts VoiceControl in a standalone (public) route so the Playwright
 * acceptance test can exercise the full voice stack (VoiceControl +
 * useVoiceCommands + voiceAssistant) with SpeechRecognition/speechSynthesis
 * stubbed in the page. The handlers here are deliberately self-contained
 * (a local in-memory balance) so the E2E test is deterministic without a
 * backend; in the product app VoiceControl is wired to the real
 * useFlexibleBalance / useDeposit / useWithdraw hooks instead.
 */

import { useCallback, useState } from "react";
import VoiceControl from "@/components/voice/VoiceControl";
import { useTranslation } from "@/context/I18nProvider";

export default function VoiceDemoPage() {
  const { locale } = useTranslation();
  // In-memory balance in "USDC" for the demo. The real app reads this from
  // useFlexibleBalance; here it's local so the E2E test stays deterministic.
  const [balance, setBalance] = useState(100);

  const onBalance = useCallback(async () => `${balance} USDC`, [balance]);
  const onDeposit = useCallback(
    async (amount: string) => {
      setBalance((b) => b + Number(amount));
      return `Deposited ${amount} USDC.`;
    },
    [],
  );
  const onWithdraw = useCallback(
    async (amount: string) => {
      setBalance((b) => b - Number(amount));
      return `Withdrew ${amount} USDC.`;
    },
    [],
  );

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-xl font-semibold text-foreground mb-4">
        Voice assistant demo
      </h1>
      <p
        data-testid="demo-balance"
        className="text-sm text-muted mb-4"
        aria-live="polite"
      >
        Balance: {balance} USDC
      </p>
      <VoiceControl
        lang={locale}
        onBalance={onBalance}
        onDeposit={onDeposit}
        onWithdraw={onWithdraw}
      />
    </main>
  );
}
