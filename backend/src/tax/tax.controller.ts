import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ThrottleTier } from '../common/decorators/throttle-tier.decorator';
import {
  TaxAnalysisRequestDto,
  TaxDocumentRequestDto,
  TaxDocumentTemplateDto,
  TaxOptimizationResponseDto,
} from './dto/tax-suggestion.dto';
import { TaxOptimizationService } from './tax-optimization.service';

@ApiTags('tax')
@Controller('tax')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class TaxController {
  constructor(private readonly taxOptimization: TaxOptimizationService) {}

  /** GET /tax/jurisdictions — supported jurisdictions and headline rules. */
  @Get('jurisdictions')
  @ThrottleTier('read')
  @ApiOperation({ summary: 'List supported tax jurisdictions' })
  jurisdictions() {
    return this.taxOptimization.listJurisdictions();
  }

  /**
   * POST /tax/optimize — analyse savings transactions and return a tax
   * estimate on interest, deposit-timing suggestions and (when
   * `plannedWithdrawal` is set) a tax-optimized withdrawal strategy.
   */
  @Post('optimize')
  @HttpCode(200)
  @ThrottleTier('read')
  @ApiOperation({ summary: 'Tax optimization suggestions for savings' })
  @ApiResponse({ status: 200, type: TaxOptimizationResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  optimize(@Body() body: TaxAnalysisRequestDto): TaxOptimizationResponseDto {
    return this.taxOptimization.optimize(body);
  }

  /** POST /tax/documents — a pre-filled tax document template for the year. */
  @Post('documents')
  @HttpCode(200)
  @ThrottleTier('read')
  @ApiOperation({ summary: 'Generate a tax document template for savings interest' })
  @ApiResponse({ status: 200, type: TaxDocumentTemplateDto })
  documents(@Body() body: TaxDocumentRequestDto): TaxDocumentTemplateDto {
    return this.taxOptimization.generateDocument(body);
  }
}
