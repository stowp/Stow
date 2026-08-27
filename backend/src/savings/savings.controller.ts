import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { GoalsService } from '../goals/goals.service';
import { BalanceService } from './balance.service';
import { LockedPlansService } from './locked-plans.service';
import { ListGoalsDto } from './dto/list-goals.dto';
import { ListLockedDto } from './dto/list-locked.dto';
import { SavingsService } from './savings.service';

@ApiTags('savings')
@Controller('savings')
export class SavingsController {
  constructor(
    private readonly savingsService: SavingsService,
    private readonly goalsService: GoalsService,
    private readonly lockedPlansService: LockedPlansService,
    private readonly balanceService: BalanceService,
  ) {}

  /**
   * GET /savings/ping
   *
   * Liveness check for the savings module.
   */
  @Get('ping')
  @Public()
  @ApiOperation({ summary: 'Savings module liveness check' })
  @ApiResponse({ status: 200, description: 'Savings module is up' })
  ping() {
    return this.savingsService.ping();
  }

  /**
   * GET /savings/goals?address=&page=&limit=
   *
   * Lists an address's goals with progress (target/current amount, status),
   * newest-first, paginated.
   */
  @Get('goals')
  @Public()
  @ApiOperation({ summary: "List an address's savings goals with progress" })
  @ApiQuery({ name: 'address', required: true, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: "Paginated list of the address's goals",
    type: ListGoalsDto,
  })
  async listGoals(
    @Query('address') address: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ): Promise<ListGoalsDto> {
    const { data, total, page: p, limit: l } =
      await this.goalsService.listByOwnerPaginated(
        address,
        Number(page),
        Number(limit),
      );
    return { address, goals: data, total, page: p, limit: l };
  }

  /**
   * GET /savings/locked?address=&page=&limit=
   *
   * Lists an address's locked plans, ordered by `unlock_at` ascending
   * (soonest-unlocking first), paginated.
   */
  @Get('locked')
  @Public()
  @ApiOperation({ summary: "List an address's locked savings plans" })
  @ApiQuery({ name: 'address', required: true, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: "Paginated list of the address's locked plans, ordered by unlock_at",
    type: ListLockedDto,
  })
  async listLocked(
    @Query('address') address: string,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ): Promise<ListLockedDto> {
    const { data, total, page: p, limit: l } =
      await this.lockedPlansService.listByOwner(
        address,
        Number(page),
        Number(limit),
      );
    return { address, plans: data, total, page: p, limit: l };
  }

  /**
   * GET /savings/accounts/:address
   *
   * Returns the projected flexible balance for a Stellar account, along
   * with when it was first observed and last updated. 404s if no account
   * has ever been observed for this address (distinct from a zero balance).
   */
  @Get('accounts/:address')
  @Public()
  @ApiOperation({ summary: "Get an address's flexible savings balance" })
  @ApiParam({ name: 'address', description: 'Stellar account address' })
  @ApiResponse({ status: 200, description: 'Balance and timestamps for the account' })
  @ApiResponse({ status: 404, description: 'No account exists for this address' })
  async getAccount(@Param('address') address: string) {
    const account = await this.balanceService.findAccount(address);
    if (!account) {
      throw new NotFoundException(`No savings account found for address: ${address}`);
    }
    return account;
  }
}
