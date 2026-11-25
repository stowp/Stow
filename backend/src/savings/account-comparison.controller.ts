import { Controller, Get, Post, Param, Query, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
import { AccountComparisonService } from './account-comparison.service';
import { AccountComparisonQueryDto, ProjectEarningsDto, AccountComparisonResponseDto } from './dto/account-comparison.dto';

@ApiTags('account-comparison')
@Controller('account-comparison')
export class AccountComparisonController {
  constructor(private readonly accountComparisonService: AccountComparisonService) {}

  @Get()
  @ApiOperation({ summary: 'Get all account types with optional filters' })
  @ApiQuery({ name: 'min_apy', required: false, type: Number })
  @ApiQuery({ name: 'max_lock_period', required: false, type: Number })
  @ApiQuery({ name: 'allows_withdrawal', required: false, type: Boolean })
  @ApiQuery({ name: 'features', required: false, isArray: true })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getAccountTypes(@Query() query: AccountComparisonQueryDto) {
    return this.accountComparisonService.getAccountTypes(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get account type by ID' })
  async getAccountTypeById(@Param('id', ParseUUIDPipe) id: string) {
    return this.accountComparisonService.getAccountTypeById(id);
  }

  @Post('project-earnings')
  @ApiOperation({ summary: 'Calculate projected earnings for an account type' })
  @ApiBody({ type: ProjectEarningsDto })
  async projectEarnings(@Body() dto: ProjectEarningsDto) {
    return this.accountComparisonService.projectEarnings(dto);
  }

  @Post('seed')
  @ApiOperation({ summary: 'Seed default account types (admin)' })
  async seedDefaultAccountTypes() {
    await this.accountComparisonService.seedDefaultAccountTypes();
    return { message: 'Default account types seeded successfully' };
  }
}