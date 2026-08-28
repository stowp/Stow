import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import PageViewPing from "@/components/analytics/PageViewPing";
import "./globals.css";

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
  icons: {
    icon: [
      // Browsers that support prefers-color-scheme-aware favicons (most
      // current Chromium/Firefox/Safari) pick whichever matches the OS
      // theme; browsers that don't fall back to the first entry, which is
      // also served automatically via the app/favicon.ico convention.
      { url: "/icon-light.svg", media: "(prefers-color-scheme: light)" },
      { url: "/icon-dark.svg", media: "(prefers-color-scheme: dark)" },
    ],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <div className="bg-aurora" aria-hidden />
        <div className="grid-overlay" aria-hidden />
        <PageViewPing />
        {children}
      </body>
    </html>
  );
}
