import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { validate } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { IndexerModule } from './indexer/indexer.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SorobanModule } from './soroban/soroban.module';
import { UsersModule } from './users/users.module';
import { ContractModule } from './contract/contract.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AccountModule } from './account/account.module';
import { SavingsModule } from './savings/savings.module';
import { AccountMergeModule } from './savings/account-merge/account-merge.module';
import { AuditModule } from './audit/audit.module';
import { ActivityModule } from './activity/activity.module';
import { NftRewardsModule } from './nft-rewards/nft-rewards.module';
import { InterestRatesModule } from './interest-rates/interest-rates.module';
import { RoundupModule } from './savings-roundup/roundup.module';
import { TieredThrottlerGuard } from './common/guards/tiered-throttler.guard';
import { BackupModule } from './backup/backup.module';
import { AnchorModule } from './anchor/anchor.module';
import { CsvImportModule } from './csv-import/csv-import.module';
import { GraphqlApiModule } from './graphql/graphql.module';
import { CacheModule } from './cache/cache.module';
import { MetricsModule } from './metrics/metrics.module';
import { FeesModule } from './fees/fees.module';
import { TaxModule } from './tax/tax.module';
import { MlModule } from './ml/ml.module';
import { TransactionDisputeModule } from './transaction-dispute/transaction-dispute.module';
import { SavingsStreakModule } from './savings-streak/savings-streak.module';
import { ReferralModule } from './referral/referral.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
      envFilePath: '.env',
    }),

    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            name: 'default',
            ttl:
              configService.get<number>('RATE_LIMIT_DEFAULT_TTL_MS') ?? 60_000,
            limit: configService.get<number>('RATE_LIMIT_DEFAULT_LIMIT') ?? 100,
          },
          {
            name: 'auth',
            ttl: configService.get<number>('RATE_LIMIT_AUTH_TTL_MS') ?? 60_000,
            limit: configService.get<number>('RATE_LIMIT_AUTH_LIMIT') ?? 10,
          },
          {
            name: 'read',
            ttl: configService.get<number>('RATE_LIMIT_READ_TTL_MS') ?? 60_000,
            limit: configService.get<number>('RATE_LIMIT_READ_LIMIT') ?? 200,
          },
          {
            name: 'write',
            ttl: configService.get<number>('RATE_LIMIT_WRITE_TTL_MS') ?? 60_000,
            limit: configService.get<number>('RATE_LIMIT_WRITE_LIMIT') ?? 30,
          },
          {
            name: 'partner',
            ttl:
              configService.get<number>('PARTNER_ROUNDUP_THROTTLE_TTL_MS') ??
              60_000,
            limit:
              configService.get<number>('PARTNER_ROUNDUP_THROTTLE_LIMIT') ??
              60,
          },
        ],
        setHeaders: true,
      }),
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV !== 'production' ? 'debug' : 'info',
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty' }
            : undefined,
        autoLogging: true,
      },
    }),
    ScheduleModule.forRoot(),

    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.get<string>('DATABASE_URL'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        migrations: [__dirname + '/migrations/*{.ts,.js}'],
        synchronize: false,
        logging: process.env.NODE_ENV === 'development',
        autoLoadEntities: true,
      }),
    }),

    CacheModule,
    MetricsModule,
    FeesModule,
    TaxModule,
    MlModule,
    HealthModule,
    AuthModule,
    UsersModule,
    NotificationsModule,
    SorobanModule,
    AdminModule,
    CommonModule,
    IndexerModule,
    ContractModule,
    WebhooksModule,
    AccountModule,
    SavingsModule,
    AccountMergeModule,
    ActivityModule,
    AuditModule,
    BackupModule,
    AnchorModule,
    CsvImportModule,
    GraphqlApiModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
    }),
    ReferralModule,
    TransactionDisputeModule,
    SavingsStreakModule,
  ],

  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: TieredThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
