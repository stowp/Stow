import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGoalMilestoneAndYieldNotifications1793300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user_preferences"
      ADD COLUMN IF NOT EXISTS "goal_milestone_notifications" boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "yield_earned_notifications" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user_preferences"
      DROP COLUMN IF EXISTS "yield_earned_notifications",
      DROP COLUMN IF EXISTS "goal_milestone_notifications"
    `);
  }
}
