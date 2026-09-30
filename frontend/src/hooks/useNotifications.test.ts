import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useNotifications, createSseParser } from "./useNotifications";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockApiFetch = vi.mocked(api.apiFetch);

const ADDRESS = "GUSER123";

function apiNotification(id: number, read = false) {
  return {
    id,
    type: "deposit",
    title: `Title ${id}`,
    message: `Message ${id}`,
    data: null,
    read,
    created_at: "2026-09-01T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

/** A streaming body that yields `chunks`, then stays open (never ends). */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = {
    getReader: () => ({
      read: () =>
        index < chunks.length
          ? Promise.resolve({ value: encoder.encode(chunks[index++]), done: false })
          : new Promise(() => {}),
    }),
  };
  return { ok: true, status: 200, body } as unknown as Response;
}

function listResponse(items: ReturnType<typeof apiNotification>[], unreadCount: number) {
  return jsonResponse({ data: items, total: items.length, unreadCount });
}

describe("createSseParser", () => {
  it("parses events split across chunks, multi-line data and comments", () => {
    const parse = createSseParser();
    expect(parse(": keep-alive\n\nevent: notification\nid: 7\ndata: {\"a\"")).toEqual([]);
    expect(parse(":1}\n\ndata: line1\ndata: line2\n\n")).toEqual([
      { event: "notification", id: "7", data: '{"a":1}' },
      { event: "message", id: undefined, data: "line1\nline2" },
    ]);
  });
});

describe("useNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing without an address", () => {
    const { result } = renderHook(() => useNotifications(null));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.notifications).toEqual([]);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it("loads and normalizes notifications on mount", async () => {
    mockApiFetch.mockResolvedValueOnce(
      listResponse([apiNotification(2), apiNotification(1, true)], 1),
    );

    const { result } = renderHook(() =>
      useNotifications(ADDRESS, { live: false }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/notifications/${ADDRESS}?page=1&limit=20`,
      { method: "GET" },
    );
    expect(result.current.notifications).toEqual([
      {
        id: "2",
        type: "deposit",
        title: "Title 2",
        message: "Message 2",
        data: null,
        read: false,
        createdAt: "2026-09-01T00:00:00.000Z",
      },
      expect.objectContaining({ id: "1", read: true }),
    ]);
    expect(result.current.unreadCount).toBe(1);
  });

  it("surfaces a load error", async () => {
    mockApiFetch.mockResolvedValueOnce(
      jsonResponse({ message: "Boom" }, false, 500),
    );
    const { result } = renderHook(() =>
      useNotifications(ADDRESS, { live: false }),
    );
    await waitFor(() => expect(result.current.error?.message).toBe("Boom"));
  });

  it("marks a notification as read", async () => {
    mockApiFetch
      .mockResolvedValueOnce(listResponse([apiNotification(1)], 1))
      .mockResolvedValueOnce(jsonResponse(undefined));

    const { result } = renderHook(() =>
      useNotifications(ADDRESS, { live: false }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.markAsRead("1"));

    expect(mockApiFetch).toHaveBeenLastCalledWith("/api/notifications/1/read", {
      method: "PATCH",
    });
    expect(result.current.notifications[0].read).toBe(true);
    expect(result.current.unreadCount).toBe(0);
  });

  it("rolls back mark-as-read when the request fails", async () => {
    mockApiFetch
      .mockResolvedValueOnce(listResponse([apiNotification(1)], 1))
      .mockResolvedValueOnce(jsonResponse({}, false, 500));

    const { result } = renderHook(() =>
      useNotifications(ADDRESS, { live: false }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.markAsRead("1"));

    expect(result.current.notifications[0].read).toBe(false);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.error).not.toBeNull();
  });

  it("marks all notifications as read", async () => {
    mockApiFetch
      .mockResolvedValueOnce(
        listResponse([apiNotification(2), apiNotification(1)], 2),
      )
      .mockResolvedValueOnce(jsonResponse({ unreadCount: 0 }));

    const { result } = renderHook(() =>
      useNotifications(ADDRESS, { live: false }),
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.markAllAsRead());

    expect(mockApiFetch).toHaveBeenLastCalledWith(
      "/api/notifications/read-all",
      { method: "PATCH" },
    );
    expect(result.current.notifications.every((n) => n.read)).toBe(true);
    expect(result.current.unreadCount).toBe(0);
  });

  it("prepends live notifications from the SSE stream, ignoring duplicates", async () => {
    const event = (id: number) =>
      `event: notification\nid: ${id}\ndata: ${JSON.stringify(apiNotification(id))}\n\n`;

    mockApiFetch.mockImplementation(async (input) => {
      if (String(input).endsWith("/stream")) {
        return sseResponse([event(2), event(1), event(3)]);
      }
      return listResponse([apiNotification(1)], 1);
    });

    const { result } = renderHook(() => useNotifications(ADDRESS));

    await waitFor(() =>
      expect(result.current.notifications.map((n) => n.id)).toEqual([
        "3",
        "2",
        "1",
      ]),
    );
    expect(result.current.unreadCount).toBe(3);
    expect(result.current.isLive).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/notifications/${ADDRESS}/stream`,
      expect.objectContaining({
        headers: { Accept: "text/event-stream" },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
