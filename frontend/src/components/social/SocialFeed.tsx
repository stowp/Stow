"use client";

import { useId, useState } from "react";
import { AlertCircle, Sparkles } from "lucide-react";
import AchievementPost from "@/components/social/AchievementPost";
import ErrorRetry from "@/components/ui/ErrorRetry";
import {
  FEED_FILTERS,
  POST_VISIBILITIES,
  useSocialFeed,
  type FeedFilter,
  type PostVisibility,
} from "@/hooks/useSocialFeed";

export const FILTER_LABELS: Record<FeedFilter, string> = {
  friends: "Following",
  all: "All savers",
};

export const VISIBILITY_LABELS: Record<PostVisibility, string> = {
  public: "Everyone",
  friends: "Friends only",
  private: "Only me",
};

export interface SocialFeedProps {
  currentUserId?: string | null;
  initialFilter?: FeedFilter;
}

/**
 * Community feed of shared savings achievements. Viewers can switch between
 * people they follow and all savers, react, comment, follow/unfollow, and
 * control whether (and to whom) their own achievements are shared.
 */
export default function SocialFeed({
  currentUserId = null,
  initialFilter = "friends",
}: SocialFeedProps) {
  const [filter, setFilter] = useState<FeedFilter>(initialFilter);
  const {
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
  } = useSocialFeed({ filter, currentUserId });
  const optInId = useId();
  const visibilityId = useId();

  return (
    <section aria-labelledby="social-feed-heading" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="social-feed-heading" className="text-xl font-semibold text-foreground">
          Community achievements
        </h2>
        <div role="tablist" aria-label="Feed filter" className="flex rounded-xl border border-border p-1">
          {FEED_FILTERS.map(option => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={filter === option}
              onClick={() => setFilter(option)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand/50 ${
                filter === option ? "bg-brand text-white" : "text-muted hover:text-foreground"
              }`}
            >
              {FILTER_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      <fieldset
        data-testid="social-privacy-settings"
        className="rounded-2xl border border-border bg-card p-4"
      >
        <legend className="px-1 text-sm font-medium text-foreground">Sharing &amp; privacy</legend>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label htmlFor={optInId} className="flex items-center gap-2 text-sm text-foreground">
            <input
              id={optInId}
              type="checkbox"
              checked={settings.optIn}
              onChange={e => void updateSettings({ optIn: e.target.checked })}
              className="h-4 w-4 accent-brand"
            />
            Share my achievements on the feed
          </label>
          <label htmlFor={visibilityId} className="flex items-center gap-2 text-sm text-muted">
            Who can see them
            <select
              id={visibilityId}
              value={settings.visibility}
              disabled={!settings.optIn}
              onChange={e => void updateSettings({ visibility: e.target.value as PostVisibility })}
              className="rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/50"
            >
              {POST_VISIBILITIES.map(v => (
                <option key={v} value={v}>
                  {VISIBILITY_LABELS[v]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!settings.optIn && (
          <p className="mt-2 text-xs text-muted">
            Your achievements are private. Turn on sharing to celebrate them with the community.
          </p>
        )}
      </fieldset>

      {actionError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {actionError.message}
        </div>
      )}

      {status === "error" ? (
        <ErrorRetry error={error} onRetry={refetch} />
      ) : status === "loading" ? (
        <ul className="space-y-4" aria-busy="true" aria-label="Loading feed">
          {[0, 1, 2].map(i => (
            <li key={i} className="h-40 animate-pulse rounded-2xl border border-border bg-card" />
          ))}
        </ul>
      ) : posts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border p-10 text-center">
          <Sparkles className="h-8 w-8 text-brand" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">No achievements to show yet</p>
          <p className="text-sm text-muted">
            {filter === "friends"
              ? "Follow other savers to see their milestones here, or switch to All savers."
              : "When savers share their milestones, they'll appear here."}
          </p>
        </div>
      ) : (
        <ul className="space-y-4" data-testid="social-feed-list">
          {posts.map(post => (
            <li key={post.id}>
              <AchievementPost
                post={post}
                currentUserId={currentUserId}
                onToggleReaction={(id, reaction) => void toggleReaction(id, reaction)}
                onComment={addComment}
                onFollow={id => void follow(id)}
                onUnfollow={id => void unfollow(id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
