import { Module } from '@nestjs/common';
import { FraudDetectionService } from './fraud-detection.service';
import { SavingsPredictionController } from './savings-prediction.controller';
import { SavingsPredictionService } from './savings-prediction.service';

@Module({
  controllers: [SavingsPredictionController],
  providers: [FraudDetectionService, SavingsPredictionService],
  exports: [FraudDetectionService, SavingsPredictionService],
})
export class MlModule {}
