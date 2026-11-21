import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { JwtModule } from '@nestjs/jwt';

import { PartnerTransaction } from './entities/partner-transaction.entity';
import { RoundupApiService } from './roundup-api.service';
import { RoundupApiController } from './roundup-api.controller';
import { PartnerThrottlerGuard } from './guards/partner-throttler.guard';

// Re-use existing modules
import { RoundupModule } from '../savings-roundup/roundup.module';
import { SavingsModule } from '../savings/savings.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PartnerTransaction]),
    HttpModule,
    // JwtModule is needed by PartnerThrottlerGuard's constructor chain
    // (it extends the base ThrottlerGuard which the DI graph resolves).
    JwtModule,
    RoundupModule,
    SavingsModule,
    AuthModule,
  ],
  controllers: [RoundupApiController],
  providers: [RoundupApiService, PartnerThrottlerGuard],
  exports: [RoundupApiService],
})
export class PartnersModule {}
