import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { EnhancedReferralService, LeaderboardEntry, ReferralAnalytics } from './enhanced-referral.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

@ApiTags('referral')
@Controller('referral')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class EnhancedReferralController {
  constructor(private readonly enhancedReferralService: EnhancedReferralService) {}

  @Get('analytics')
  @ApiOperation({ summary: 'Get my referral analytics including tier info and leaderboard rank' })
  async getMyAnalytics(@Request() req): Promise<ReferralAnalytics> {
    return this.enhancedReferralService.getUserAnalytics(req.user.id);
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Get referral leaderboard' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getLeaderboard(@Query() query: PaginationQueryDto): Promise<{ data: LeaderboardEntry[]; meta: any }> {
    return this.enhancedReferralService.getLeaderboard(query);
  }
}

@ApiTags('admin/referral')
@Controller('admin/referral')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminReferralController {
  constructor(private readonly enhancedReferralService: EnhancedReferralService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Admin: Get referral analytics dashboard' })
  async getAdminDashboard() {
    return this.enhancedReferralService.getAdminReferralDashboard();
  }

  @Get('leaderboard')
  @ApiOperation({ summary: 'Admin: Get full referral leaderboard' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async adminGetLeaderboard(@Query() query: PaginationQueryDto) {
    return this.enhancedReferralService.getLeaderboard(query);
  }
}