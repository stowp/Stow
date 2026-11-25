import { useEffect, useRef, useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";

export type WebSocketConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface BalanceUpdate {
  account: string;
  amount: string;
  updated_at: string;
}

export interface UseBalanceWebSocketReturn {
  status: WebSocketConnectionStatus;
  latestBalance: BalanceUpdate | null;
  reconnect: () => void;
}

/**
 * Hook for real-time balance updates via WebSocket.
 * 
 * Connects to the backend WebSocket endpoint to receive balance change events
 * and automatically updates the UI when the user's balance changes on-chain.
 */
export function useBalanceWebSocket(
  address: string | null,
  initialBalance?: BalanceUpdate | null,
): UseBalanceWebSocketReturn {
  const [status, setStatus] = useState<WebSocketConnectionStatus>("disconnected");
  const [latestBalance, setLatestBalance] = useState<BalanceUpdate | null>(initialBalance ?? null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const maxAttempts = 10;

  const connect = useCallback(() => {
    if (!address) return;

    const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws/balances/${encodeURIComponent(address)}`;
    
    try {
      setStatus("connecting");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        attemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as BalanceUpdate;
          setLatestBalance(data);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        setStatus("disconnected");
        
        if (attemptRef.current < maxAttempts) {
          setStatus("reconnecting");
          const delay = Math.min(1000 * 2 ** attemptRef.current, 30000);
          attemptRef.current += 1;
          reconnectTimerRef.current = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      setStatus("disconnected");
    }
  }, [address]);

  const reconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    attemptRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [connect]);

  return { status, latestBalance, reconnect };
}

/**
 * Hook that combines REST balance fetching with WebSocket real-time updates.
 * Users get the best of both worlds: immediate data from cache + live updates.
 */
export function useRealtimeBalance(address: string | null) {
  const [balance, setBalance] = useState<BalanceUpdate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const { status: wsStatus, latestBalance, reconnect } = useBalanceWebSocket(address, balance);

  useEffect(() => {
    if (!address) {
      setBalance(null);
      setLoading(false);
      return;
    }

    const fetchBalance = async () => {
      try {
        const response = await apiFetch(`/api/savings/accounts/${encodeURIComponent(address)}`);
        if (response.ok) {
          const data = await response.json();
          setBalance(data);
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to fetch balance"));
      } finally {
        setLoading(false);
      }
    };

    fetchBalance();
  }, [address]);

  // Update from WebSocket when we receive a new balance
  useEffect(() => {
    if (latestBalance) {
      setBalance(latestBalance);
    }
  }, [latestBalance]);

  return {
    balance,
    loading,
    error,
    wsStatus,
    reconnect,
  };
}