import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { GoalsService } from '../goals/goals.service';
import { BalanceService } from './balance.service';
import { LockedPlansService } from './locked-plans.service';
import { ListGoalsDto } from './dto/list-goals.dto';
import { ListLockedDto } from './dto/list-locked.dto';
import { SavingsListQueryDto } from './dto/pagination.dto';
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
   * GET /savings/goals?address=&page=&limit=&sort=
   *
   * Lists an address's goals with progress (target/current amount, status),
   * paginated. `page`/`limit`/`sort` are validated and capped via
   * `SavingsListQueryDto` — an invalid value (non-integer, `page < 1`,
   * `limit` outside 1-100, or a `sort` other than `asc`/`desc`) is rejected
   * with a 400 rather than silently coerced.
   */
  @Get('goals')
  @Public()
  @UsePipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }),
  )
  @ApiOperation({ summary: "List an address's savings goals with progress" })
  @ApiQuery({ name: 'address', required: true, type: String })
  @ApiResponse({
    status: 200,
    description: "Paginated list of the address's goals",
    type: ListGoalsDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid page, limit, or sort value',
  })
  async listGoals(
    @Query('address') address: string,
    @Query() query: SavingsListQueryDto,
  ): Promise<ListGoalsDto> {
    const {
      data,
      total,
      page: p,
      limit: l,
    } = await this.goalsService.listByOwnerPaginated(
      address,
      query.page,
      query.limit,
      query.sort,
    );
    return { address, goals: data, total, page: p, limit: l };
  }

  /**
   * GET /savings/locked?address=&page=&limit=&sort=
   *
   * Lists an address's locked plans, ordered by `unlock_at` (soonest-
   * unlocking first by default), paginated. `page`/`limit`/`sort` are
   * validated and capped the same way as `listGoals` above.
   */
  @Get('locked')
  @Public()
  @UsePipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false }),
  )
  @ApiOperation({ summary: "List an address's locked savings plans" })
  @ApiQuery({ name: 'address', required: true, type: String })
  @ApiResponse({
    status: 200,
    description:
      "Paginated list of the address's locked plans, ordered by unlock_at",
    type: ListLockedDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid page, limit, or sort value',
  })
  async listLocked(
    @Query('address') address: string,
    @Query() query: SavingsListQueryDto,
  ): Promise<ListLockedDto> {
    const {
      data,
      total,
      page: p,
      limit: l,
    } = await this.lockedPlansService.listByOwner(
      address,
      query.page,
      query.limit,
      query.sort,
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
  @ApiResponse({
    status: 200,
    description: 'Balance and timestamps for the account',
  })
  @ApiResponse({
    status: 404,
    description: 'No account exists for this address',
  })
  async getAccount(@Param('address') address: string) {
    const account = await this.balanceService.findAccount(address);
    if (!account) {
      throw new NotFoundException(
        `No savings account found for address: ${address}`,
      );
    }
    return account;
  }
}
