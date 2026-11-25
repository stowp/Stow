"use client";

import { useEffect, useCallback } from "react";
import { useSession } from "@/context/SessionProvider";
import {
  useMilestones,
  type MilestoneType,
} from "@/context/MilestoneProvider";

/**
 * Hook for checking and awarding savings milestones.
 * Automatically checks common milestone conditions.
 */
export function useMilestoneCheck() {
  const { checkAndAwardMilestone, achievements } = useMilestones();
  const { user } = useSession();

  /**
   * Check and award a milestone if condition is met
   */
  const check = useCallback(
    (type: MilestoneType, condition: boolean) => {
      checkAndAwardMilestone(type, condition);
    },
    [checkAndAwardMilestone],
  );

  /**
   * Check deposit-related milestones
   */
  const checkDeposit = useCallback(
    (amount: number, hasMadeDeposit: boolean) => {
      check("first_deposit", hasMadeDeposit);
      check("saved_100", amount >= 100);
      check("saved_1000", amount >= 1000);
      check("saved_10000", amount >= 10000);
    },
    [check],
  );

  /**
   * Check goal-related milestones
   */
  const checkGoal = useCallback(
    (hasCreatedGoal: boolean, hasCompletedGoal: boolean) => {
      check("first_goal_created", hasCreatedGoal);
      check("goal_completed", hasCompletedGoal);
    },
    [check],
  );

  /**
   * Check streak-related milestones
   */
  const checkStreak = useCallback(
    (streakDays: number) => {
      check("streak_7_days", streakDays >= 7);
      check("streak_30_days", streakDays >= 30);
    },
    [check],
  );

  /**
   * Check group-related milestones
   */
  const checkGroup = useCallback(
    (hasJoinedGroup: boolean) => {
      check("first_group_joined", hasJoinedGroup);
    },
    [check],
  );

  /**
   * Check referral milestone
   */
  const checkReferral = useCallback(
    (hasReferralSignup: boolean) => {
      check("referral_signup", hasReferralSignup);
    },
    [check],
  );

  return {
    check,
    checkDeposit,
    checkGoal,
    checkStreak,
    checkGroup,
    checkReferral,
    achievements,
    userId: user?.id,
  };
}

/**
 * Hook for milestone analytics and statistics
 */
export function useMilestoneStats() {
  const { achievements } = useMilestones();

  const totalMilestones = 10;
  const earnedCount = achievements.size;
  const progress = (earnedCount / totalMilestones) * 100;

  const tierCounts = {
    bronze: 0,
    silver: 0,
    gold: 0,
    platinum: 0,
  };

  achievements.forEach((milestoneType) => {
    const milestone = achievements.has(milestoneType)
      ? {
          id: milestoneType,
          tier: "bronze" as const,
        }
      : null;
    if (milestone) {
      tierCounts[milestone.tier]++;
    }
  });

  return {
    totalMilestones,
    earnedCount,
    progress,
    tierCounts,
  };
}