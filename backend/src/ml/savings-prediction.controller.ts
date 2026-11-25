import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ThrottleTier } from '../common/decorators/throttle-tier.decorator';
import {
  GoalRecommendation,
  SavingsPrediction,
  SavingsPredictionService,
  UserFitSummary,
} from './savings-prediction.service';
import {
  DepositRecordDto,
  GoalRecommendationDto,
  SavingsPredictionQueryDto,
  TrainSavingsPredictionDto,
} from './dto/savings-prediction.dto';

interface AuthenticatedRequest {
  user: { id: string };
}

@ApiTags('ml')
@Controller('ml/savings-predictions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SavingsPredictionController {
  constructor(private readonly predictions: SavingsPredictionService) {}

  @Post('history')
  @ThrottleTier('write')
  @ApiOperation({ summary: "Train the caller's prediction model on their deposit history" })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Model trained' })
  train(
    @Request() req: AuthenticatedRequest,
    @Body() body: TrainSavingsPredictionDto,
  ): UserFitSummary {
    return this.predictions.train(req.user.id, body.deposits, body.asOf);
  }

  @Post('deposits')
  @ThrottleTier('write')
  @ApiOperation({ summary: 'Add a new deposit and refresh predictions' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Model updated' })
  addDeposit(
    @Request() req: AuthenticatedRequest,
    @Body() body: DepositRecordDto,
  ): UserFitSummary {
    return this.predictions.addDeposit(req.user.id, body);
  }

  @Get()
  @ApiOperation({ summary: 'Predict future deposits with confidence intervals' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Prediction' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'No deposit history yet' })
  predict(
    @Request() req: AuthenticatedRequest,
    @Query() query: SavingsPredictionQueryDto,
  ): SavingsPrediction {
    return this.predictions.predict(req.user.id, query);
  }

  @Post('recommendations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Personalized goal recommendation sized to the caller' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Recommendation' })
  recommend(
    @Request() req: AuthenticatedRequest,
    @Body() body: GoalRecommendationDto,
  ): GoalRecommendation {
    return this.predictions.recommendGoal(req.user.id, body);
  }
}
