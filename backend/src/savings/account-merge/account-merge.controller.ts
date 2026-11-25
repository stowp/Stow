import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { MergeSavingsAccountsDto } from './dto/merge-savings-accounts.dto';
import { AccountMergeService } from './account-merge.service';

@Controller('admin/savings/accounts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class AccountMergeController {
  constructor(private readonly accountMergeService: AccountMergeService) {}

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Merge one savings account into another and archive the source',
  })
  merge(@Body() dto: MergeSavingsAccountsDto) {
    return this.accountMergeService.merge(dto.source_owner, dto.target_owner);
  }
}
