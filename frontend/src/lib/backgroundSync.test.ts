import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getSyncQueue,
  addToSyncQueue,
  removeFromSyncQueue,
  incrementRetryCount,
  clearSyncQueue,
  getPendingSyncCount,
  queueDeposit,
  queueWithdrawal,
  queueGoalUpdate,
  processSyncQueue,
  isBackgroundSyncSupported,
} from "./backgroundSync";

describe("backgroundSync", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe("getSyncQueue", () => {
    it("returns empty array when no queue exists", () => {
      expect(getSyncQueue()).toEqual([]);
    });

    it("returns queued items", () => {
      localStorage.setItem(
        "stow-sync-queue",
        JSON.stringify([
          { id: "test-1", type: "deposit", payload: {}, timestamp: 123, retries: 0 },
        ]),
      );

      const queue = getSyncQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe("test-1");
    });
  });

  describe("addToSyncQueue", () => {
    it("adds item to queue", () => {
      addToSyncQueue({
        id: "deposit-1",
        type: "deposit",
        payload: { amount: 100 },
      });

      const queue = getSyncQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe("deposit-1");
      expect(queue[0].type).toBe("deposit");
      expect(queue[0].retries).toBe(0);
      expect(queue[0].timestamp).toBeDefined();
    });

    it("adds multiple items to queue", () => {
      addToSyncQueue({ id: "1", type: "deposit", payload: {} });
      addToSyncQueue({ id: "2", type: "withdrawal", payload: {} });

      const queue = getSyncQueue();
      expect(queue).toHaveLength(2);
    });
  });

  describe("removeFromSyncQueue", () => {
    it("removes item by id", () => {
      addToSyncQueue({ id: "test-1", type: "deposit", payload: {} });
      addToSyncQueue({ id: "test-2", type: "withdrawal", payload: {} });

      removeFromSyncQueue("test-1");

      const queue = getSyncQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe("test-2");
    });
  });

  describe("incrementRetryCount", () => {
    it("increments retry count", () => {
      addToSyncQueue({ id: "test-1", type: "deposit", payload: {} });

      const result = incrementRetryCount("test-1");

      expect(result).toBe(true);
      const queue = getSyncQueue();
      expect(queue[0].retries).toBe(1);
    });

    it("removes item after max retries", () => {
      addToSyncQueue({ id: "test-1", type: "deposit", payload: {} });

      incrementRetryCount("test-1");
      incrementRetryCount("test-1");
      const result = incrementRetryCount("test-1");

      expect(result).toBe(false);
      expect(getSyncQueue()).toHaveLength(0);
    });
  });

  describe("clearSyncQueue", () => {
    it("clears all items", () => {
      addToSyncQueue({ id: "1", type: "deposit", payload: {} });
      addToSyncQueue({ id: "2", type: "withdrawal", payload: {} });

      clearSyncQueue();

      expect(getSyncQueue()).toHaveLength(0);
    });
  });

  describe("getPendingSyncCount", () => {
    it("returns correct count", () => {
      expect(getPendingSyncCount()).toBe(0);

      addToSyncQueue({ id: "1", type: "deposit", payload: {} });
      expect(getPendingSyncCount()).toBe(1);

      addToSyncQueue({ id: "2", type: "withdrawal", payload: {} });
      expect(getPendingSyncCount()).toBe(2);
    });
  });

  describe("queueDeposit", () => {
    it("queues deposit with correct structure", () => {
      queueDeposit({ amount: 100, method: "bank", goalId: "goal-1" });

      const queue = getSyncQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].type).toBe("deposit");
      expect(queue[0].payload).toEqual({
        amount: 100,
        method: "bank",
        goalId: "goal-1",
      });
    });
  });

  describe("queueWithdrawal", () => {
    it("queues withdrawal with correct structure", () => {
      queueWithdrawal({ amount: 50, method: "wallet" });

      const queue = getSyncQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].type).toBe("withdrawal");
      expect(queue[0].payload).toEqual({
        amount: 50,
        method: "wallet",
      });
    });
  });

  describe("queueGoalUpdate", () => {
    it("queues goal update with correct structure", () => {
      queueGoalUpdate({
        goalId: "goal-1",
        action: "create",
        data: { name: "Test Goal", target: 1000 },
      });

      const queue = getSyncQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].type).toBe("goal");
      expect(queue[0].payload).toEqual({
        goalId: "goal-1",
        action: "create",
        data: { name: "Test Goal", target: 1000 },
      });
    });
  });

  describe("processSyncQueue", () => {
    it("processes successful items", async () => {
      addToSyncQueue({ id: "1", type: "deposit", payload: {} });
      addToSyncQueue({ id: "2", type: "withdrawal", payload: {} });

      const processItem = vi.fn().mockResolvedValue(true);

      const result = await processSyncQueue(processItem);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(getSyncQueue()).toHaveLength(0);
    });

    it("handles failed items", async () => {
      addToSyncQueue({ id: "1", type: "deposit", payload: {} });

      const processItem = vi.fn().mockResolvedValue(false);

      await processSyncQueue(processItem);

      expect(processItem).toHaveBeenCalled();
      // Item should be removed after max retries
    });
  });

  describe("isBackgroundSyncSupported", () => {
    it("returns false when service worker not available", () => {
      expect(isBackgroundSyncSupported()).toBe(false);
    });
  });
});