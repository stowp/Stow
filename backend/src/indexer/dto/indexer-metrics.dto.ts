import { ApiProperty } from '@nestjs/swagger';

/** Runtime metrics maintained by the indexer process. */
export class IndexerMetricsDto {
  @ApiProperty()
  eventsProcessed: number;

  @ApiProperty()
  depositsProcessed: number;

  @ApiProperty()
  withdrawalsProcessed: number;

  @ApiProperty()
  eventsPerMinute: number;

  @ApiProperty()
  lastProcessedAt: string;

  @ApiProperty()
  uptimeSeconds: number;
}
