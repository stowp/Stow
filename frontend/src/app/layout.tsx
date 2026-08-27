import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import PageViewPing from "@/components/analytics/PageViewPing";
import { ThemeProvider } from "@/context/ThemeProvider";
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
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <div className="bg-aurora" aria-hidden />
          <div className="grid-overlay" aria-hidden />
          <PageViewPing />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
