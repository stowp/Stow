export class ApiError extends Error {
  status: number;
  data?: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

type SessionExpiredHandler = () => void;

let _onSessionExpired: SessionExpiredHandler | null = null;
let _sessionToken: string | null = null;

export function setSessionExpiredHandler(
  handler: SessionExpiredHandler | null,
): void {
  _onSessionExpired = handler;
}

export function setSessionToken(token: string | null): void {
  _sessionToken = token;
}

export function getSessionToken(): string | null {
  return _sessionToken;
}

export function clearSession(): void {
  _sessionToken = null;
  _onSessionExpired?.();
}

interface ApiRequestInit extends RequestInit {
  skipAuth?: boolean;
}

export async function apiFetch(
  input: string | URL,
  init?: ApiRequestInit,
): Promise<Response> {
  const { skipAuth = false, ...fetchInit } = init || {};
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";
  const url = apiBase ? `${apiBase}${input}` : input;

  const headers = new Headers(fetchInit.headers);

  // Attach session token if available and not skipped
  if (!skipAuth && _sessionToken) {
    headers.set("Authorization", `Bearer ${_sessionToken}`);
  }

  // Ensure JSON content type for POST/PUT/PATCH requests
  if (
    fetchInit.body &&
    !headers.has("Content-Type") &&
    typeof fetchInit.body === "string"
  ) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    credentials: "include",
    ...fetchInit,
    headers,
  });

  // Handle 401 - session expired or unauthorized
  if (response.status === 401) {
    clearSession();
    throw new ApiError("Session expired", 401);
  }

  return response;
}

/**
 * Typed fetch wrapper that parses JSON responses and normalizes errors
 */
export async function apiRequest<T = any>(
  input: string | URL,
  init?: ApiRequestInit,
): Promise<T> {
  const response = await apiFetch(input, init);

  // Handle non-2xx responses
  if (!response.ok) {
    let errorMessage = `Request failed with status ${response.status}`;
    let errorData: any;

    try {
      errorData = await response.json();
      errorMessage = errorData.message || errorData.error || errorMessage;
    } catch {
      // Response is not JSON, use status text
      errorMessage = response.statusText || errorMessage;
    }

    throw new ApiError(errorMessage, response.status, errorData);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  // Parse JSON response
  try {
    return await response.json();
  } catch (error) {
    throw new ApiError(
      "Failed to parse response",
      response.status,
      await response.text(),
    );
  }
}

/**
 * Convenience methods for common HTTP verbs
 */
export const api = {
  get: <T = any>(url: string, init?: ApiRequestInit) =>
    apiRequest<T>(url, { ...init, method: "GET" }),

  post: <T = any>(url: string, body?: any, init?: ApiRequestInit) =>
    apiRequest<T>(url, {
      ...init,
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    }),

  put: <T = any>(url: string, body?: any, init?: ApiRequestInit) =>
    apiRequest<T>(url, {
      ...init,
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    }),

  patch: <T = any>(url: string, body?: any, init?: ApiRequestInit) =>
    apiRequest<T>(url, {
      ...init,
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    }),

  delete: <T = any>(url: string, init?: ApiRequestInit) =>
    apiRequest<T>(url, { ...init, method: "DELETE" }),
};
