"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  Gift,
  LayoutDashboard,
  Lock,
  LogOut,
  PartyPopper,
  Scale,
  Settings,
  Target,
  Users,
} from "lucide-react";
import Logo from "@/components/Logo";

export const sidebarItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Compare savings", href: "/savings/compare", match: "/savings/compare", icon: Scale },
  { label: "Goals", href: "/savings/goals/new", match: "/savings/goals", icon: Target },
  { label: "Locked savings", href: "/savings/locked/new", match: "/savings/locked", icon: Lock },
  { label: "Groups", href: "/savings/groups/new", match: "/savings/groups", icon: Users },
  { label: "Deposit & withdraw", href: "/ramps/deposit", match: "/ramps", icon: ArrowLeftRight },
  { label: "Referrals", href: "/referrals", icon: Gift },
  { label: "Community", href: "/social", icon: PartyPopper },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;

function isActiveRoute(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export interface SidebarProps {
  /** Called when the user picks "Sign out". */
  onSignOut: () => void;
  /** Called after a navigation link is clicked (used to close the mobile drawer). */
  onNavigate?: () => void;
  className?: string;
}

/**
 * Primary navigation for the authenticated app shell. Rendered as a fixed
 * column on desktop by `(app)/layout.tsx`, and inside a slide-over drawer
 * on small screens.
 */
export default function Sidebar({
  onSignOut,
  onNavigate,
  className = "",
}: SidebarProps) {
  const pathname = usePathname() ?? "";

  return (
    <aside
      aria-label="Sidebar"
      className={`flex h-full w-64 flex-col border-r border-border bg-background-elevated ${className}`}
    >
      <div className="flex h-16 items-center px-6">
        <Link href="/dashboard" onClick={onNavigate} aria-label="Stow dashboard">
          <Logo className="h-8 w-8" />
        </Link>
      </div>

      <nav aria-label="App navigation" className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-1">
          {sidebarItems.map((item) => {
            const Icon = item.icon;
            const active = isActiveRoute(
              pathname,
              "match" in item ? item.match : item.href,
            );

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  data-tour={
                    item.href === "/dashboard" ? "dashboard" :
                    item.href === "/savings/goals/new" ? "goals" :
                    item.href === "/savings/locked/new" ? "locked" :
                    item.href === "/savings/groups/new" ? "groups" :
                    item.href === "/ramps/deposit" ? "deposit" :
                    item.href === "/referrals" ? "referrals" : undefined
                  }
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand/50 ${
                    active
                      ? "bg-brand/10 text-brand"
                      : "text-muted hover:bg-card hover:text-foreground"
                  }`}
                >
                  <Icon aria-hidden="true" className="h-5 w-5" />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-border p-3">
        <button
          type="button"
          onClick={onSignOut}
          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-card hover:text-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
        >
          <LogOut aria-hidden="true" className="h-5 w-5" />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
}
