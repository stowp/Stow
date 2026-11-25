"use client";

import { useCallback, useEffect } from "react";
import {
  initSpeechSynthesis,
  speak,
  cancel,
  isSupported,
  describeChart,
  describeSavingsStats,
  describeGoal,
  describeTransaction,
  type AudioDescriptionOptions,
} from "@/lib/audioDescriptions";

/**
 * Hook for audio descriptions functionality
 */
export function useAudioDescriptions() {
  useEffect(() => {
    initSpeechSynthesis();
  }, []);

  const speakText = useCallback((text: string, options?: AudioDescriptionOptions) => {
    return speak(text, options);
  }, []);

  const stopSpeaking = useCallback(() => {
    cancel();
  }, []);

  const checkSupport = useCallback(() => {
    return isSupported();
  }, []);

  return {
    speakText,
    stopSpeaking,
    checkSupport,
    isSupported: isSupported(),
  };
}

/**
 * Hook for generating and speaking chart descriptions
 */
export function useChartAudioDescription() {
  const { speakText, isSupported } = useAudioDescriptions();

  const describe = useCallback(
    (
      chartType: string,
      data: Array<{ label: string; value: number; unit?: string }>,
      summary?: string,
    ) => {
      const description = describeChart(chartType, data, summary);
      speakText(description);
    },
    [speakText],
  );

  return { describe, isSupported };
}

/**
 * Hook for speaking savings statistics
 */
export function useSavingsStatsAudio() {
  const { speakText, isSupported } = useAudioDescriptions();

  const speak = useCallback(
    (stats: {
      totalSaved: number;
      goalsCompleted: number;
      currentStreak: number;
      totalDeposits: number;
    }) => {
      const description = describeSavingsStats(stats);
      speakText(description);
    },
    [speakText],
  );

  return { speak, isSupported };
}

/**
 * Hook for speaking goal information
 */
export function useGoalAudioDescription() {
  const { speakText, isSupported } = useAudioDescriptions();

  const speak = useCallback(
    (goal: {
      name: string;
      targetAmount: number;
      currentAmount: number;
      deadline?: string;
    }) => {
      const description = describeGoal(goal);
      speakText(description);
    },
    [speakText],
  );

  return { speak, isSupported };
}

/**
 * Hook for speaking transaction information
 */
export function useTransactionAudioDescription() {
  const { speakText, isSupported } = useAudioDescriptions();

  const speak = useCallback(
    (transaction: {
      type: "deposit" | "withdrawal" | "transfer";
      amount: number;
      currency?: string;
      recipient?: string;
      timestamp: string;
    }) => {
      const description = describeTransaction(transaction);
      speakText(description);
    },
    [speakText],
  );

  return { speak, isSupported };
}