"use client";

import { useId, useState } from "react";
import { Award, Flame, Lock, MessageCircle, PartyPopper, Target, Users, Globe } from "lucide-react";
import {
  REACTIONS,
  isFriend,
  type AchievementKind,
  type AchievementPostData,
  type PostVisibility,
  type Reaction,
} from "@/hooks/useSocialFeed";
import { formatNumber } from "@/lib/currency";

const KIND_STYLES: Record<AchievementKind, { label: string; Icon: typeof Award }> = {
  milestone: { label: "Milestone", Icon: PartyPopper },
  goalCompleted: { label: "Goal completed", Icon: Target },
  streak: { label: "Savings streak", Icon: Flame },
  badge: { label: "Badge earned", Icon: Award },
};

const VISIBILITY_STYLES: Record<PostVisibility, { label: string; Icon: typeof Globe }> = {
  public: { label: "Public", Icon: Globe },
  friends: { label: "Friends only", Icon: Users },
  private: { label: "Only you", Icon: Lock },
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export interface AchievementPostProps {
  post: AchievementPostData;
  /** The viewer; hides the follow button on their own posts. */
  currentUserId?: string | null;
  onToggleReaction: (postId: string, reaction: Reaction) => void;
  /** Resolves `true` once the comment is posted. */
  onComment: (postId: string, body: string) => Promise<boolean>;
  onFollow: (userId: string) => void;
  onUnfollow: (userId: string) => void;
}

/**
 * One achievement on the social feed: who reached what, reactions, comments,
 * and a follow/unfollow toggle for the author.
 */
export default function AchievementPost({
  post,
  currentUserId = null,
  onToggleReaction,
  onComment,
  onFollow,
  onUnfollow,
}: AchievementPostProps) {
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const commentInputId = useId();
  const commentsId = useId();

  const { label: kindLabel, Icon: KindIcon } = KIND_STYLES[post.kind];
  const { label: visibilityLabel, Icon: VisibilityIcon } = VISIBILITY_STYLES[post.visibility];
  const isOwn = currentUserId !== null && post.author.userId === currentUserId;
  const friend = isFriend(post.author);

  const submitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !draft.trim()) return;
    setSubmitting(true);
    const ok = await onComment(post.id, draft);
    setSubmitting(false);
    if (ok) setDraft("");
  };

  return (
    <article
      data-testid="achievement-post"
      aria-labelledby={`${post.id}-title`}
      className="rounded-2xl border border-border bg-card p-5"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
            <KindIcon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">
              {isOwn ? "You" : post.author.displayName}
              {friend && !isOwn && (
                <span className="ml-2 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-xs text-brand">
                  Friend
                </span>
              )}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
              <span>{kindLabel}</span>
              {post.createdAt && <span aria-hidden="true">·</span>}
              {post.createdAt && <time dateTime={post.createdAt}>{formatDate(post.createdAt)}</time>}
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <VisibilityIcon className="h-3 w-3" aria-hidden="true" />
                {visibilityLabel}
              </span>
            </p>
          </div>
        </div>

        {!isOwn && (
          <button
            type="button"
            onClick={() =>
              post.author.isFollowing
                ? onUnfollow(post.author.userId)
                : onFollow(post.author.userId)
            }
            aria-pressed={post.author.isFollowing}
            aria-label={`${post.author.isFollowing ? "Unfollow" : "Follow"} ${post.author.displayName}`}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand/50 ${
              post.author.isFollowing
                ? "border-border text-muted hover:bg-card/70"
                : "border-brand bg-brand text-white hover:bg-brand/90"
            }`}
          >
            {post.author.isFollowing ? "Following" : "Follow"}
          </button>
        )}
      </header>

      <h3 id={`${post.id}-title`} className="mt-4 text-base font-semibold text-foreground">
        {post.title}
      </h3>
      {post.description && <p className="mt-1 text-sm text-muted">{post.description}</p>}
      {post.amount !== null && (
        <p className="mt-2 text-lg font-semibold text-brand">
          {formatNumber(post.amount, { maximumFractionDigits: 2 })} USDC
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Reactions">
        {REACTIONS.map(reaction => {
          const active = post.viewerReactions.includes(reaction);
          const count = post.reactions[reaction];
          return (
            <button
              key={reaction}
              type="button"
              onClick={() => onToggleReaction(post.id, reaction)}
              aria-pressed={active}
              aria-label={`React ${reaction} (${count})`}
              className={`flex items-center gap-1 rounded-full border px-3 py-1 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-brand/50 ${
                active ? "border-brand bg-brand/10 text-foreground" : "border-border text-muted hover:bg-card/70"
              }`}
            >
              <span aria-hidden="true">{reaction}</span>
              <span data-testid={`reaction-count-${reaction}`}>{count}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setCommentsOpen(open => !open)}
          aria-expanded={commentsOpen}
          aria-controls={commentsId}
          className="ml-auto flex items-center gap-1 rounded-full px-3 py-1 text-sm text-muted transition-colors hover:bg-card/70 focus:outline-none focus:ring-2 focus:ring-brand/50"
        >
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
          {post.comments.length} {post.comments.length === 1 ? "comment" : "comments"}
        </button>
      </div>

      {commentsOpen && (
        <div id={commentsId} className="mt-4 border-t border-border pt-4">
          {post.comments.length > 0 ? (
            <ul className="space-y-3" aria-label="Comments">
              {post.comments.map(comment => (
                <li key={comment.id} data-testid="post-comment" className="text-sm">
                  <span className="font-medium text-foreground">
                    {comment.authorId && comment.authorId === currentUserId ? "You" : comment.authorName}
                  </span>{" "}
                  <span className="text-muted">{comment.body}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No comments yet. Be the first to cheer them on.</p>
          )}

          <form onSubmit={submitComment} className="mt-3 flex gap-2">
            <label htmlFor={commentInputId} className="sr-only">
              Write a comment
            </label>
            <input
              id={commentInputId}
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              maxLength={500}
              placeholder="Write a comment…"
              className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/50"
            />
            <button
              type="submit"
              disabled={submitting || !draft.trim()}
              className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-brand/50"
            >
              Post
            </button>
          </form>
        </div>
      )}
    </article>
  );
}
