export type EmailTemplateType =
  | 'event_created'
  | 'match_result_available'
  | 'event_won'
  | 'event_cancelled'
  | 'digest'
  | 'goal_reached';

export interface DigestItem {
  title: string;
  message: string;
}

export interface EmailTemplateContext {
  eventTitle?: string;
  eventId?: string;
  matchHomeTeam?: string;
  matchAwayTeam?: string;
  matchResult?: string;
  userAddress?: string;
  inviteCode?: string;
  digestFrequency?: 'daily' | 'weekly';
  digestItems?: DigestItem[];
  digestPeriod?: string;
  goalName?: string;
  targetAmount?: string;
  reachedAt?: string;
}

const baseStyles = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a2e; line-height: 1.6; }
  .container { max-width: 560px; margin: 0 auto; padding: 32px 24px; }
  .header { background: #6366f1; color: #fff; padding: 24px; border-radius: 8px 8px 0 0; }
  .content { background: #f8fafc; padding: 24px; border-radius: 0 0 8px 8px; border: 1px solid #e2e8f0; border-top: none; }
  .cta { display: inline-block; background: #6366f1; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 16px; }
  .footer { color: #64748b; font-size: 12px; margin-top: 24px; text-align: center; }
`;

export function renderEmailTemplate(
  type: EmailTemplateType,
  context: EmailTemplateContext,
): { subject: string; html: string; text: string } {
  switch (type) {
    case 'event_created':
      return {
        subject: `Your event "${context.eventTitle ?? 'New Event'}" is live on InsightArena`,
        html: wrapHtml(
          'Event Created',
          `<p>Your creator event <strong>${escapeHtml(context.eventTitle ?? 'New Event')}</strong> has been created successfully.</p>
           <p>Share your invite code <strong>${escapeHtml(context.inviteCode ?? '')}</strong> with participants to get started.</p>`,
        ),
        text: `Your event "${context.eventTitle ?? 'New Event'}" is live on InsightArena. Invite code: ${context.inviteCode ?? ''}`,
      };

    case 'match_result_available':
      return {
        subject: `Match result: ${context.matchHomeTeam ?? 'Team A'} vs ${context.matchAwayTeam ?? 'Team B'}`,
        html: wrapHtml(
          'Match Result Available',
          `<p>The match <strong>${escapeHtml(context.matchHomeTeam ?? 'Team A')}</strong> vs <strong>${escapeHtml(context.matchAwayTeam ?? 'Team B')}</strong> in event <strong>${escapeHtml(context.eventTitle ?? '')}</strong> has been resolved.</p>
           <p>Result: <strong>${escapeHtml(context.matchResult ?? 'Pending')}</strong></p>`,
        ),
        text: `Match result available for ${context.matchHomeTeam} vs ${context.matchAwayTeam}. Result: ${context.matchResult}`,
      };

    case 'event_won':
      return {
        subject: `Congratulations! You won "${context.eventTitle ?? 'the event'}"`,
        html: wrapHtml(
          'You Won!',
          `<p>Congratulations! You are a verified winner of <strong>${escapeHtml(context.eventTitle ?? 'the event')}</strong>.</p>
           <p>Log in to InsightArena to claim your payout.</p>`,
        ),
        text: `Congratulations! You won the event "${context.eventTitle ?? 'the event'}".`,
      };

    case 'event_cancelled':
      return {
        subject: `Event cancelled: ${context.eventTitle ?? 'Event'}`,
        html: wrapHtml(
          'Event Cancelled',
          `<p>The event <strong>${escapeHtml(context.eventTitle ?? 'Event')}</strong> has been cancelled by the creator.</p>
           <p>Any stakes will be refunded according to the event rules.</p>`,
        ),
        text: `The event "${context.eventTitle ?? 'Event'}" has been cancelled.`,
      };

    case 'goal_reached':
      return {
        subject: `🎉 Congratulations! You reached your savings goal: ${context.goalName ?? 'Goal'}`,
        html: wrapHtml(
          'Goal Reached!',
          `<p>Congratulations! You've reached your savings goal!</p>
           <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px;margin:16px 0;">
             <strong style="color:#166534;font-size:18px;">${escapeHtml(context.goalName ?? 'Your Goal')}</strong>
             <p style="margin:8px 0 0;color:#166534;">Target: ${escapeHtml(context.targetAmount ?? '0')} USDC</p>
           </div>
           <p style="color:#475569;">Reached on ${context.reachedAt ?? 'today'}</p>
           <p>Keep up the great work! Your dedication to saving is paying off.</p>`,
        ),
        text: `Congratulations! You reached your savings goal: ${context.goalName ?? 'Your Goal'}. Target: ${context.targetAmount ?? '0'} USDC`,
      };

    case 'digest': {
      const freq = context.digestFrequency === 'weekly' ? 'Weekly' : 'Daily';
      const items = context.digestItems ?? [];
      const itemsHtml = items
        .map(
          (item) =>
            `<div style="border-left:3px solid #6366f1;padding:8px 12px;margin:8px 0;">
               <strong>${escapeHtml(item.title)}</strong>
               <p style="margin:4px 0 0;color:#475569;">${escapeHtml(item.message)}</p>
             </div>`,
        )
        .join('');
      const itemsText = items
        .map((item) => `• ${item.title}: ${item.message}`)
        .join('\n');
      return {
        subject:
          `Your ${freq} InsightArena digest — ${context.digestPeriod ?? ''}`.trimEnd(),
        html: wrapHtml(
          `${freq} Activity Digest`,
          `<p>Here's a summary of your recent activity on InsightArena:</p>
           ${itemsHtml}
           <p style="margin-top:16px;color:#475569;font-size:13px;">You have ${items.length} unread notification${items.length === 1 ? '' : 's'}.</p>`,
        ),
        text: `Your ${freq.toLowerCase()} InsightArena digest:\n\n${itemsText}`,
      };
    }

    default:
      return {
        subject: 'InsightArena Notification',
        html: wrapHtml(
          'Notification',
          '<p>You have a new notification from InsightArena.</p>',
        ),
        text: 'You have a new notification from InsightArena.',
      };
  }
}

function wrapHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><style>${baseStyles}</style></head>
    <body><div class="container">
      <div class="header"><h1 style="margin:0;font-size:20px;">${escapeHtml(title)}</h1></div>
      <div class="content">${body}
        <a class="cta" href="https://insightarena.app">View on InsightArena</a>
      </div>
      <div class="footer">You received this email because of your InsightArena notification preferences.</div>
    </div></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[char];
  });
}
