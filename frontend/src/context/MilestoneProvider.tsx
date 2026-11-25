"use client";

import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type MilestoneType =
  | "first_deposit"
  | "saved_100"
  | "saved_1000"
  | "saved_10000"
  | "first_goal_created"
  | "goal_completed"
  | "streak_7_days"
  | "streak_30_days"
  | "first_group_joined"
  | "referral_signup";

export interface Milestone {
  id: MilestoneType;
  title: string;
  description: string;
  icon: string;
  tier: "bronze" | "silver" | "gold" | "platinum";
}

export const MILESTONES: Record<MilestoneType, Milestone> = {
  first_deposit: {
    id: "first_deposit",
    title: "First Deposit",
    description: "You made your first deposit!",
    icon: "💰",
    tier: "bronze",
  },
  saved_100: {
    id: "saved_100",
    title: "Century Saver",
    description: "You saved 100 USDC!",
    icon: "🎯",
    tier: "bronze",
  },
  saved_1000: {
    id: "saved_1000",
    title: "K Saver",
    description: "You saved 1,000 USDC!",
    icon: "🌟",
    tier: "silver",
  },
  saved_10000: {
    id: "saved_10000",
    title: "10K Champion",
    description: "You saved 10,000 USDC!",
    icon: "🏆",
    tier: "gold",
  },
  first_goal_created: {
    id: "first_goal_created",
    title: "Goal Setter",
    description: "You created your first savings goal!",
    icon: "🎯",
    tier: "bronze",
  },
  goal_completed: {
    id: "goal_completed",
    title: "Goal Crusher",
    description: "You completed your first savings goal!",
    icon: "🚀",
    tier: "silver",
  },
  streak_7_days: {
    id: "streak_7_days",
    title: "Week Warrior",
    description: "7-day savings streak!",
    icon: "🔥",
    tier: "bronze",
  },
  streak_30_days: {
    id: "streak_30_days",
    title: "Monthly Master",
    description: "30-day savings streak!",
    icon: "💎",
    tier: "gold",
  },
  first_group_joined: {
    id: "first_group_joined",
    title: "Team Player",
    description: "You joined your first savings group!",
    icon: "👥",
    tier: "bronze",
  },
  referral_signup: {
    id: "referral_signup",
    title: "Referral Rockstar",
    description: "A friend signed up using your referral!",
    icon: "🎁",
    tier: "silver",
  },
};

const STORAGE_KEY = "stow-milestones";

interface MilestoneContextValue {
  achievements: Set<MilestoneType>;
  isNewMilestone: MilestoneType | null;
  dismissMilestone: () => void;
  checkAndAwardMilestone: (
    type: MilestoneType,
    condition: boolean,
  ) => void;
  getMilestoneBadge: (type: MilestoneType) => Milestone | undefined;
  hasMilestone: (type: MilestoneType) => boolean;
}

const MilestoneContext = createContext<MilestoneContextValue | null>(null);

function readStoredMilestones(): Set<MilestoneType> {
  if (typeof window === "undefined") return new Set();
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return new Set(JSON.parse(stored) as MilestoneType[]);
    }
  } catch {
    // Ignore parse errors
  }
  return new Set();
}

function storeMilestones(milestones: Set<MilestoneType>) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...milestones]));
}

export function MilestoneProvider({ children }: { children: ReactNode }) {
  const [achievements, setAchievements] = useState<Set<MilestoneType>>(() =>
    readStoredMilestones(),
  );
  const [isNewMilestone, setIsNewMilestone] = useState<MilestoneType | null>(
    null,
  );
  const previousAchievementsRef = useRef(achievements);

  // Persist achievements to localStorage
  useEffect(() => {
    if (achievements.size > 0) {
      storeMilestones(achievements);
    }
  }, [achievements]);

  // Check for newly achieved milestones to trigger celebration
  useEffect(() => {
    const previous = previousAchievementsRef.current;
    const newAchievements = [...achievements].filter(
      (m) => !previous.has(m),
    );

    if (newAchievements.length > 0) {
      // Set the most recent milestone for celebration
      setIsNewMilestone(newAchievements[newAchievements.length - 1]);
    }

    previousAchievementsRef.current = achievements;
  }, [achievements]);

  const dismissMilestone = useCallback(() => {
    setIsNewMilestone(null);
  }, []);

  const checkAndAwardMilestone = useCallback(
    (type: MilestoneType, condition: boolean) => {
      if (condition && !achievements.has(type)) {
        setAchievements((prev) => new Set([...prev, type]));
      }
    },
    [achievements],
  );

  const getMilestoneBadge = useCallback(
    (type: MilestoneType): Milestone | undefined => {
      return achievements.has(type) ? MILESTONES[type] : undefined;
    },
    [achievements],
  );

  const hasMilestone = useCallback(
    (type: MilestoneType): boolean => {
      return achievements.has(type);
    },
    [achievements],
  );

  return (
    <MilestoneContext.Provider
      value={{
        achievements,
        isNewMilestone,
        dismissMilestone,
        checkAndAwardMilestone,
        getMilestoneBadge,
        hasMilestone,
      }}
    >
      {children}
    </MilestoneContext.Provider>
  );
}

export function useMilestones(): MilestoneContextValue {
  const ctx = useContext(MilestoneContext);
  if (!ctx) {
    throw new Error("useMilestones must be used within a MilestoneProvider");
  }
  return ctx;
}