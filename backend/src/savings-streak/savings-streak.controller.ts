import { Controller, Get, Post, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { SavingsStreakService, StreakStats, StreakLeaderboardEntry } from './savings-streak.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('streaks')
@Controller('streaks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class SavingsStreakController {
  constructor(private readonly streakService: SavingsStreakService) {}

  @Get()
  @ApiOperation({ summary: 'Get my streak statistics and badges' })
  async getMyStreaks(@Request() req): Promise<StreakStats> {
    return this.streakService.getStreakStats(req.user.id);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Get streak leaderboard' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getLeaderboard(@Query('limit') limit?: number): Promise<StreakLeaderboardEntry[]> {
    return this.streakService.getStreakLeaderboard(limit || 20);
  }
}

@ApiTags('admin/streaks')
@Controller('admin/streaks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminStreakController {
  constructor(private readonly streakService: SavingsStreakService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Admin: Get streak statistics overview' })
  async getStatsOverview() {
    return this.streakService.getStreakStatsOverview();
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Admin: Get full streak leaderboard' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async adminGetLeaderboard(@Query('limit') limit?: number) {
    return this.streakService.getStreakLeaderboard(limit || 50);
  }
}