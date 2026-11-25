import { test, expect, type Page } from "@playwright/test";

/**
 * E2E coverage for the savings social feed (/social): opted-in achievements
 * only, privacy rules, the Following/All savers filter, reactions, comments,
 * follow/unfollow and the sharing settings.
 */

const VIEWER = { id: "viewer-1", email: "viewer@example.com" };

function author(
  userId: string,
  displayName: string,
  extra: Partial<{ optedIn: boolean; isFollowing: boolean; followsViewer: boolean }> = {},
) {
  return { userId, displayName, optedIn: true, isFollowing: false, followsViewer: false, ...extra };
}

const POSTS = [
  {
    id: "post-friend",
    author: author("u-ada", "Ada", { isFollowing: true, followsViewer: true }),
    kind: "goalCompleted",
    title: "Emergency fund complete",
    amount: 1000,
    createdAt: "2026-11-20T10:00:00Z",
    visibility: "friends",
    reactions: { "🎉": 2 },
    viewerReactions: [],
    comments: [],
  },
  {
    id: "post-public",
    author: author("u-ben", "Ben"),
    kind: "streak",
    title: "30-day savings streak",
    createdAt: "2026-11-19T10:00:00Z",
    visibility: "public",
    reactions: {},
    viewerReactions: [],
    comments: [],
  },
  {
    // Author has not opted in: must never appear.
    id: "post-not-opted-in",
    author: author("u-cy", "Cy", { optedIn: false, isFollowing: true }),
    kind: "milestone",
    title: "Hidden milestone",
    createdAt: "2026-11-18T10:00:00Z",
    visibility: "public",
    reactions: {},
    viewerReactions: [],
    comments: [],
  },
  {
    // Friends-only post from someone who is not a mutual follower.
    id: "post-friends-only-stranger",
    author: author("u-dee", "Dee", { isFollowing: true }),
    kind: "badge",
    title: "Secret badge",
    createdAt: "2026-11-17T10:00:00Z",
    visibility: "friends",
    reactions: {},
    viewerReactions: [],
    comments: [],
  },
];

async function setup(page: Page) {
  await page.addInitScript(viewer => {
    window.localStorage.setItem(
      "stow-session",
      JSON.stringify({ accessToken: "token", user: viewer, address: "GVIEWER" }),
    );
    window.localStorage.setItem("stow-onboarding-complete", "true");
  }, VIEWER);

  const calls: { method: string; url: string; body: string | null }[] = [];

  await page.route("**/api/social/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({ method: request.method(), url: url.pathname, body: request.postData() });

    if (url.pathname.endsWith("/api/social/feed")) {
      return route.fulfill({ json: { posts: POSTS } });
    }
    if (url.pathname.endsWith("/api/social/settings")) {
      return route.fulfill({
        json:
          request.method() === "PUT"
            ? JSON.parse(request.postData() ?? "{}")
            : { optIn: false, visibility: "friends" },
      });
    }
    if (url.pathname.endsWith("/comments")) {
      const { body } = JSON.parse(request.postData() ?? "{}");
      return route.fulfill({
        json: {
          comment: {
            id: "c-1",
            authorId: VIEWER.id,
            authorName: "Viewer",
            body,
            createdAt: "2026-11-21T10:00:00Z",
          },
        },
      });
    }
    return route.fulfill({ status: 204, body: "" });
  });

  return calls;
}

test.describe("savings social feed", () => {
  test("shows only opted-in achievements the viewer may see", async ({ page }) => {
    await setup(page);
    await page.goto("/social");

    const posts = page.getByTestId("achievement-post");
    await expect(posts).toHaveCount(1); // "Following" filter: only Ada
    await expect(posts.first()).toContainText("Emergency fund complete");

    await page.getByRole("tab", { name: "All savers" }).click();
    await expect(posts).toHaveCount(2);
    await expect(page.getByText("30-day savings streak")).toBeVisible();
    await expect(page.getByText("Hidden milestone")).toHaveCount(0);
    await expect(page.getByText("Secret badge")).toHaveCount(0);
  });

  test("reactions and comments work", async ({ page }) => {
    const calls = await setup(page);
    await page.goto("/social");

    const post = page.getByTestId("achievement-post").first();
    await post.getByRole("button", { name: /React 🎉/ }).click();
    await expect(post.getByTestId("reaction-count-🎉")).toHaveText("3");
    await expect.poll(() => calls.some(c => c.method === "POST" && c.url.endsWith("/posts/post-friend/reactions"))).toBe(true);

    await post.getByRole("button", { name: /comments?/ }).click();
    await post.getByLabel("Write a comment").fill("Amazing work!");
    await post.getByRole("button", { name: "Post" }).click();
    await expect(post.getByTestId("post-comment")).toContainText("Amazing work!");
  });

  test("follow and unfollow", async ({ page }) => {
    const calls = await setup(page);
    await page.goto("/social");
    await page.getByRole("tab", { name: "All savers" }).click();

    await page.getByRole("button", { name: "Follow Ben" }).click();
    await expect(page.getByRole("button", { name: "Unfollow Ben" })).toBeVisible();
    await expect.poll(() => calls.some(c => c.method === "POST" && c.url.endsWith("/follow/u-ben"))).toBe(true);

    await page.getByRole("button", { name: "Unfollow Ben" }).click();
    await expect(page.getByRole("button", { name: "Follow Ben" })).toBeVisible();
    await expect.poll(() => calls.some(c => c.method === "DELETE" && c.url.endsWith("/follow/u-ben"))).toBe(true);
  });

  test("privacy settings are saved", async ({ page }) => {
    const calls = await setup(page);
    await page.goto("/social");

    const settings = page.getByTestId("social-privacy-settings");
    const visibility = settings.getByLabel("Who can see them");
    await expect(visibility).toBeDisabled();

    await settings.getByLabel("Share my achievements on the feed").check();
    await expect(visibility).toBeEnabled();
    await visibility.selectOption("public");

    await expect
      .poll(() => {
        const puts = calls.filter(c => c.method === "PUT" && c.url.endsWith("/settings"));
        return puts.length ? JSON.parse(puts[puts.length - 1].body ?? "{}") : null;
      })
      .toEqual({ optIn: true, visibility: "public" });
  });
});
