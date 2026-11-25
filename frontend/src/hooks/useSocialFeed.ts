import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, ApiError } from "@/lib/api";

/**
 * Savings social feed: achievements users have chosen to share, plus
 * reactions, comments and follow/unfollow.
 *
 * API (all under `/api/social`):
 * - `GET  /feed?filter=friends|all`                → `{ posts: AchievementPost[] }`
 * - `POST /posts/:id/reactions` `{ reaction }`     → add the viewer's reaction
 * - `DELETE /posts/:id/reactions/:reaction`        → remove it
 * - `POST /posts/:id/comments` `{ body }`          → `{ comment }`
 * - `POST /follow/:userId` / `DELETE /follow/:userId`
 * - `GET  /settings` / `PUT /settings` `{ optIn, visibility }`
 *
 * The server is expected to enforce privacy, but the client applies the
 * same rules again and **fails closed**: a post whose author hasn't opted in,
 * or whose visibility is missing/unknown, is never shown to anyone but its
 * author.
 */

export type FeedFilter = "friends" | "all";

export const FEED_FILTERS: readonly FeedFilter[] = ["friends", "all"];

/** Who can see a post. `friends` means mutual followers. */
export type PostVisibility = "public" | "friends" | "private";

export const POST_VISIBILITIES: readonly PostVisibility[] = [
  "public",
  "friends",
  "private",
];

export type AchievementKind = "milestone" | "goalCompleted" | "streak" | "badge";

const ACHIEVEMENT_KINDS: readonly AchievementKind[] = [
  "milestone",
  "goalCompleted",
  "streak",
  "badge",
];

/** Reactions a viewer can leave on a post. */
export const REACTIONS = ["🎉", "👏", "🔥", "💪"] as const;
export type Reaction = (typeof REACTIONS)[number];

export interface FeedAuthor {
  userId: string;
  displayName: string;
  /** Has this user opted in to sharing achievements publicly? */
  optedIn: boolean;
  /** Does the viewer follow this user? */
  isFollowing: boolean;
  /** Does this user follow the viewer? Mutual follow = friends. */
  followsViewer: boolean;
}

export interface FeedComment {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface AchievementPostData {
  id: string;
  author: FeedAuthor;
  kind: AchievementKind;
  title: string;
  description: string;
  /** Amount saved for the milestone, in USDC, if applicable. */
  amount: number | null;
  createdAt: string;
  visibility: PostVisibility;
  reactions: Record<Reaction, number>;
  /** Reactions the viewer has left on this post. */
  viewerReactions: Reaction[];
  comments: FeedComment[];
}

export interface SocialSettings {
  /** Share my achievements on the feed. Off by default. */
  optIn: boolean;
  /** Default visibility of my posts. */
  visibility: PostVisibility;
}

export const DEFAULT_SOCIAL_SETTINGS: SocialSettings = {
  optIn: false,
  visibility: "friends",
};

export type SocialFeedStatus = "loading" | "ready" | "error";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function emptyReactions(): Record<Reaction, number> {
  return Object.fromEntries(REACTIONS.map(r => [r, 0])) as Record<Reaction, number>;
}

function parseComment(raw: unknown): FeedComment | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.body !== "string") return null;
  return {
    id: c.id,
    authorId: str(c.authorId),
    authorName: str(c.authorName) || "Saver",
    body: c.body,
    createdAt: str(c.createdAt),
  };
}

/**
 * Turns the feed response (`{ posts: [...] }` or a bare array) into
 * well-formed posts, dropping anything unusable. Unknown visibility is
 * treated as `private` and a missing opt-in flag as `false`, so malformed
 * data can't leak a post.
 */
