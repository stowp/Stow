"use client";

import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import GithubIcon from "@/components/GithubIcon";
import ThemeToggle from "@/components/ThemeToggle";

const links = [
  { label: "Features", href: "#features" },
  { label: "Products", href: "#products" },
  { label: "Onboarding", href: "#onboarding" },
  { label: "Architecture", href: "#architecture" },
  { label: "Roadmap", href: "#roadmap" },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Scroll-spy: highlight the nav link for the section currently in view.
  useEffect(() => {
    const sections = links
      .map((l) => document.getElementById(l.href.slice(1)))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(`#${entry.target.id}`);
        }
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 },
    );

    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
        scrolled
          ? "border-b border-border bg-background/80 backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-3.5 sm:px-8">
        <a href="#top" className="flex items-center font-semibold tracking-tight text-foreground">
          <Logo />
        </a>

        <div className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              aria-current={active === l.href ? "true" : undefined}
              className={`text-sm transition-colors hover:text-foreground ${
                active === l.href ? "text-brand" : "text-muted"
              }`}
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <ThemeToggle />
          <a
            href="https://github.com/stowp/Stow"
            className="flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm text-muted transition-colors hover:border-brand/40 hover:text-foreground"
          >
            <GithubIcon className="h-4 w-4" /> GitHub
          </a>
          <a
            href="#get-started"
            className="rounded-lg bg-gradient-to-r from-brand to-brand-2 px-4 py-2 text-sm font-semibold text-background shadow-lg shadow-brand/20 transition-transform hover:scale-[1.03]"
          >
            Launch App
          </a>
        </div>

        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <button
            onClick={() => setOpen((v) => !v)}
            className="grid h-10 w-10 place-items-center rounded-lg border border-border text-foreground"
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {open && (
        <div className="border-t border-border bg-background/95 px-5 py-4 backdrop-blur-xl md:hidden">
          <div className="flex flex-col gap-1">
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                aria-current={active === l.href ? "true" : undefined}
                className={`rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-white/5 hover:text-foreground ${
                  active === l.href ? "text-brand" : "text-muted"
                }`}
              >
                {l.label}
              </a>
            ))}
            <a
              href="#get-started"
              onClick={() => setOpen(false)}
              className="mt-2 rounded-lg bg-gradient-to-r from-brand to-brand-2 px-4 py-2.5 text-center text-sm font-semibold text-background"
            >
              Launch App
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
