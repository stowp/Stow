import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  apiFetch,
  apiRequest,
  api,
  ApiError,
  setSessionToken,
  getSessionToken,
  clearSession,
  setSessionExpiredHandler,
} from "./api";

global.fetch = vi.fn();

describe("API Client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSessionToken(null);
    setSessionExpiredHandler(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Session Token Management", () => {
    it("stores and retrieves session token", () => {
      const token = "test-token-123";
      setSessionToken(token);
      expect(getSessionToken()).toBe(token);
    });

    it("clears session token", () => {
      setSessionToken("test-token-123");
      clearSession();
      expect(getSessionToken()).toBeNull();
    });

    it("calls session expired handler when clearing session", () => {
      const handler = vi.fn();
      setSessionExpiredHandler(handler);
      clearSession();
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("apiFetch - Authorization Header", () => {
    it("attaches Authorization header when session token is set", async () => {
      const token = "bearer-token-xyz";
      setSessionToken(token);

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await apiFetch("/test-endpoint");

      expect(global.fetch).toHaveBeenCalledWith(
        "/test-endpoint",
        expect.objectContaining({
          headers: expect.any(Headers),
        }),
      );

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = call[1].headers as Headers;
      expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    });

    it("does not attach Authorization header when no session token", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await apiFetch("/test-endpoint");

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = call[1].headers as Headers;
      expect(headers.get("Authorization")).toBeNull();
    });

    it("skips auth when skipAuth option is true", async () => {
      setSessionToken("test-token");

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await apiFetch("/test-endpoint", { skipAuth: true });

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = call[1].headers as Headers;
      expect(headers.get("Authorization")).toBeNull();
    });
  });

  describe("apiFetch - 401 Handling", () => {
    it("clears session on 401 response", async () => {
      setSessionToken("test-token");

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(null, { status: 401 }),
      );

      await expect(apiFetch("/test-endpoint")).rejects.toThrow(
        "Session expired",
      );
      expect(getSessionToken()).toBeNull();
    });

    it("calls session expired handler on 401", async () => {
      const handler = vi.fn();
      setSessionExpiredHandler(handler);

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(null, { status: 401 }),
      );

      await expect(apiFetch("/test-endpoint")).rejects.toThrow(ApiError);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("throws ApiError with correct status on 401", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(null, { status: 401 }),
      );

      try {
        await apiFetch("/test-endpoint");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(401);
        expect((error as ApiError).message).toBe("Session expired");
      }
    });
  });

  describe("apiFetch - API Base URL", () => {
    it("prepends API base URL when configured", async () => {
      const originalEnv = process.env.NEXT_PUBLIC_API_URL;
      process.env.NEXT_PUBLIC_API_URL = "https://api.example.com";

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await apiFetch("/users");

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.com/users",
        expect.any(Object),
      );

      process.env.NEXT_PUBLIC_API_URL = originalEnv;
    });

    it("uses relative URL when API base URL is not configured", async () => {
      const originalEnv = process.env.NEXT_PUBLIC_API_URL;
      delete process.env.NEXT_PUBLIC_API_URL;

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await apiFetch("/users");

      expect(global.fetch).toHaveBeenCalledWith("/users", expect.any(Object));

      process.env.NEXT_PUBLIC_API_URL = originalEnv;
    });
  });

  describe("apiRequest - Error Normalization", () => {
    it("throws ApiError with JSON error message", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Custom error message" }), {
          status: 400,
        }),
      );

      try {
        await apiRequest("/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).toBe("Custom error message");
        expect((error as ApiError).status).toBe(400);
      }
    });

    it("handles error field in response", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Validation failed" }), {
          status: 422,
        }),
      );

      try {
        await apiRequest("/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).toBe("Validation failed");
      }
    });

    it("uses status text when JSON parsing fails", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response("Not Found", { status: 404, statusText: "Not Found" }),
      );

      try {
        await apiRequest("/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(404);
      }
    });

    it("includes error data in ApiError", async () => {
      const errorData = { message: "Validation failed", fields: ["email"] };
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify(errorData), { status: 422 }),
      );

      try {
        await apiRequest("/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).data).toEqual(errorData);
      }
    });
  });

  describe("apiRequest - Success Responses", () => {
    it("parses JSON response for 200 OK", async () => {
      const responseData = { id: 1, name: "Test" };
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify(responseData), { status: 200 }),
      );

      const result = await apiRequest("/test");
      expect(result).toEqual(responseData);
    });

    it("returns undefined for 204 No Content", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      const result = await apiRequest("/test");
      expect(result).toBeUndefined();
    });

    it("throws error when response is not valid JSON", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response("Invalid JSON", { status: 200 }),
      );

      try {
        await apiRequest("/test");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).toBe("Failed to parse response");
      }
    });
  });

  describe("API Convenience Methods", () => {
    it("api.get makes GET request", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({ data: "test" }), { status: 200 }),
      );

      await api.get("/users");

      expect(global.fetch).toHaveBeenCalledWith(
        "/users",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("api.post makes POST request with JSON body", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1 }), { status: 201 }),
      );

      const body = { name: "Test User" };
      await api.post("/users", body);

      expect(global.fetch).toHaveBeenCalledWith(
        "/users",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    });

    it("api.put makes PUT request with JSON body", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1 }), { status: 200 }),
      );

      const body = { name: "Updated User" };
      await api.put("/users/1", body);

      expect(global.fetch).toHaveBeenCalledWith(
        "/users/1",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify(body),
        }),
      );
    });

    it("api.patch makes PATCH request with JSON body", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1 }), { status: 200 }),
      );

      const body = { name: "Patched User" };
      await api.patch("/users/1", body);

      expect(global.fetch).toHaveBeenCalledWith(
        "/users/1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify(body),
        }),
      );
    });

    it("api.delete makes DELETE request", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await api.delete("/users/1");

      expect(global.fetch).toHaveBeenCalledWith(
        "/users/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("Content-Type Header", () => {
    it("sets Content-Type to application/json for POST with body", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await api.post("/test", { data: "test" });

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = call[1].headers as Headers;
      expect(headers.get("Content-Type")).toBe("application/json");
    });

    it("does not override existing Content-Type header", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await apiFetch("/test", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "plain text",
      });

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = call[1].headers as Headers;
      expect(headers.get("Content-Type")).toBe("text/plain");
    });
  });

  describe("Credentials", () => {
    it("includes credentials in all requests", async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await apiFetch("/test");

      expect(global.fetch).toHaveBeenCalledWith(
        "/test",
        expect.objectContaining({ credentials: "include" }),
      );
    });
  });
});