export function parseFeedResponse(body: unknown): AchievementPostData[] {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === "object" && "posts" in body
      ? (body as { posts: unknown }).posts
      : null;
  if (!Array.isArray(raw)) return [];

  const posts: AchievementPostData[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const author = (p.author ?? {}) as Record<string, unknown>;
    if (typeof p.id !== "string" || typeof author.userId !== "string") continue;

    const reactions = emptyReactions();
    const rawReactions = (p.reactions ?? {}) as Record<string, unknown>;
    for (const r of REACTIONS) {
      const n = rawReactions[r];
      reactions[r] = typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
    }

    posts.push({
      id: p.id,
      author: {
        userId: author.userId,
        displayName: str(author.displayName) || "Saver",
        optedIn: author.optedIn === true,
        isFollowing: author.isFollowing === true,
        followsViewer: author.followsViewer === true,
      },
      kind: ACHIEVEMENT_KINDS.includes(p.kind as AchievementKind)
        ? (p.kind as AchievementKind)
        : "milestone",
      title: str(p.title),
      description: str(p.description),
      amount: typeof p.amount === "number" && Number.isFinite(p.amount) ? p.amount : null,
      createdAt: str(p.createdAt),
      visibility: POST_VISIBILITIES.includes(p.visibility as PostVisibility)
        ? (p.visibility as PostVisibility)
        : "private",
      reactions,
      viewerReactions: Array.isArray(p.viewerReactions)
        ? (p.viewerReactions.filter(r =>
            (REACTIONS as readonly string[]).includes(r as string),
          ) as Reaction[])
        : [],
      comments: Array.isArray(p.comments)
        ? p.comments.map(parseComment).filter((c): c is FeedComment => c !== null)
        : [],
    });
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Privacy + filtering
// ---------------------------------------------------------------------------

/** Mutual follow. */
export function isFriend(author: FeedAuthor): boolean {
  return author.isFollowing && author.followsViewer;
}

/**
 * Can `viewerId` see `post`? Authors always see their own posts. Everyone
 * else only sees posts from opted-in authors, and then only if the post's
 * visibility allows it: `public` → anyone, `friends` → mutual followers,
 * `private` → nobody.
 */
export function canView(post: AchievementPostData, viewerId: string | null): boolean {
  if (viewerId && post.author.userId === viewerId) return true;
  if (!post.author.optedIn) return false;
  switch (post.visibility) {
    case "public":
      return true;
    case "friends":
      return isFriend(post.author);
    default:
      return false;
  }
}

/**
 * Applies privacy rules, then the connection filter: `friends` keeps posts
 * from people the viewer follows (and the viewer's own); `all` keeps every
 * visible post. Newest first.
 */
export function filterFeed(
  posts: AchievementPostData[],
  filter: FeedFilter,
  viewerId: string | null,
): AchievementPostData[] {
  return posts
    .filter(post => canView(post, viewerId))
    .filter(
      post =>
        filter === "all" ||
        post.author.isFollowing ||
        (viewerId !== null && post.author.userId === viewerId),
    )
    .sort((a, b) => Date.parse(b.createdAt || "0") - Date.parse(a.createdAt || "0"));
}

function parseSettings(body: unknown): SocialSettings {
  const raw =
    body && typeof body === "object" && "settings" in body
      ? (body as { settings: unknown }).settings
      : body;
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    optIn: s.optIn === true,
    visibility: POST_VISIBILITIES.includes(s.visibility as PostVisibility)
      ? (s.visibility as PostVisibility)
      : DEFAULT_SOCIAL_SETTINGS.visibility,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSocialFeedOptions {
  filter: FeedFilter;
  /** The viewer, so their own posts are always visible to them. */
  currentUserId?: string | null;
}

export interface UseSocialFeedReturn {
  /** Visible posts after privacy rules and the connection filter. */
  posts: AchievementPostData[];
  status: SocialFeedStatus;
  error: Error | null;
  /** Error from the most recent reaction/comment/follow/settings action. */
  actionError: Error | null;
  settings: SocialSettings;
  refetch: () => void;
  /** Toggle the viewer's `reaction` on a post. */
  toggleReaction: (postId: string, reaction: Reaction) => Promise<void>;
  addComment: (postId: string, body: string) => Promise<boolean>;
  follow: (userId: string) => Promise<void>;
  unfollow: (userId: string) => Promise<void>;
  updateSettings: (next: Partial<SocialSettings>) => Promise<void>;
}

async function ensureOk(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    let message = `Failed to ${what} (${response.status})`;
    try {
      const data = await response.clone().json();
      if (data && typeof data.message === "string") message = data.message;
    } catch {
      // Not JSON.
    }
    throw new ApiError(message, response.status);
  }
  return response;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function useSocialFeed({
  filter,
  currentUserId = null,
}: UseSocialFeedOptions): UseSocialFeedReturn {
  const [allPosts, setAllPosts] = useState<AchievementPostData[]>([]);
  const [status, setStatus] = useState<SocialFeedStatus>("loading");
  const [error, setError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [settings, setSettings] = useState<SocialSettings>(DEFAULT_SOCIAL_SETTINGS);
  const [refetchCount, setRefetchCount] = useState(0);
  const postsRef = useRef(allPosts);
  postsRef.current = allPosts;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setError(null);

    (async () => {
      try {
        const response = await ensureOk(
          await apiFetch(`/api/social/feed?filter=${encodeURIComponent(filter)}`),
          "load the feed",
        );
        const posts = parseFeedResponse(await response.json());
        if (cancelled) return;
        setAllPosts(posts);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(toError(err));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [filter, refetchCount]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await apiFetch("/api/social/settings");
        if (!response.ok) return;
        const next = parseSettings(await response.json());
        if (!cancelled) setSettings(next);
      } catch {
        // Keep the private-by-default settings.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Apply `update` optimistically; roll back if `request` fails. */
  const optimistic = useCallback(
    async (
      update: (posts: AchievementPostData[]) => AchievementPostData[],
      request: () => Promise<unknown>,
    ) => {
      const previous = postsRef.current;
      setAllPosts(update(previous));
      setActionError(null);
      try {
        await request();
      } catch (err) {
        setAllPosts(previous);
        setActionError(toError(err));
      }
    },
    [],
  );

  const toggleReaction = useCallback(
    async (postId: string, reaction: Reaction) => {
      const post = postsRef.current.find(p => p.id === postId);
      if (!post) return;
      const active = post.viewerReactions.includes(reaction);
      const path = `/api/social/posts/${encodeURIComponent(postId)}/reactions`;

      await optimistic(
        posts =>
          posts.map(p =>
            p.id !== postId
              ? p
              : {
                  ...p,
                  reactions: {
                    ...p.reactions,
                    [reaction]: Math.max(0, p.reactions[reaction] + (active ? -1 : 1)),
                  },
                  viewerReactions: active
                    ? p.viewerReactions.filter(r => r !== reaction)
                    : [...p.viewerReactions, reaction],
                },
          ),
        async () =>
          ensureOk(
            active
              ? await apiFetch(`${path}/${encodeURIComponent(reaction)}`, {
                  method: "DELETE",
                })
              : await apiFetch(path, {
                  method: "POST",
                  body: JSON.stringify({ reaction }),
                }),
            "update the reaction",
          ),
      );
    },
    [optimistic],
  );

  const addComment = useCallback(async (postId: string, body: string) => {
    const text = body.trim();
    if (!text) return false;
    setActionError(null);
    try {
      const response = await ensureOk(
        await apiFetch(`/api/social/posts/${encodeURIComponent(postId)}/comments`, {
          method: "POST",
          body: JSON.stringify({ body: text }),
        }),
        "post the comment",
      );
      const data = await response.json().catch(() => null);
      const comment =
        parseComment(data && typeof data === "object" && "comment" in data ? data.comment : data) ?? {
          id: `local-${Date.now()}`,
          authorId: currentUserId ?? "",
          authorName: "You",
          body: text,
          createdAt: new Date().toISOString(),
        };
      setAllPosts(posts =>
        posts.map(p => (p.id === postId ? { ...p, comments: [...p.comments, comment] } : p)),
      );
      return true;
    } catch (err) {
      setActionError(toError(err));
      return false;
    }
  }, [currentUserId]);

  const setFollowing = useCallback(
    (userId: string, following: boolean) =>
      optimistic(
        posts =>
          posts.map(p =>
            p.author.userId === userId
              ? { ...p, author: { ...p.author, isFollowing: following } }
              : p,
          ),
        async () =>
          ensureOk(
            await apiFetch(`/api/social/follow/${encodeURIComponent(userId)}`, {
              method: following ? "POST" : "DELETE",
            }),
            following ? "follow" : "unfollow",
          ),
      ),
    [optimistic],
  );

  const follow = useCallback((userId: string) => setFollowing(userId, true), [setFollowing]);
  const unfollow = useCallback((userId: string) => setFollowing(userId, false), [setFollowing]);

  const updateSettings = useCallback(async (next: Partial<SocialSettings>) => {
    const previous = settingsRef.current;
    const merged = { ...previous, ...next };
    setSettings(merged);
    setActionError(null);
    try {
      await ensureOk(
        await apiFetch("/api/social/settings", {
          method: "PUT",
          body: JSON.stringify(merged),
        }),
        "save your sharing settings",
      );
    } catch (err) {
      setSettings(previous);
      setActionError(toError(err));
    }
  }, []);

  const posts = useMemo(
    () => filterFeed(allPosts, filter, currentUserId),
    [allPosts, filter, currentUserId],
  );

  const refetch = useCallback(() => setRefetchCount(c => c + 1), []);

  return {
    posts,
    status,
    error,
    actionError,
    settings,
    refetch,
    toggleReaction,
    addComment,
    follow,
    unfollow,
    updateSettings,
  };
}
