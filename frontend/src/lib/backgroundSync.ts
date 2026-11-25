/**
 * Background sync utilities for offline support
 */

export interface SyncQueueItem {
  id: string;
  type: "deposit" | "withdrawal" | "transfer" | "goal" | "settings";
  payload: Record<string, unknown>;
  timestamp: number;
  retries: number;
}

const SYNC_QUEUE_KEY = "stow-sync-queue";
const MAX_RETRIES = 3;

/**
 * Get the sync queue from storage
 */
export function getSyncQueue(): SyncQueueItem[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(SYNC_QUEUE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

/**
 * Add an item to the sync queue
 */
export function addToSyncQueue(item: Omit<SyncQueueItem, "timestamp" | "retries">): void {
  if (typeof window === "undefined") return;

  const queue = getSyncQueue();
  const newItem: SyncQueueItem = {
    ...item,
    timestamp: Date.now(),
    retries: 0,
  };

  queue.push(newItem);
  localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));

  // Try to trigger sync
  requestBackgroundSync();
}

/**
 * Remove an item from the sync queue
 */
export function removeFromSyncQueue(id: string): void {
  if (typeof window === "undefined") return;

  const queue = getSyncQueue();
  const filtered = queue.filter((item) => item.id !== id);
  localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(filtered));
}

/**
 * Update retry count for an item
 */
export function incrementRetryCount(id: string): boolean {
  if (typeof window === "undefined") return false;

  const queue = getSyncQueue();
  const item = queue.find((i) => i.id === id);

  if (!item) return false;

  item.retries += 1;

  if (item.retries >= MAX_RETRIES) {
    // Remove failed items after max retries
    removeFromSyncQueue(id);
    return false;
  }

  localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
  return true;
}

/**
 * Request background sync if available
 */
export async function requestBackgroundSync(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  if (!("serviceWorker" in navigator) || !("sync" in ServiceWorkerRegistration.prototype)) {
    console.log("Background sync not supported");
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    await (registration as any).sync.register("stow-sync");
    return true;
  } catch (error) {
    console.error("Failed to register background sync:", error);
    return false;
  }
}

/**
 * Check if Background Sync is supported
 */
export function isBackgroundSyncSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "sync" in ServiceWorkerRegistration.prototype
  );
}

/**
 * Process sync queue manually (fallback when sync not available)
 */
export async function processSyncQueue(
  processItem: (item: SyncQueueItem) => Promise<boolean>,
): Promise<{ success: number; failed: number }> {
  const queue = getSyncQueue();
  let success = 0;
  let failed = 0;

  for (const item of queue) {
    try {
      const result = await processItem(item);
      if (result) {
        removeFromSyncQueue(item.id);
        success++;
      } else {
        if (!incrementRetryCount(item.id)) {
          failed++;
        }
      }
    } catch {
      if (!incrementRetryCount(item.id)) {
        failed++;
      }
    }
  }

  return { success, failed };
}

/**
 * Clear the sync queue
 */
export function clearSyncQueue(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(SYNC_QUEUE_KEY);
}

/**
 * Get pending sync count
 */
export function getPendingSyncCount(): number {
  return getSyncQueue().length;
}

/**
 * Queue a deposit for background sync
 */
export function queueDeposit(depositData: {
  amount: number;
  method: string;
  goalId?: string;
}): void {
  addToSyncQueue({
    id: `deposit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type: "deposit",
    payload: depositData,
  });
}

/**
 * Queue a withdrawal for background sync
 */
export function queueWithdrawal(withdrawalData: {
  amount: number;
  method: string;
  goalId?: string;
}): void {
  addToSyncQueue({
    id: `withdrawal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type: "withdrawal",
    payload: withdrawalData,
  });
}

/**
 * Queue a goal creation/update for background sync
 */
export function queueGoalUpdate(goalData: {
  goalId: string;
  action: "create" | "update" | "delete";
  data: Record<string, unknown>;
}): void {
  addToSyncQueue({
    id: `goal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type: "goal",
    payload: goalData,
  });
}