import "@testing-library/dom";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock IntersectionObserver for Navbar scroll-spy tests
global.IntersectionObserver = class IntersectionObserver {
  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {}

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
} as any;

// Mock window.scrollY
Object.defineProperty(window, "scrollY", {
  writable: true,
  configurable: true,
  value: 0,
});

// Mock window.matchMedia (used by ThemeProvider for system theme detection)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
