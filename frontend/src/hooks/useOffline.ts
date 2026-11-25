"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  OFFLINE_CHANGED_EVENT,
  conflictedOperations,
  enqueueOperation,
  getLastSyncAt,
  getQueue,
  isOnline as readOnline,
  pendingOperations,
  removeOperation,
  syncQueue,
  type OperationExecutor,
  type QueuedOperation,
  type QueuedOperationType,
  type SyncResult,
} from "@/lib/offline";

export interface UseOfflineOptions {
  /** Replays a queued operation; defaults to the flexible deposit/withdraw API. */
  execute?: OperationExecutor;
  /** Sync automatically when the connection comes back. Defaults to true. */
  autoSync?: boolean;
}

export interface UseOfflineReturn {
  isOnline: boolean;
  /** Operations waiting to be sent. */
  pending: QueuedOperation[];
  /** Operations the server rejected during sync, awaiting the user's review. */
  conflicts: QueuedOperation[];
  isSyncing: boolean;
  /** Last time data was fetched from, or synced to, the server. */
  lastSyncAt: Date | null;
  /** Queue a deposit/withdrawal (amount in stroops) to send when online. */
  queueOperation: (
    type: QueuedOperationType,
    account: string,
    amount: string,
  ) => QueuedOperation;
  /** Replay pending operations now. Resolves to `null` while offline. */
  sync: () => Promise<SyncResult | null>;
  /** Drop a conflicted (or pending) operation from the queue. */
  dismiss: (id: string) => void;
}

/**
 * Connectivity + offline-queue state for the app (see `@/lib/offline`).
 * Tracks `online`/`offline` events, mirrors the persisted queue and last
 * sync time, and replays queued operations as soon as the connection
 * returns.
 */
export function useOffline({
  execute,
  autoSync = true,
}: UseOfflineOptions = {}): UseOfflineReturn {
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueuedOperation[]>([]);
  const [lastSyncAt, setLastSyncAtState] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const executeRef = useRef(execute);
  executeRef.current = execute;

  const refresh = useCallback(() => {
    setQueue(getQueue());
    setLastSyncAtState(getLastSyncAt());
  }, []);

  const sync = useCallback(async (): Promise<SyncResult | null> => {
    if (!readOnline()) return null;
    setIsSyncing(true);
    try {
      return await syncQueue(executeRef.current);
    } finally {
      setIsSyncing(false);
      refresh();
    }
  }, [refresh]);

  useEffect(() => {
    setOnline(readOnline());
    refresh();

    const handleOnline = () => {
      setOnline(true);
      if (autoSync && pendingOperations().length > 0) void sync();
    };
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith("stow-offline")) refresh();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener(OFFLINE_CHANGED_EVENT, refresh);
    window.addEventListener("storage", handleStorage);

    // Anything left over from a previous session goes out on load.
    if (autoSync && readOnline() && pendingOperations().length > 0) void sync();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener(OFFLINE_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", handleStorage);
    };
  }, [autoSync, refresh, sync]);

  const queueOperation = useCallback(
    (type: QueuedOperationType, account: string, amount: string) =>
      enqueueOperation({ type, account, amount }),
    [],
  );

  const dismiss = useCallback((id: string) => removeOperation(id), []);

  return {
    isOnline: online,
    pending: pendingOperations(queue),
    conflicts: conflictedOperations(queue),
    isSyncing,
    lastSyncAt,
    queueOperation,
    sync,
    dismiss,
  };
}
