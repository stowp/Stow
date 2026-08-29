/**
 * @vitest-environment jsdom
 */
import { vi } from "vitest";
import {
  isPageViewPingEnabled,
  getPageViewPingEndpoint,
  trackPageView,
} from "./analytics";

const ENABLE_FLAG = "NEXT_PUBLIC_ENABLE_PAGE_VIEW_PING";
const ENDPOINT_VAR = "NEXT_PUBLIC_PAGE_VIEW_PING_ENDPOINT";

describe("analytics", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[ENABLE_FLAG];
    delete process.env[ENDPOINT_VAR];
    vi.restoreAllMocks();
    global.fetch = vi.fn();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("isPageViewPingEnabled", () => {
    it("is disabled by default when the flag is unset", () => {
      expect(isPageViewPingEnabled()).toBe(false);
    });

    it("is disabled for values other than true/1", () => {
      process.env[ENABLE_FLAG] = "yes";
      expect(isPageViewPingEnabled()).toBe(false);
    });

    it('is enabled when set to "true"', () => {
      process.env[ENABLE_FLAG] = "true";
      expect(isPageViewPingEnabled()).toBe(true);
    });

    it('is enabled when set to "1"', () => {
      process.env[ENABLE_FLAG] = "1";
      expect(isPageViewPingEnabled()).toBe(true);
    });
  });

  describe("getPageViewPingEndpoint", () => {
    it("defaults to /api/analytics/pageview", () => {
      expect(getPageViewPingEndpoint()).toBe("/api/analytics/pageview");
    });

    it("respects a configured override", () => {
      process.env[ENDPOINT_VAR] = "https://analytics.example.com/ping";
      expect(getPageViewPingEndpoint()).toBe("https://analytics.example.com/ping");
    });
  });

  describe("trackPageView", () => {
    it("sends nothing when the flag is disabled", () => {
      const sendBeacon = vi.fn();
      Object.defineProperty(navigator, "sendBeacon", {
        value: sendBeacon,
        configurable: true,
      });
      trackPageView("/dashboard");

      expect(sendBeacon).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("sends a minimal, PII-free beacon when enabled", () => {
      process.env[ENABLE_FLAG] = "true";
      const sendBeacon = vi.fn().mockReturnValue(true);
      Object.defineProperty(navigator, "sendBeacon", {
        value: sendBeacon,
        configurable: true,
      });

      trackPageView("/dashboard");

      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const [url, blob] = sendBeacon.mock.calls[0];
      expect(url).toBe("/api/analytics/pageview");
      expect(blob).toBeInstanceOf(Blob);
    });

    it("falls back to a cookieless fetch when sendBeacon is unavailable", () => {
      process.env[ENABLE_FLAG] = "true";
      Object.defineProperty(navigator, "sendBeacon", {
        value: undefined,
        configurable: true,
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });

      trackPageView("/dashboard");

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toBe("/api/analytics/pageview");
      expect(init?.credentials).toBe("omit");
      expect(init?.keepalive).toBe(true);

      const body = JSON.parse(init?.body as string);
      expect(Object.keys(body).sort()).toEqual(["path", "timestamp"]);
      expect(body.path).toBe("/dashboard");
    });

    it("swallows fetch errors instead of throwing", () => {
      process.env[ENABLE_FLAG] = "true";
      Object.defineProperty(navigator, "sendBeacon", {
        value: undefined,
        configurable: true,
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"));

      expect(() => trackPageView("/dashboard")).not.toThrow();
    });
  });
});
