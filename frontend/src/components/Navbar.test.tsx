import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Navbar from "./Navbar";

describe("Navbar", () => {
  beforeEach(() => {
    // Reset scroll position
    Object.defineProperty(window, "scrollY", {
      writable: true,
      configurable: true,
      value: 0,
    });

    // Clear all mocks
    vi.clearAllMocks();
  });

  it("renders the logo and navigation links", () => {
    render(<Navbar />);

    expect(screen.getByText("Stow")).toBeInTheDocument();
    expect(screen.getByText("Features")).toBeInTheDocument();
    expect(screen.getByText("Products")).toBeInTheDocument();
    expect(screen.getByText("Onboarding")).toBeInTheDocument();
    expect(screen.getByText("Architecture")).toBeInTheDocument();
    expect(screen.getByText("Roadmap")).toBeInTheDocument();
  });

  it("renders CTA buttons in desktop view", () => {
    render(<Navbar />);

    const githubLinks = screen.getAllByText("GitHub");
    const launchAppLinks = screen.getAllByText("Launch App");

    expect(githubLinks.length).toBeGreaterThan(0);
    expect(launchAppLinks.length).toBeGreaterThan(0);
  });

  describe("Scroll Behavior", () => {
    it("adds backdrop blur when scrolled down", async () => {
      render(<Navbar />);

      const header = screen.getByRole("banner");

      // Initially no backdrop blur
      expect(header).toHaveClass("border-transparent");
      expect(header).not.toHaveClass("backdrop-blur-xl");

      // Simulate scroll
      Object.defineProperty(window, "scrollY", { value: 50, writable: true });
      window.dispatchEvent(new Event("scroll"));

      await waitFor(() => {
        expect(header).toHaveClass("backdrop-blur-xl");
        expect(header).toHaveClass("bg-background/80");
      });
    });

    it("does not add backdrop blur when scroll is minimal", () => {
      render(<Navbar />);

      const header = screen.getByRole("banner");

      // Small scroll (< 12px)
      Object.defineProperty(window, "scrollY", { value: 10, writable: true });
      window.dispatchEvent(new Event("scroll"));

      expect(header).toHaveClass("border-transparent");
    });

    it("removes backdrop blur when scrolled back to top", async () => {
      render(<Navbar />);

      const header = screen.getByRole("banner");

      // Scroll down
      Object.defineProperty(window, "scrollY", { value: 50, writable: true });
      window.dispatchEvent(new Event("scroll"));

      await waitFor(() => {
        expect(header).toHaveClass("backdrop-blur-xl");
      });

      // Scroll back to top
      Object.defineProperty(window, "scrollY", { value: 0, writable: true });
      window.dispatchEvent(new Event("scroll"));

      await waitFor(() => {
        expect(header).toHaveClass("border-transparent");
      });
    });
  });

  describe("Mobile Menu", () => {
    it("toggles mobile menu when button is clicked", async () => {
      const user = userEvent.setup();
      render(<Navbar />);

      const menuButton = screen.getByRole("button", { name: /toggle menu/i });

      expect(menuButton).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("Features")).toBeInTheDocument();

      await user.click(menuButton);

      expect(menuButton).toHaveAttribute("aria-expanded", "true");

      await user.click(menuButton);

      expect(menuButton).toHaveAttribute("aria-expanded", "false");
    });

    it("closes mobile menu when a link is clicked", async () => {
      const user = userEvent.setup();
      render(<Navbar />);

      const menuButton = screen.getByRole("button", { name: /toggle menu/i });

      await user.click(menuButton);
      expect(menuButton).toHaveAttribute("aria-expanded", "true");

      // Click one of the mobile menu links
      const mobileLinks = screen.getAllByText("Features");
      const mobileLink = mobileLinks.find(
        (link) =>
          link.closest("div")?.classList.contains("backdrop-blur-xl") ||
          link.classList.contains("hover:bg-white/5"),
      );

      if (mobileLink) {
        await user.click(mobileLink);
        expect(menuButton).toHaveAttribute("aria-expanded", "false");
      }
    });
  });

  describe("Scroll-Spy Active Link Highlighting", () => {
    let mockObserve: ReturnType<typeof vi.fn>;
    let mockDisconnect: ReturnType<typeof vi.fn>;
    let observerCallback: IntersectionObserverCallback;

    beforeEach(() => {
      mockObserve = vi.fn();
      mockDisconnect = vi.fn();

      // Mock IntersectionObserver with callback capture
      global.IntersectionObserver = vi.fn((callback, options) => {
        observerCallback = callback;
        return {
          observe: mockObserve,
          unobserve: vi.fn(),
          disconnect: mockDisconnect,
          takeRecords: () => [],
          root: null,
          rootMargin: options?.rootMargin || "",
          thresholds: [],
        };
      }) as any;
    });

    it("sets up IntersectionObserver for scroll-spy", () => {
      // Create mock sections
      const mockSections = ["features", "products", "onboarding"].map((id) => {
        const section = document.createElement("section");
        section.id = id;
        document.body.appendChild(section);
        return section;
      });

      render(<Navbar />);

      expect(global.IntersectionObserver).toHaveBeenCalled();
      expect(mockObserve).toHaveBeenCalled();

      // Cleanup
      mockSections.forEach((section) => section.remove());
    });

    it("highlights the active link when a section is in view", async () => {
      // Create mock section
      const section = document.createElement("section");
      section.id = "features";
      document.body.appendChild(section);

      render(<Navbar />);

      // Find the Features link in the desktop nav
      const desktopLinks = screen.getAllByText("Features");
      const desktopLink = desktopLinks.find((link) =>
        link.classList.contains("text-sm"),
      );

      // Initially should be muted
      expect(desktopLink).toHaveClass("text-muted");

      // Simulate intersection
      if (observerCallback) {
        observerCallback(
          [
            {
              isIntersecting: true,
              target: section,
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        );
      }

      await waitFor(() => {
        expect(desktopLink).toHaveClass("text-brand");
        expect(desktopLink).toHaveAttribute("aria-current", "true");
      });

      // Cleanup
      section.remove();
    });

    it("updates active link when scrolling to different section", async () => {
      // Create mock sections
      const featuresSection = document.createElement("section");
      featuresSection.id = "features";
      const productsSection = document.createElement("section");
      productsSection.id = "products";

      document.body.appendChild(featuresSection);
      document.body.appendChild(productsSection);

      render(<Navbar />);

      const desktopLinks = screen.getAllByText("Features");
      const featuresLink = desktopLinks.find((link) =>
        link.classList.contains("text-sm"),
      );

      // Simulate Features section in view
      if (observerCallback) {
        observerCallback(
          [
            {
              isIntersecting: true,
              target: featuresSection,
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        );
      }

      await waitFor(() => {
        expect(featuresLink).toHaveClass("text-brand");
      });

      // Now simulate Products section in view
      if (observerCallback) {
        observerCallback(
          [
            {
              isIntersecting: true,
              target: productsSection,
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        );
      }

      const productsLinks = screen.getAllByText("Products");
      const productsLink = productsLinks.find((link) =>
        link.classList.contains("text-sm"),
      );

      await waitFor(() => {
        expect(productsLink).toHaveClass("text-brand");
        expect(featuresLink).not.toHaveClass("text-brand");
      });

      // Cleanup
      featuresSection.remove();
      productsSection.remove();
    });

    it("cleans up IntersectionObserver on unmount", () => {
      const { unmount } = render(<Navbar />);
      unmount();
      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  describe("Accessibility", () => {
    it("has proper ARIA labels on interactive elements", () => {
      render(<Navbar />);

      const menuButton = screen.getByRole("button", { name: /toggle menu/i });
      expect(menuButton).toHaveAttribute("aria-label");
      expect(menuButton).toHaveAttribute("aria-expanded");
    });

    it("marks active links with aria-current", async () => {
      const section = document.createElement("section");
      section.id = "features";
      document.body.appendChild(section);

      render(<Navbar />);

      let observerCallback: IntersectionObserverCallback = () => {};
      global.IntersectionObserver = vi.fn((callback) => {
        observerCallback = callback;
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
          takeRecords: () => [],
          root: null,
          rootMargin: "",
          thresholds: [],
        };
      }) as any;

      // Trigger re-render to capture new observer
      const { rerender } = render(<Navbar />);
      rerender(<Navbar />);

      if (observerCallback) {
        observerCallback(
          [
            {
              isIntersecting: true,
              target: section,
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver,
        );
      }

      const desktopLinks = screen.getAllByText("Features");
      const activeLink = desktopLinks.find((link) =>
        link.classList.contains("text-brand"),
      );

      if (activeLink) {
        await waitFor(() => {
          expect(activeLink).toHaveAttribute("aria-current", "true");
        });
      }

      section.remove();
    });

    it("has semantic header and nav elements", () => {
      render(<Navbar />);
      expect(screen.getByRole("banner")).toBeInTheDocument();
      expect(screen.getByRole("navigation")).toBeInTheDocument();
    });
  });
});
