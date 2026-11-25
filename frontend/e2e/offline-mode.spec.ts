import { test, expect, type Page } from "@playwright/test";

/**
 * E2E coverage for offline mode: the offline indicator, last sync time,
 * cached data, queued operations, sync on reconnection and conflicts.
 */

const LAST_SYNC = "2026-11-20T09:30:00.000Z";

function queuedOp(id: string, type: "deposit" | "withdraw", amount: string) {
  return {
    id,
    type,
    account: "GOWNER",
    amount,
    createdAt: "2026-11-20T10:00:00.000Z",
    idempotencyKey: `key-${id}`,
    status: "pending",
  };
}

async function seed(page: Page, queue: unknown[] = []) {
  await page.addInitScript(
    ({ queue, lastSync }) => {
      if (window.sessionStorage.getItem("seeded")) return;
      window.sessionStorage.setItem("seeded", "1");
      window.localStorage.setItem("stow-offline-queue", JSON.stringify(queue));
      window.localStorage.setItem("stow-offline-last-sync", JSON.stringify(lastSync));
    },
    { queue, lastSync: LAST_SYNC },
  );
}

test.describe("offline mode", () => {
  test("shows the offline indicator with last sync time", async ({ page, context }) => {
    await seed(page);
    await page.goto("/");

    const indicator = page.getByTestId("offline-indicator");
    await expect(indicator).toHaveCount(0);

    await context.setOffline(true);
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText(/offline/i);
    await expect(page.getByTestId("offline-last-sync")).toContainText("Last synced");

    await context.setOffline(false);
    await expect(indicator).toHaveCount(0);
  });

  test("operations queue offline and sync on reconnection", async ({ page, context }) => {
    const sent: { url: string; key: string | undefined; body: string | null }[] = [];
    await page.route("**/api/savings/flexible/**", async route => {
      const request = route.request();
      sent.push({
        url: new URL(request.url()).pathname,
        key: request.headers()["idempotency-key"],
        body: request.postData(),
      });
      await route.fulfill({ json: { owner: "GOWNER", balance: "0" } });
    });

    await seed(page);
    await page.goto("/");
    await context.setOffline(true);

    // Operations made while offline land in the queue.
    await page.evaluate(ops => {
      localStorage.setItem("stow-offline-queue", JSON.stringify(ops));
      window.dispatchEvent(new Event("stow:offline-changed"));
    }, [queuedOp("a", "deposit", "50000000"), queuedOp("b", "withdraw", "10000000")]);

    await expect(page.getByTestId("offline-queue-count")).toContainText("2 operations queued");
    expect(sent).toHaveLength(0);

    await context.setOffline(false);
    await expect(page.getByTestId("offline-indicator")).toHaveCount(0);

    // Replayed in order, with the original idempotency keys.
    expect(sent.map(s => s.url)).toEqual([
      "/api/savings/flexible/deposit",
      "/api/savings/flexible/withdraw",
    ]);
    expect(sent.map(s => s.key)).toEqual(["key-a", "key-b"]);
    expect(JSON.parse(sent[1].body ?? "{}")).toEqual({ owner: "GOWNER", amount: "10000000" });

    // Last sync time moves forward after a successful sync.
    const lastSync = await page.evaluate(() => localStorage.getItem("stow-offline-last-sync"));
    expect(Date.parse(JSON.parse(lastSync ?? "null"))).toBeGreaterThan(Date.parse(LAST_SYNC));
  });

  test("rejected operations are shown as conflicts", async ({ page }) => {
    await page.route("**/api/savings/flexible/**", route =>
      route.fulfill({ status: 409, json: { message: "Insufficient balance" } }),
    );
    // Left over from an offline session: synced as soon as the app loads.
    await seed(page, [queuedOp("c", "withdraw", "999999999999")]);
    await page.goto("/");

    const conflicts = page.getByTestId("offline-conflicts");
    await expect(conflicts).toContainText("Insufficient balance");

    await conflicts.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("offline-indicator")).toHaveCount(0);
  });

  test("cached balance is shown when the network is unavailable", async ({ page }) => {
    await seed(page);
    await page.addInitScript(() => {
      localStorage.setItem(
        "stow-session",
        JSON.stringify({ accessToken: "token", user: { id: "u-1" }, address: "GOWNER" }),
      );
      localStorage.setItem("stow-onboarding-complete", "true");
      localStorage.setItem(
        "stow-offline-cache:summary:GOWNER",
        JSON.stringify({
          data: {
            address: "GOWNER",
            products: [
              { product: "flexible", total: "1234500000" },
              { product: "goals", total: "0" },
            ],
            total: "1234500000",
          },
          cachedAt: "2026-11-20T09:30:00.000Z",
        }),
      );
    });
    // The summary request fails as it would with no connection.
    await page.route("**/api/savings/summary**", route => route.abort("internetdisconnected"));

    await page.goto("/dashboard");
    await expect(page.getByTestId("summary-total")).toContainText("123.45");
  });
});
