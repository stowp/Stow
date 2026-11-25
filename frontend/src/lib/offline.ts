import { apiFetch } from "@/lib/api";

/**
 * Offline mode: a small localStorage-backed layer that lets the app keep
 * working without a connection.
 *
 * - **Cache** — successful reads of critical data (balance, summary,
 *   transaction history) are stored with the time they were fetched, and
 *   served back when the network is unavailable.
 * - **Queue** — deposits/withdrawals made while offline are stored in order,
 *   each with its own idempotency key so a replay can never double-apply.
 * - **Sync** — when the connection returns, queued operations are replayed
 *   in the order they were made. A request the server rejects (4xx, e.g. the
 *   balance changed and the withdrawal no longer fits) is marked as a
 *   *conflict* and kept for the user to review instead of being retried
 *   forever; a network/server failure stops the sync and leaves the rest of
 *   the queue for the next attempt.
 *
 * Every change is broadcast as an `OFFLINE_CHANGED_EVENT` window event so
 * all `useOffline` instances (and other tabs, via `storage`) stay in step.
 */

export const OFFLINE_CHANGED_EVENT = "stow:offline-changed";

const CACHE_PREFIX = "stow-offline-cache:";
const QUEUE_KEY = "stow-offline-queue";
const LAST_SYNC_KEY = "stow-offline-last-sync";

export type QueuedOperationType = "deposit" | "withdraw";

export type QueuedOperationStatus = "pending" | "syncing" | "conflict";

export interface QueuedOperation {
  id: string;
  type: QueuedOperationType;
  /** Account (Stellar address) the operation applies to. */
  account: string;
  /** Amount in stroops, as a string. */
  amount: string;
  /** ISO-8601 time the user made the request. */
  createdAt: string;
  /** Sent as `Idempotency-Key` so a replayed request is applied at most once. */
  idempotencyKey: string;
  status: QueuedOperationStatus;
  /** Why the server rejected the operation (set when `status` is "conflict"). */
  error?: string;
}

export interface CachedEntry<T> {
  data: T;
  /** ISO-8601 time the data was fetched from the server. */
  cachedAt: string;
}

export interface SyncResult {
  synced: QueuedOperation[];
  conflicts: QueuedOperation[];
  /** Operations still queued because the sync stopped on a network error. */
  remaining: QueuedOperation[];
  /** True when every pending operation was attempted (no network failure). */
  completed: boolean;
}

/** Sends one queued operation; resolves with the server's response. */
export type OperationExecutor = (op: QueuedOperation) => Promise<Response>;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled: offline support degrades quietly.
  }
}

function notify(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OFFLINE_CHANGED_EVENT));
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/** Best-effort connectivity check; assumes online outside the browser. */
export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

/** True for the errors `fetch` throws when the network is unreachable. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function writeCache<T>(key: string, data: T, now: Date = new Date()): void {
  writeJson(CACHE_PREFIX + key, {
    data,
    cachedAt: now.toISOString(),
  } satisfies CachedEntry<T>);
  setLastSyncAt(now);
}

export function readCache<T>(key: string): CachedEntry<T> | null {
  const entry = readJson<CachedEntry<T>>(CACHE_PREFIX + key);
  if (!entry || typeof entry.cachedAt !== "string" || !("data" in entry)) {
    return null;
  }
  return entry;
}

export function clearCache(): void {
  const store = storage();
  if (!store) return;
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(CACHE_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => store.removeItem(key));
  notify();
}

/** Cache keys for the critical data shown offline. */
export const cacheKeys = {
  summary: (address: string) => `summary:${address}`,
  balance: (address: string) => `balance:${address}`,
  deposits: (address: string) => `deposits:${address}`,
};

// ---------------------------------------------------------------------------
// Last sync
// ---------------------------------------------------------------------------

