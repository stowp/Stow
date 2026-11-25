import { Module } from '@nestjs/common';
import { TaxController } from './tax.controller';
import { TaxOptimizationService } from './tax-optimization.service';

@Module({
  controllers: [TaxController],
  providers: [TaxOptimizationService],
  exports: [TaxOptimizationService],
})
export class TaxModule {}
