import { renderHook, act, waitFor } from "@testing-library/react";
import { useBalanceWebSocket, useRealtimeBalance } from "./useBalanceWebSocket";

// Mock WebSocket
const mockWebSocket = {
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  close: jest.fn(),
  send: jest.fn(),
};

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 10);
  }

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  close() {
    this.onclose?.();
  }

  send(data: string) {
    // Handle subscribe/unsubscribe messages
  }
}

jest.mock("react", () => {
  const actual = jest.requireActual("react");
  return {
    ...actual,
    useEffect: jest.fn(),
    useCallback: jest.fn((fn, deps) => fn),
    useState: jest.fn((initial) => [initial, jest.fn()]),
    useRef: jest.fn((initial) => ({ current: initial })),
  };
});

jest.mock("@/lib/api", () => ({
  apiFetch: jest.fn(),
}));

describe("useBalanceWebSocket", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    jest.clearAllMocks();
    (global as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    delete (global as any).WebSocket;
  });

  it("should connect when address is provided", async () => {
    const { result } = renderHook(() => useBalanceWebSocket("GABC123"));

    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });
  });

  it("should update balance on WebSocket message", async () => {
    const { result } = renderHook(() => useBalanceWebSocket("GABC123"));

    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          account: "GABC123",
          amount: "1000000",
          updated_at: new Date().toISOString(),
        }),
      });
    });

    expect(result.current.latestBalance).toEqual({
      account: "GABC123",
      amount: "1000000",
      updated_at: expect.any(String),
    });
  });

  it("should handle reconnection on disconnect", async () => {
    const { result } = renderHook(() => useBalanceWebSocket("GABC123"));

    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.onclose?.();
    });

    await waitFor(() => {
      expect(result.current.status).toBe("reconnecting");
    });
  });

  it("should not connect when address is null", () => {
    const { result } = renderHook(() => useBalanceWebSocket(null));

    expect(result.current.status).toBe("disconnected");
    expect(MockWebSocket.instances.length).toBe(0);
  });
});

describe("useRealtimeBalance", () => {
  const mockApiFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).WebSocket = MockWebSocket;
    jest.requireMock("@/lib/api").apiFetch = mockApiFetch;
  });

  afterEach(() => {
    delete (global as any).WebSocket;
  });

  it("should fetch balance from API and update from WebSocket", async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        account: "GABC123",
        amount: "500000",
        updated_at: new Date().toISOString(),
      }),
    });

    const { result } = renderHook(() => useRealtimeBalance("GABC123"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.balance).toEqual({
      account: "GABC123",
      amount: "500000",
      updated_at: expect.any(String),
    });
  });

  it("should update from WebSocket when new balance received", async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        account: "GABC123",
        amount: "500000",
        updated_at: new Date().toISOString(),
      }),
    });

    const { result } = renderHook(() => useRealtimeBalance("GABC123"));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const ws = MockWebSocket.instances[0];
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          account: "GABC123",
          amount: "1000000",
          updated_at: new Date().toISOString(),
        }),
      });
    });

    expect(result.current.balance?.amount).toBe("1000000");
  });
});