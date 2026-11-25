import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Request,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ThrottleTier } from '../common/decorators/throttle-tier.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsAggregationService } from './analytics-aggregation.service';
import { BenchmarkService } from './benchmark.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import {
  DashboardKpiDto,
  MetricSummaryDto,
  AnalyticsTrendDto,
} from './dto/dashboard-response.dto';
import {
  BenchmarkDataDto,
  BenchmarkQueryDto,
  RecordBenchmarkSnapshotDto,
} from './dto/benchmark-data.dto';
import { MetricType, AggregationPeriod } from './entities/analytics-metric.entity';

interface AuthenticatedRequest {
  user: {
    id: string;
    stellar_address: string;
  };
}

@ApiTags('analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly aggregationService: AnalyticsAggregationService,
    private readonly benchmarkService: BenchmarkService,
  ) {}

  @Post('benchmark/snapshot')
  @ThrottleTier('write')
  @ApiOperation({ summary: 'Record a savings snapshot used for benchmarking' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Snapshot recorded',
  })
  recordBenchmarkSnapshot(
    @Body() body: RecordBenchmarkSnapshotDto,
    @Request() req: AuthenticatedRequest,
  ) {
    this.benchmarkService.recordSnapshot(req.user.id, body);
    return {
      success: true,
      data: { period: body.period },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('benchmark')
  @ThrottleTier('read')
  @ApiOperation({
    summary: 'Compare savings performance with similar users (anonymized)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Benchmark retrieved successfully',
    type: BenchmarkDataDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No savings data, or not enough peers to compare anonymously',
  })
  getBenchmark(
    @Query() query: BenchmarkQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    return {
      success: true,
      data: this.benchmarkService.getBenchmark(req.user.id, query.period),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('dashboard')
  @ThrottleTier('read')
  @ApiOperation({ summary: 'Get user dashboard KPIs' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Dashboard KPIs retrieved successfully',
    type: DashboardKpiDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthorized - Invalid or missing JWT',
  })
  async getDashboard(@Request() req: AuthenticatedRequest) {
    const data = await this.analyticsService.getDashboardKpis(req.user.id);

    return {
      success: true,
      data,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('metrics')
  @ThrottleTier('read')
  @ApiOperation({ summary: 'Get aggregated metrics' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Metrics retrieved successfully',
    type: [AnalyticsTrendDto],
  })
  async getMetrics(
    @Query() query: AnalyticsQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const metricType = query.metric_type ?? MetricType.USER_ACTIVITY;
    const period = query.period ?? AggregationPeriod.DAILY;
    const startDate = query.start_date
      ? new Date(query.start_date)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Last 30 days
    const endDate = query.end_date ? new Date(query.end_date) : new Date();
    const userId = query.user_id ?? req.user.id;

    const metrics = await this.analyticsService.getMetrics(
      metricType,
      period,
      startDate,
      endDate,
      userId,
    );

    const trends: AnalyticsTrendDto[] = metrics.map((m) => ({
      timestamp: m.period_start,
      value: m.value,
      count: m.count,
    }));

    return {
      success: true,
      data: {
        metric_type: metricType,
        period,
        start_date: startDate.toISOString(),
        end_date: endDate.toISOString(),
        trends,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('summary')
  @ThrottleTier('read')
  @ApiOperation({ summary: 'Get metric summary statistics' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Metric summary retrieved successfully',
    type: MetricSummaryDto,
  })
  async getMetricSummary(
    @Query() query: AnalyticsQueryDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const metricType = query.metric_type ?? MetricType.USER_ACTIVITY;
    const startDate = query.start_date
      ? new Date(query.start_date)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = query.end_date ? new Date(query.end_date) : new Date();
    const userId = query.user_id ?? req.user.id;

    const summary = await this.analyticsService.getMetricSummary(
      metricType,
      startDate,
      endDate,
      userId,
    );

    return {
      success: true,
      data: {
        ...summary,
        period: `${startDate.toISOString()} to ${endDate.toISOString()}`,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('types')
  @ThrottleTier('read')
  @ApiOperation({ summary: 'Get available metric types' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Metric types retrieved successfully',
  })
  getMetricTypes() {
    return {
      success: true,
      data: {
        metric_types: Object.values(MetricType),
        aggregation_periods: Object.values(AggregationPeriod),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
