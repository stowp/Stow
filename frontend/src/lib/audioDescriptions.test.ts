import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  describeChart,
  describeSavingsStats,
  describeGoal,
  describeTransaction,
  isSupported,
  speak,
  cancel,
} from "./audioDescriptions";

// Mock speech synthesis
class MockSpeechSynthesisUtterance {
  text: string;
  rate: number = 1;
  pitch: number = 1;
  volume: number = 1;
  lang: string = "en-US";
  voice: any = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

class MockSpeechSynthesis {
  speaking = false;
  pending = false;
  paused = false;
  voices: any[] = [];

  speak = vi.fn();
  cancel = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
  getVoices = vi.fn(() => []);
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

describe("audioDescriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("describeChart", () => {
    it("generates description with summary", () => {
      const data = [
        { label: "January", value: 1000, unit: "USDC" },
        { label: "February", value: 1500, unit: "USDC" },
      ];

      const result = describeChart("bar", data, "Shows monthly savings");

      expect(result).toContain("bar chart");
      expect(result).toContain("Shows monthly savings");
      expect(result).toContain("January: 1,000 USDC");
      expect(result).toContain("February: 1,500 USDC");
    });

    it("generates description without summary", () => {
      const data = [{ label: "Q1", value: 5000 }];

      const result = describeChart("pie", data);

      expect(result).toContain("pie chart");
      expect(result).toContain("Q1: 5,000");
      expect(result).not.toContain("Data points");
    });
  });

  describe("describeSavingsStats", () => {
    it("generates complete stats description", () => {
      const stats = {
        totalSaved: 5000,
        goalsCompleted: 3,
        currentStreak: 7,
        totalDeposits: 15,
      };

      const result = describeSavingsStats(stats);

      expect(result).toContain("Total saved: 5,000 USDC");
      expect(result).toContain("Goals completed: 3");
      expect(result).toContain("Current streak: 7 days");
      expect(result).toContain("Total deposits: 15");
    });
  });

  describe("describeGoal", () => {
    it("generates description for incomplete goal", () => {
      const goal = {
        name: "Emergency Fund",
        targetAmount: 10000,
        currentAmount: 5000,
      };

      const result = describeGoal(goal);

      expect(result).toContain("Goal: Emergency Fund");
      expect(result).toContain("Target: 10,000 USDC");
      expect(result).toContain("Current: 5,000 USDC");
      expect(result).toContain("Progress: 50 percent");
      expect(result).toContain("5,000 USDC remaining");
    });

    it("generates description for completed goal", () => {
      const goal = {
        name: "Vacation",
        targetAmount: 2000,
        currentAmount: 2000,
        deadline: "December 31, 2024",
      };

      const result = describeGoal(goal);

      expect(result).toContain("Progress: 100 percent");
      expect(result).toContain("Goal achieved!");
      expect(result).toContain("Deadline: December 31, 2024");
    });
  });

  describe("describeTransaction", () => {
    it("generates description for deposit", () => {
      const transaction = {
        type: "deposit" as const,
        amount: 100,
        currency: "USDC",
        timestamp: "January 15, 2024 at 2:30 PM",
      };

      const result = describeTransaction(transaction);

      expect(result).toContain("deposit: 100 USDC");
      expect(result).toContain("January 15, 2024 at 2:30 PM");
    });

    it("generates description for transfer with recipient", () => {
      const transaction = {
        type: "transfer" as const,
        amount: 500,
        recipient: "John",
        timestamp: "Yesterday",
      };

      const result = describeTransaction(transaction);

      expect(result).toContain("transfer: 500 USDC");
      expect(result).toContain("to John");
    });
  });

  describe("speak", () => {
    it("returns false when window is undefined", () => {
      const originalWindow = global.window;
      // @ts-ignore
      delete global.window;

      const result = speak("test");

      expect(result).toBe(false);
      global.window = originalWindow;
    });

    it("calls speech synthesis when available", () => {
      const mockSynthesis = new MockSpeechSynthesis();
      // @ts-ignore
      global.window.speechSynthesis = mockSynthesis;

      const result = speak("Hello");

      expect(result).toBe(true);
      expect(mockSynthesis.speak).toHaveBeenCalled();
    });
  });

  describe("cancel", () => {
    it("cancels speech synthesis", () => {
      const mockSynthesis = new MockSpeechSynthesis();
      // @ts-ignore
      global.window.speechSynthesis = mockSynthesis;

      cancel();

      expect(mockSynthesis.cancel).toHaveBeenCalled();
    });
  });

  describe("isSupported", () => {
    it("returns false when speech synthesis not available", () => {
      // @ts-ignore
      delete global.window.speechSynthesis;

      expect(isSupported()).toBe(false);
    });
  });
});