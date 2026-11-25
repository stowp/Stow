import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import PageViewPing from "@/components/analytics/PageViewPing";
import { ThemeProvider } from "@/context/ThemeProvider";
import { SessionProvider } from "@/context/SessionProvider";
import { I18nProvider } from "@/context/I18nProvider";
import { MilestoneProvider } from "@/context/MilestoneProvider";
import { SentryErrorBoundary } from "@/components/SentryErrorBoundary";
import { PWAInstallPrompt } from "@/components/PWAInstallPrompt";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import { UpdateNotification } from "@/components/UpdateNotification";
import MilestoneCelebration from "@/components/notifications/MilestoneCelebration";
import "./globals.css";

const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("stow-theme");
    var theme = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();
`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stow — Decentralized Savings on Stellar",
  description:
    "Stow is a non-custodial savings protocol on Stellar. Save transparently in USDC with flexible, locked, goal-based, and group savings enforced fully on-chain by Soroban smart contracts.",
  keywords: [
    "Stow",
    "Stellar",
    "Soroban",
    "DeFi savings",
    "USDC",
    "non-custodial",
    "passkey smart wallet",
    "group savings",
  ],
  openGraph: {
    title: "Stow — Decentralized Savings on Stellar",
    description:
      "Non-custodial, transparent savings in USDC — flexible, locked, goal-based, and group savings enforced on-chain.",
    type: "website",
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Stow",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#3b82f6" },
    { media: "(prefers-color-scheme: dark)", color: "#1e40af" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
      </head>
      <body className="min-h-full flex flex-col">
        <SentryErrorBoundary>
          <ThemeProvider>
            <I18nProvider>
              <SessionProvider>
                <MilestoneProvider>
                <a
                  href="#main-content"
                  className="sr-only z-[100] rounded-lg px-4 py-2 text-sm font-semibold text-background focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:bg-brand focus:outline-none focus:ring-2 focus:ring-brand"
                >
                  Skip to main content
                </a>
                <div className="bg-aurora" aria-hidden />
                <div className="grid-overlay" aria-hidden />
                <PageViewPing />
                <OfflineIndicator />
                <PWAInstallPrompt />
                <UpdateNotification />
                <MilestoneCelebration />
                {children}
                </MilestoneProvider>
              </SessionProvider>
            </I18nProvider>
          </ThemeProvider>
        </SentryErrorBoundary>
      </body>
    </html>
  );
}
