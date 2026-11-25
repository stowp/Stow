import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { UserReferral } from '../users/entities/user-referral.entity';
import { ReferralReward } from '../users/entities/referral-reward.entity';
import { TieredReferralReward } from './entities/tiered-referral-reward.entity';
import { EnhancedReferralService } from './enhanced-referral.service';
import { EnhancedReferralController, AdminReferralController } from './enhanced-referral.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserReferral, ReferralReward, TieredReferralReward]),
    forwardRef(() => UsersModule),
  ],
  controllers: [EnhancedReferralController, AdminReferralController],
  providers: [EnhancedReferralService],
  exports: [EnhancedReferralService],
})
export class ReferralModule {}