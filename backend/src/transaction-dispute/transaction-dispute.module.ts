import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionDispute } from './entities/transaction-dispute.entity';
import { TransactionDisputeService } from './transaction-dispute.service';
import { TransactionDisputeController, AdminDisputeController } from './transaction-dispute.controller';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TransactionDispute]),
    forwardRef(() => UsersModule),
    forwardRef(() => NotificationsModule),
  ],
  controllers: [TransactionDisputeController, AdminDisputeController],
  providers: [TransactionDisputeService],
  exports: [TransactionDisputeService],
})
export class TransactionDisputeModule {}