/** When data was last successfully fetched from, or synced to, the server. */
export function getLastSyncAt(): Date | null {
  const raw = readJson<string>(LAST_SYNC_KEY);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function setLastSyncAt(date: Date = new Date()): void {
  writeJson(LAST_SYNC_KEY, date.toISOString());
  notify();
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export function getQueue(): QueuedOperation[] {
  const queue = readJson<QueuedOperation[]>(QUEUE_KEY);
  return Array.isArray(queue) ? queue : [];
}

function saveQueue(queue: QueuedOperation[]): void {
  writeJson(QUEUE_KEY, queue);
  notify();
}

/** Adds a deposit/withdrawal to the end of the queue and returns it. */
export function enqueueOperation(
  input: Pick<QueuedOperation, "type" | "account" | "amount"> & {
    /** Reuse the key of an attempt that may already have reached the server. */
    idempotencyKey?: string;
  },
  now: Date = new Date(),
): QueuedOperation {
  const { idempotencyKey, ...rest } = input;
  const op: QueuedOperation = {
    ...rest,
    id: newId(),
    idempotencyKey: idempotencyKey ?? newId(),
    createdAt: now.toISOString(),
    status: "pending",
  };
  saveQueue([...getQueue(), op]);
  return op;
}

/** Removes an operation (e.g. a conflict the user has reviewed). */
export function removeOperation(id: string): void {
  saveQueue(getQueue().filter((op) => op.id !== id));
}

export function pendingOperations(queue: QueuedOperation[] = getQueue()) {
  return queue.filter((op) => op.status !== "conflict");
}

export function conflictedOperations(queue: QueuedOperation[] = getQueue()) {
  return queue.filter((op) => op.status === "conflict");
}

/** Default executor: mirrors the vault's flexible `deposit` / `withdraw`. */
export const sendOperation: OperationExecutor = (op) =>
  apiFetch(`/api/savings/flexible/${op.type}`, {
    method: "POST",
    headers: { "Idempotency-Key": op.idempotencyKey },
    body: JSON.stringify({ owner: op.account, amount: op.amount }),
  });

async function rejectionMessage(response: Response): Promise<string> {
  try {
    const body = await response.clone().json();
    if (body && typeof body.message === "string") return body.message;
  } catch {
    // Not JSON — fall through.
  }
  return `Rejected by the server (${response.status})`;
}

let activeSync: Promise<SyncResult> | null = null;

/**
 * Replays pending operations in order. Only one sync runs at a time; a call
 * while one is in flight returns the same promise.
 */
export function syncQueue(
  execute: OperationExecutor = sendOperation,
  now: () => Date = () => new Date(),
): Promise<SyncResult> {
  if (activeSync) return activeSync;
  activeSync = runSync(execute, now).finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function runSync(
  execute: OperationExecutor,
  now: () => Date,
): Promise<SyncResult> {
  const synced: QueuedOperation[] = [];
  const conflicts: QueuedOperation[] = [];
  let completed = true;

  for (const op of pendingOperations()) {
    updateOperation(op.id, { status: "syncing" });

    let response: Response;
    try {
      response = await execute(op);
    } catch {
      // Network failure: keep this and later operations for the next sync.
      updateOperation(op.id, { status: "pending" });
      completed = false;
      break;
    }

    if (response.ok) {
      synced.push(op);
      removeOperation(op.id);
    } else if (response.status >= 400 && response.status < 500) {
      // The server refused it (insufficient balance, duplicate, validation…):
      // retrying won't help, so surface it for the user to resolve.
      const conflict: QueuedOperation = {
        ...op,
        status: "conflict",
        error: await rejectionMessage(response),
      };
      conflicts.push(conflict);
      updateOperation(op.id, { status: "conflict", error: conflict.error });
    } else {
      // 5xx: transient; stop and retry later.
      updateOperation(op.id, { status: "pending" });
      completed = false;
      break;
    }
  }

  if (synced.length > 0 || (completed && conflicts.length === 0)) {
    setLastSyncAt(now());
  }

  return { synced, conflicts, remaining: pendingOperations(), completed };
}

function updateOperation(id: string, patch: Partial<QueuedOperation>): void {
  saveQueue(getQueue().map((op) => (op.id === id ? { ...op, ...patch } : op)));
}

// ---------------------------------------------------------------------------
// Cached fetch
// ---------------------------------------------------------------------------

export interface OfflineFetchResult<T> {
  data: T;
  /** True when the network failed and `data` came from the cache. */
  fromCache: boolean;
  cachedAt: string | null;
}

/**
 * Loads `load()` and caches the result under `key`. If loading fails while
 * offline (or with a network error) and a cached copy exists, the cached
 * copy is returned instead; otherwise the original error is rethrown.
 */
export async function withOfflineCache<T>(
  key: string,
  load: () => Promise<T>,
): Promise<OfflineFetchResult<T>> {
  try {
    const data = await load();
    writeCache(key, data);
    return { data, fromCache: false, cachedAt: null };
  } catch (err) {
    if (!isOnline() || isNetworkError(err)) {
      const cached = readCache<T>(key);
      if (cached) {
        return { data: cached.data, fromCache: true, cachedAt: cached.cachedAt };
      }
    }
    throw err;
  }
}
