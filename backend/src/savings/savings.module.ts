import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GoalsModule } from '../goals/goals.module';
import { AnchorController } from './anchor.controller';
import { AnchorService } from './anchor.service';
import { AnchorDeposit } from './entities/anchor-deposit.entity';
import { Balance } from './entities/balance.entity';
import { Group } from './entities/group.entity';
import { BalanceService } from './balance.service';
import { GroupsService } from './groups.service';
import { BalanceController } from './balance.controller';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { SavingsController } from './savings.controller';
import { SavingsService } from './savings.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AnchorDeposit, Balance, Group]),
    CacheModule.register({ ttl: 10_000 }),
    GoalsModule,
    WebhooksModule,
  ],
  controllers: [AnchorController, BalanceController, SavingsController],
  providers: [AnchorService, BalanceService, GroupsService, SavingsService],
  exports: [AnchorService, BalanceService, GroupsService, SavingsService],
})
export class SavingsModule {}
