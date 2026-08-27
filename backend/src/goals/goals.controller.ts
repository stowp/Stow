import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { GoalsService } from './goals.service';

@Controller('goals')
export class GoalsController {
  constructor(private readonly goalsService: GoalsService) {}

  /** GET /goals?owner=G... — list goals, optionally filtered by owner. */
  @Get()
  list(@Query('owner') owner?: string) {
    return this.goalsService.list(owner);
  }

  /** GET /goals/summary?owner=G... — aggregate totals across goals. */
  @Get('summary')
  summary(@Query('owner') owner?: string) {
    return this.goalsService.summary(owner);
  }

  /** GET /goals/:id — fetch a single goal by its on-chain id. */
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.goalsService.getByOnChainId(id);
  }

  /**
   * POST /goals/:id/claim — record a reached goal as claimed, after the
   * owner's goal_claim transaction has confirmed on-chain.
   */
  @Post(':id/claim')
  claim(@Param('id') id: string) {
    return this.goalsService.claim(id);
  }
}
