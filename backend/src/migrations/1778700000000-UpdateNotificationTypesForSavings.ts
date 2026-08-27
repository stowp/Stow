import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `notifications.type` is a plain varchar (no DB-level enum), but the
 * `NotificationType` TypeScript enum has been narrowed from prediction-market
 * kinds to savings kinds only — see `notification.entity.ts`. Any existing
 * rows using now-removed type strings are dead prediction-market
 * notifications with no equivalent savings type to map onto, so this
 * permanently removes them.
 */
export class UpdateNotificationTypesForSavings1778700000000
  implements MigrationInterface
{
  private readonly legacyTypes = [
    'event_created',
    'match_added',
    'prediction_submitted',
    'match_resolved',
    'winner_verified',
    'event_cancelled',
    'dispute_sla_approaching',
    'dispute_sla_breached',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "notifications" WHERE "type" = ANY($1)`,
      [this.legacyTypes],
    );
  }

  public async down(): Promise<void> {
    // Intentionally irreversible: deleted rows referenced prediction-market
    // notification kinds that no longer exist in the TypeScript enum.
  }
}
