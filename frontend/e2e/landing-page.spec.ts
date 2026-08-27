import { test, expect } from "@playwright/test";

test.describe("Landing Page Smoke Tests", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("should load the landing page", async ({ page }) => {
    await expect(page).toHaveTitle(/Stow/i);
  });

  test("should display the main navigation", async ({ page }) => {
    // Check logo
    await expect(page.getByText("Stow")).toBeVisible();

    // Check navigation links
    await expect(page.getByRole("link", { name: "Features" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Products" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Onboarding" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Architecture" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Roadmap" })).toBeVisible();
  });

  test("should display CTA buttons", async ({ page }) => {
    await expect(page.getByRole("link", { name: /github/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /launch app/i })).toBeVisible();
  });

  test("should display waitlist form", async ({ page }) => {
    const emailInput = page.getByPlaceholder(/you@email.com/i);
    await expect(emailInput).toBeVisible();

    const submitButton = page.getByRole("button", {
      name: /join waitlist/i,
    });
    await expect(submitButton).toBeVisible();
  });

  test("should handle waitlist form submission", async ({ page }) => {
    const emailInput = page.getByPlaceholder(/you@email.com/i);
    const submitButton = page.getByRole("button", {
      name: /join waitlist/i,
    });

    // Fill and submit valid email
    await emailInput.fill("test@example.com");
    await submitButton.click();

    // Wait for success message
    await expect(
      page.getByText(/you're on the list — we'll be in touch/i),
    ).toBeVisible({ timeout: 2000 });
  });

  test("should show validation error for invalid email", async ({ page }) => {
    const emailInput = page.getByPlaceholder(/you@email.com/i);
    const submitButton = page.getByRole("button", {
      name: /join waitlist/i,
    });

    // Submit invalid email
    await emailInput.fill("invalid-email");
    await submitButton.click();

    // Check for error message
    await expect(
      page.getByText(/please enter a valid email address/i),
    ).toBeVisible();
  });

  test("should have working navigation scroll links", async ({ page }) => {
    // Click a navigation link
    await page.getByRole("link", { name: "Features" }).first().click();

    // URL should update with hash
    await expect(page).toHaveURL(/#features$/);
  });

  test("should have responsive mobile menu", async ({ page, viewport }) => {
    // Only test on mobile viewports
    if (!viewport || viewport.width > 768) {
      test.skip();
    }

    // Mobile menu button should be visible
    const menuButton = page.getByRole("button", { name: /toggle menu/i });
    await expect(menuButton).toBeVisible();

    // Click to open menu
    await menuButton.click();

    // Mobile menu links should appear
    await expect(
      page.getByRole("link", { name: "Features" }).last(),
    ).toBeVisible();
  });

  test("should apply scroll effects to navbar", async ({ page }) => {
    // Get the navbar
    const navbar = page.locator("header").first();

    // Initially should be transparent
    await expect(navbar).toHaveClass(/border-transparent/);

    // Scroll down
    await page.evaluate(() => window.scrollTo(0, 100));

    // Wait a bit for scroll effect
    await page.waitForTimeout(300);

    // Should have backdrop blur
    await expect(navbar).toHaveClass(/backdrop-blur-xl/);
  });

  test("should have accessible form elements", async ({ page }) => {
    const emailInput = page.getByLabelText(/email address/i);
    await expect(emailInput).toBeVisible();

    // Check ARIA attributes
    const inputElement = await emailInput.elementHandle();
    const ariaInvalid = await inputElement?.getAttribute("aria-invalid");
    expect(ariaInvalid).toBeDefined();
  });

  test("should load without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(errors).toHaveLength(0);
  });
});
