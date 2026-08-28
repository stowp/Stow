"use client";

import { useRouter } from "next/navigation";
import { Target } from "lucide-react";
import GoalForm from "@/components/savings/GoalForm";

export default function NewGoalPage() {
  const router = useRouter();

  const handleCreated = (goalId: string) => {
    router.push(`/savings/goals/${goalId}`);
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Target className="h-8 w-8 text-brand" />
            <h1 className="text-3xl font-semibold text-foreground">
              Create a Goal
            </h1>
          </div>
          <p className="text-muted">
            Set a savings target and track your progress until you reach it.
          </p>
        </div>

        <GoalForm onCreated={handleCreated} />
      </div>
    </div>
  );
}
