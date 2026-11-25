'use client';

import { useOffline } from '@/hooks/useOffline';

function formatLastSync(date: Date | null): string {
  if (!date) return 'Never synced';
  return `Last synced ${date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * App-wide connectivity banner. While offline it says so, shows when data
 * was last synced (so cached balances are read in context), and how many
 * deposits/withdrawals are queued. Once back online it shows sync progress
 * and any queued operations the server rejected, which the user dismisses
 * after reviewing.
 */
export function OfflineIndicator() {
  const { isOnline, pending, conflicts, isSyncing, lastSyncAt, sync, dismiss } =
    useOffline();

  if (isOnline && pending.length === 0 && conflicts.length === 0) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-indicator"
      className={`fixed top-0 left-0 right-0 z-50 px-4 py-2 text-center text-sm font-medium text-white shadow-lg ${
        isOnline ? 'bg-brand' : 'bg-yellow-500'
      }`}
    >
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        {!isOnline ? (
          <>
            <svg
              className="w-5 h-5 animate-pulse"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3"
              />
            </svg>
            <span>You&apos;re offline. Showing saved data.</span>
          </>
        ) : isSyncing ? (
          <span>Syncing {plural(pending.length, 'queued operation')}…</span>
        ) : pending.length > 0 ? (
          <>
            <span>{plural(pending.length, 'operation')} waiting to sync.</span>
            <button
              type="button"
              onClick={() => void sync()}
              className="rounded underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-white/70"
            >
              Sync now
            </button>
          </>
        ) : null}

        {!isOnline && pending.length > 0 && (
          <span data-testid="offline-queue-count">
            {plural(pending.length, 'operation')} queued
          </span>
        )}

        <span data-testid="offline-last-sync" className="opacity-90">
          {formatLastSync(lastSyncAt)}
        </span>
      </div>

      {conflicts.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="offline-conflicts">
          {conflicts.map((op) => (
            <li
              key={op.id}
              className="flex flex-wrap items-center justify-center gap-2"
            >
              <span>
                Queued {op.type} couldn&apos;t be completed: {op.error}
              </span>
              <button
                type="button"
                onClick={() => dismiss(op.id)}
                className="rounded underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-white/70"
              >
                Dismiss
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
