"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CircleHelp, Menu, X } from "lucide-react";
import { useSession } from "@/context/SessionProvider";
import Sidebar from "@/components/app/Sidebar";
import AddressBadge from "@/components/app/AddressBadge";
import OnboardingTour from "@/components/app/OnboardingTour";
import AppAccessLock from "@/components/app/AppAccessLock";
import ThemeToggle from "@/components/app/ThemeToggle";
import { useFocusManagement } from "@/hooks/useFocusManagement";
import {
  BIOMETRIC_ACCESS_CHANGED_EVENT,
  readBiometricAccessSettings,
  type BiometricAccessSettings,
} from "@/lib/biometricAccess";

const TOUR_STORAGE_KEY = "stow-onboarding-complete";

interface DeviceAccessState {
  userId: string;
  settings: BiometricAccessSettings | null;
  unlocked: boolean;
}

/**
 * Authenticated app shell for every route under (app): a sidebar + topbar
 * around the product screens, gated on an authenticated session.
 * SessionProvider itself is mounted once in the root layout (shared with
 * (auth)/login, which needs the same session instance to call setSession()
 * after logging in); this layout only reads it to redirect signed-out
 * visitors to sign in, carrying the current path as `returnTo` so login can
 * send them back.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { user, address, loading, signOut } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [deviceAccess, setDeviceAccess] = useState<DeviceAccessState | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  useFocusManagement(mainRef, pathname ?? "");

  const currentUserId = user?.id;

  useEffect(() => {
    if (!currentUserId) {
      setDeviceAccess(null);
      return;
    }

    const settings = readBiometricAccessSettings(currentUserId);
    setDeviceAccess({
      userId: currentUserId,
      settings,
      unlocked: settings === null,
    });

    const syncSettings = () => {
      const nextSettings = readBiometricAccessSettings(currentUserId);
      setDeviceAccess((current) => ({
        userId: currentUserId,
        settings: nextSettings,
        unlocked:
          current?.userId === currentUserId
            ? current.unlocked
            : nextSettings === null,
      }));
    };
    const lockWhenHidden = () => {
      if (document.visibilityState !== "hidden") return;
      setDeviceAccess((current) =>
        current?.userId === currentUserId && current.settings
          ? { ...current, unlocked: false }
          : current,
      );
    };

    window.addEventListener(BIOMETRIC_ACCESS_CHANGED_EVENT, syncSettings);
    document.addEventListener("visibilitychange", lockWhenHidden);
    return () => {
      window.removeEventListener(BIOMETRIC_ACCESS_CHANGED_EVENT, syncSettings);
      document.removeEventListener("visibilitychange", lockWhenHidden);
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!window.localStorage.getItem(TOUR_STORAGE_KEY)) setTourOpen(true);
  }, []);

  useEffect(() => {
    if (tourOpen && window.innerWidth < 768) {
      setMobileNavOpen(true);
    }
  }, [tourOpen]);

  useEffect(() => {
    if (!loading && !user) {
      const returnTo = pathname ? `?returnTo=${encodeURIComponent(pathname)}` : "";
      router.replace(`/login${returnTo}`);
    }
  }, [loading, user, router, pathname]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  if (loading || !user) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-h-screen items-center justify-center bg-background"
      >
        <span className="text-sm text-muted">Loading…</span>
      </main>
    );
  }

  if (!deviceAccess || deviceAccess.userId !== user.id) {
    return (
      <main
        id="main-content"
        tabIndex={-1}
        className="flex min-h-screen items-center justify-center bg-background"
      >
        <span className="text-sm text-muted">Preparing app access...</span>
      </main>
    );
  }

  if (deviceAccess.settings && !deviceAccess.unlocked) {
    return (
      <AppAccessLock
        userId={user.id}
        settings={deviceAccess.settings}
        onUnlock={() =>
          setDeviceAccess((current) =>
            current?.userId === user.id ? { ...current, unlocked: true } : current,
          )
        }
        onSignOut={signOut}
      />
    );
  }

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-foreground focus:outline-none focus:ring-2 focus:ring-brand"
      >
        Skip to main content
      </a>
      <div className="flex min-h-screen bg-background">
      <Sidebar
        onSignOut={signOut}
        className="sticky top-0 hidden h-screen shrink-0 md:flex"
      />

      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            aria-hidden="true"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="relative h-full" id="mobile-sidebar">
            <Sidebar
              onSignOut={signOut}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 backdrop-blur-xl md:px-6">
          <button
            type="button"
            onClick={() => setMobileNavOpen((open) => !open)}
            aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={mobileNavOpen}
            aria-controls="mobile-sidebar"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-card hover:text-foreground focus:outline-none focus:ring-2 focus:ring-brand/50 md:hidden"
          >
            {mobileNavOpen ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </button>

          <div className="ml-auto flex items-center gap-3">
            {user.email && (
              <span className="hidden text-sm text-muted sm:inline">
                {user.email}
              </span>
            )}
            {address && <AddressBadge address={address} />}
            <ThemeToggle />
            <button
              type="button"
              onClick={() => setTourOpen(true)}
              title="Restart tutorial"
              aria-label="Restart tutorial"
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-card hover:text-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
            >
              <CircleHelp className="h-4 w-4" aria-hidden="true" />
              <span>Tour</span>
            </button>
          </div>
        </header>

        <main id="main-content" ref={mainRef} tabIndex={-1} className="flex-1">
          {children}
        </main>
      </div>
      {tourOpen && <OnboardingTour onClose={() => setTourOpen(false)} />}
    </div>
    </>
  );
}
