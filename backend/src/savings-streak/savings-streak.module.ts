import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavingsStreak, SavingsBadge } from './entities/savings-streak.entity';
import { SavingsStreakService } from './savings-streak.service';
import { SavingsStreakController, AdminStreakController } from './savings-streak.controller';
import { UsersModule } from '../users/users.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SavingsStreak, SavingsBadge]),
    forwardRef(() => UsersModule),
    forwardRef(() => NotificationsModule),
  ],
  controllers: [SavingsStreakController, AdminStreakController],
  providers: [SavingsStreakService],
  exports: [SavingsStreakService],
})
export class SavingsStreakModule {}