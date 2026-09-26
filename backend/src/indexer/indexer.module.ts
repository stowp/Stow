import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CacheModule } from '@nestjs/cache-manager';
import { ContractEvent } from './entities/contract-event.entity';
import { FeeHistory } from './entities/fee-history.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { ChainSyncCheckpoint } from './entities/chain-sync-checkpoint.entity';
import { ReorgEvent } from './entities/reorg-event.entity';
import { PendingWithdrawal } from './entities/pending-withdrawal.entity';
import { HarvestHistory } from './entities/harvest-history.entity';
import { IndexerService } from './indexer.service';
import { IndexerController } from './indexer.controller';
import { IndexerHealthController } from './indexer-health.controller';
import { IndexerHealthService } from './health.service';
import { ReconciliationService } from './reconciliation.service';
import { SavingsProjectionModule } from '../savings-projection/savings-projection.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ContractEvent,
      FeeHistory,
      IndexerCheckpoint,
      ChainSyncCheckpoint,
      ReorgEvent,
      PendingWithdrawal,
      HarvestHistory,
    ]),
    CacheModule.register(),
    SavingsProjectionModule,
  ],
  controllers: [IndexerController, IndexerHealthController],
  providers: [IndexerService, IndexerHealthService, ReconciliationService],
  exports: [IndexerService, IndexerHealthService, ReconciliationService],
})
export class IndexerModule {}
