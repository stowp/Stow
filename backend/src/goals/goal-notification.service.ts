import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Goal, GoalStatus } from "../goals/entities/goal.entity";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../notifications/email.service";
import { NotificationType } from "../notifications/entities/notification.entity";
import { NotificationCategory } from "../notifications/entities/notification-category-preference.entity";

export interface GoalReachedEvent {
  onChainId: string;
  owner: string;
  name: string;
  targetAmount: string;
  reachedAt: Date;
}

@Injectable()
export class GoalNotificationService {
  private readonly logger = new Logger(GoalNotificationService.name);

  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Process a goal_reached event from the indexer.
   * Sends push and email notifications based on user preferences.
   */
  async onGoalReached(event: GoalReachedEvent): Promise<void> {
    const goal = await this.goalRepository.findOne({
      where: { on_chain_id: event.onChainId },
    });

    if (!goal) {
      this.logger.warn(`Goal ${event.onChainId} not found for notification`);
      return;
    }

    // Skip if already processed
    if (goal.status === GoalStatus.REACHED) {
      return;
    }

    // Update goal status
    goal.status = GoalStatus.REACHED;
    goal.reached_at = event.reachedAt;
    await this.goalRepository.save(goal);

    // Send notifications
    await this.sendGoalReachedNotifications(event);
  }

  private async sendGoalReachedNotifications(event: GoalReachedEvent): Promise<void> {
    const title = "🎉 Goal Reached!";
    const message = `Congratulations! You've reached your savings goal: ${event.name}`;
    const data = {
      type: "goal_reached",
      on_chain_id: event.onChainId,
      name: event.name,
      target_amount: event.targetAmount,
      reached_at: event.reachedAt.toISOString(),
    };

    // Check in-app notification preference
    const inAppEnabled = await this.notificationsService.isCategoryEnabled(
      event.owner,
      NotificationCategory.GOALS,
      "in_app",
    );

    if (inAppEnabled) {
      try {
        await this.notificationsService.create(
          event.owner,
          NotificationType.GOAL_REACHED,
          title,
          message,
          data,
        );
        this.logger.log(`In-app notification sent for goal ${event.onChainId}`);
      } catch (err) {
        this.logger.error(`Failed to send in-app notification: ${err}`);
      }
    }

    // Check email notification preference
    const emailEnabled = await this.notificationsService.isCategoryEnabled(
      event.owner,
      NotificationCategory.GOALS,
      "email",
    );

    if (emailEnabled) {
      try {
        await this.emailService.sendGoalReachedEmail(
          event.owner,
          {
            goalName: event.name,
            targetAmount: event.targetAmount,
            reachedAt: event.reachedAt,
          },
        );
        this.logger.log(`Email notification sent for goal ${event.onChainId}`);
      } catch (err) {
        this.logger.error(`Failed to send email notification: ${err}`);
      }
    }

    // Log delivery status
    this.logger.log(
      `Goal ${event.onChainId} notification delivery: in_app=${inAppEnabled}, email=${emailEnabled}`,
    );
  }
}