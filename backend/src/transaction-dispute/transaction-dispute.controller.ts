import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Body,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiBody } from '@nestjs/swagger';
import { TransactionDisputeService } from './transaction-dispute.service';
import { CreateDisputeDto, UpdateDisputeStatusDto, DisputeQueryDto } from './dto/transaction-dispute.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('disputes')
@Controller('disputes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class TransactionDisputeController {
  constructor(private readonly disputeService: TransactionDisputeService) {}

  @Post()
  @ApiOperation({ summary: 'File a new transaction dispute' })
  @ApiBody({ type: CreateDisputeDto })
  async createDispute(@Request() req, @Body() dto: CreateDisputeDto) {
    return this.disputeService.createDispute(req.user.id, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'Get my disputes' })
  async getMyDisputes(@Request() req, @Query() query: DisputeQueryDto) {
    return this.disputeService.getMyDisputes(req.user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get dispute by ID' })
  async getDispute(@Param('id', ParseUUIDPipe) id: string, @Request() req) {
    return this.disputeService.getDisputeById(id, req.user.id);
  }
}

@ApiTags('admin/disputes')
@Controller('admin/disputes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminDisputeController {
  constructor(private readonly disputeService: TransactionDisputeService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: List all disputes' })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'investigating', 'resolved', 'rejected'] })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async adminListDisputes(@Query() query: DisputeQueryDto) {
    return this.disputeService.adminListDisputes(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Admin: Get dispute statistics' })
  async getDisputeStats() {
    return this.disputeService.getDisputeStats();
  }

  @Put(':id')
  @ApiOperation({ summary: 'Admin: Update dispute status' })
  @ApiBody({ type: UpdateDisputeStatusDto })
  async adminUpdateDispute(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req,
    @Body() dto: UpdateDisputeStatusDto,
  ) {
    return this.disputeService.adminUpdateDispute(id, req.user.id, dto);
  }
}