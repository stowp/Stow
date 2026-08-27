"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const STORAGE_KEY = "stow-theme";

interface ThemeContextValue {
  /** The theme actually applied to the document. */
  theme: Theme;
  /** The user's stored preference, or "system" if none was set. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [theme, setTheme] = useState<Theme>(() => {
    const initialPreference = readStoredPreference();
    return initialPreference === "system" ? getSystemTheme() : initialPreference;
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (preference !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setTheme(getSystemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    if (next === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
      setTheme(getSystemTheme());
    } else {
      window.localStorage.setItem(STORAGE_KEY, next);
      setTheme(next);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(theme === "light" ? "dark" : "light");
  }, [theme, setPreference]);

  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
