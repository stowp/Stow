import { useState, useCallback, useEffect, useRef } from "react";
import { apiFetch, ApiError } from "@/lib/api";

/** Notification as rendered by the app (normalized from the API entity). */
export interface AppNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

/** Shape of `Notification` as serialized by the backend (snake_case, bigint id). */
interface ApiNotification {
  id: number | string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
}

interface NotificationListResponse {
  data: ApiNotification[];
  total: number;
  unreadCount: number;
}

export interface UseNotificationsOptions {
  /** Page size for the initial fetch. Defaults to 20. */
  limit?: number;
  /** Subscribe to the SSE stream for live updates. Defaults to `true`. */
  live?: boolean;
}

export interface UseNotificationsReturn {
  notifications: AppNotification[];
  unreadCount: number;
  isLoading: boolean;
  error: Error | null;
  /** `true` while the SSE stream is connected. */
  isLive: boolean;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  refetch: () => Promise<void>;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

export function toAppNotification(raw: ApiNotification): AppNotification {
  return {
    id: String(raw.id),
    type: raw.type,
    title: raw.title,
    message: raw.message,
    data: raw.data ?? null,
    read: Boolean(raw.read),
    createdAt: raw.created_at,
  };
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental `text/event-stream` parser. Feed it decoded chunks as they
 * arrive; it returns every event completed by that chunk and buffers the
 * rest. Follows the WHATWG framing rules the backend's `@Sse` emits:
 * blank-line-terminated events, multi-line `data:`, `:` comment lines.
 */
export function createSseParser(): (chunk: string) => SseEvent[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const blocks = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = blocks.pop() ?? "";

    const events: SseEvent[] = [];
    for (const block of blocks) {
      let event = "message";
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split(/\r\n|\n|\r/)) {
        if (line === "" || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        else if (field === "id") id = value;
      }
      if (data.length > 0) events.push({ event, data: data.join("\n"), id });
    }
    return events;
  };
}

async function errorFromResponse(
  response: Response,
  fallback: string,
): Promise<ApiError> {
  let message = `${fallback}: ${response.statusText}`;
  try {
    const body = await response.json();
    if (body?.message) message = body.message;
  } catch {
    // Response body is not JSON, use default message
  }
  return new ApiError(message, response.status);
}

/**
 * Loads the signed-in user's notifications and keeps them current via the
 * backend's SSE stream (`GET /api/notifications/:address/stream`).
 *
 * The stream is read with `fetch` rather than `EventSource` because the
 * endpoint is JWT-guarded and `EventSource` cannot send an `Authorization`
 * header. The stream does not replay history, so the list is re-fetched on
 * every reconnect to pick up anything missed while disconnected.
 */
export function useNotifications(
  address: string | null,
  options?: UseNotificationsOptions,
): UseNotificationsReturn {
  const { limit = 20, live = true } = options ?? {};

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(Boolean(address));
  const [error, setError] = useState<Error | null>(null);
  const [isLive, setIsLive] = useState(false);

  // Latest values, for optimistic updates that need to roll back.
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;
  const unreadCountRef = useRef(unreadCount);
  unreadCountRef.current = unreadCount;
  // Ids already in the list, so a stream event racing the initial fetch
  // (or re-sent after a reconnect) is never shown or counted twice.
  const seenIdsRef = useRef<Set<string>>(new Set());
  // Stream events received while a fetch is in flight (oldest first); merged
  // into the fetched page so the response can't wipe them out.
  const receivedDuringFetchRef = useRef<AppNotification[]>([]);

  const fetchNotifications = useCallback(async () => {
    if (!address) return;
    setIsLoading(true);
    setError(null);
    receivedDuringFetchRef.current = [];

    try {
      const response = await apiFetch(
        `/api/notifications/${encodeURIComponent(address)}?page=1&limit=${limit}`,
        { method: "GET" },
      );
      if (!response.ok) {
        throw await errorFromResponse(response, "Failed to load notifications");
      }
      const result: NotificationListResponse = await response.json();
      const fetched = result.data.map(toAppNotification);
      const fetchedIds = new Set(fetched.map((n) => n.id));
      const missed = receivedDuringFetchRef.current
        .filter((n) => !fetchedIds.has(n.id))
        .reverse();
      const list = [...missed, ...fetched];
      seenIdsRef.current = new Set(list.map((n) => n.id));
      setNotifications(list);
      setUnreadCount(
        result.unreadCount + missed.filter((n) => !n.read).length,
      );
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Unknown error occurred"));
    } finally {
      receivedDuringFetchRef.current = [];
      setIsLoading(false);
    }
  }, [address, limit]);

  useEffect(() => {
    if (!address) {
      seenIdsRef.current = new Set();
      setNotifications([]);
      setUnreadCount(0);
      setIsLoading(false);
      return;
    }
    fetchNotifications();
  }, [address, fetchNotifications]);

  const receive = useCallback((incoming: AppNotification) => {
    if (seenIdsRef.current.has(incoming.id)) return;
    seenIdsRef.current.add(incoming.id);
    receivedDuringFetchRef.current.push(incoming);
    setNotifications((current) => [incoming, ...current]);
    if (!incoming.read) setUnreadCount((count) => count + 1);
  }, []);

  // --- live stream ---------------------------------------------------------
  useEffect(() => {
    if (!address || !live) return;

    const controller = new AbortController();
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        const response = await apiFetch(
          `/api/notifications/${encodeURIComponent(address)}/stream`,
          {
            method: "GET",
            headers: { Accept: "text/event-stream" },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) {
          throw new ApiError("Notification stream unavailable", response.status);
        }

        setIsLive(true);
        if (attempt > 0) fetchNotifications();
        attempt = 0;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parse = createSseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const event of parse(decoder.decode(value, { stream: true }))) {
            if (event.event !== "notification") continue;
            try {
              receive(toAppNotification(JSON.parse(event.data)));
            } catch {
              // Malformed payload — skip it rather than drop the stream.
            }
          }
        }
      } catch (err) {
        // 401 means the session is gone (apiFetch already cleared it);
        // retrying would just spin.
        if (err instanceof ApiError && err.status === 401) {
          setIsLive(false);
          return;
        }
      }

      if (controller.signal.aborted) return;
      setIsLive(false);
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      setIsLive(false);
    };
  }, [address, live, receive, fetchNotifications]);

  // --- mutations -------------------------------------------------------------
  const markAsRead = useCallback(async (id: string) => {
    const target = notificationsRef.current.find((n) => n.id === id);
    if (!target || target.read) return;

    // Optimistic: flip locally, roll back if the server rejects it.
    setNotifications((current) =>
      current.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
    setUnreadCount((count) => Math.max(0, count - 1));

    try {
      const response = await apiFetch(
        `/api/notifications/${encodeURIComponent(id)}/read`,
        { method: "PATCH" },
      );
      if (!response.ok) {
        throw await errorFromResponse(response, "Failed to mark notification as read");
      }
    } catch (err) {
      setNotifications((current) =>
        current.map((n) => (n.id === id ? { ...n, read: false } : n)),
      );
      setUnreadCount((count) => count + 1);
      setError(err instanceof Error ? err : new Error("Unknown error occurred"));
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    const previous = notificationsRef.current;
    const previousUnread = unreadCountRef.current;
    setUnreadCount(0);
    setNotifications((current) => current.map((n) => ({ ...n, read: true })));

    try {
      const response = await apiFetch("/api/notifications/read-all", {
        method: "PATCH",
      });
      if (!response.ok) {
        throw await errorFromResponse(response, "Failed to mark all as read");
      }
      const result: { unreadCount: number } = await response.json();
      setUnreadCount(result.unreadCount);
    } catch (err) {
      setNotifications(previous);
      setUnreadCount(previousUnread);
      setError(err instanceof Error ? err : new Error("Unknown error occurred"));
    }
  }, []);

  return {
    notifications,
    unreadCount,
    isLoading,
    error,
    isLive,
    markAsRead,
    markAllAsRead,
    refetch: fetchNotifications,
  };
}
