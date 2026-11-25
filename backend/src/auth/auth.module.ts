import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { UserPreferences } from '../users/entities/user-preferences.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RateLimitService } from './rate-limit.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { ApiKey } from './entities/api-key.entity';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';
import { RefreshToken } from './entities/refresh-token.entity';
import { AuthAuditEvent } from './entities/auth-audit-event.entity';
import { WebAuthnCredential } from './entities/webauthn-credential.entity';
import { OAuthIdentity } from './entities/oauth-identity.entity';
import { OAuthTransaction } from './entities/oauth-transaction.entity';
import { OAuthService } from './oauth.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { TwoFactorAuth } from './entities/two-factor-auth.entity';
import { TwoFactorRecovery } from './entities/two-factor-recovery.entity';
import { TwoFactorService } from './two-factor/two-factor.service';
import { TwoFactorController } from './two-factor/two-factor.controller';

@Module({
  imports: [
    PassportModule,
    ConfigModule,
    NotificationsModule,
    TypeOrmModule.forFeature([
      User,
      ApiKey,
      UserPreferences,
      RefreshToken,
      AuthAuditEvent,
      WebAuthnCredential,
      OAuthIdentity,
      OAuthTransaction,
      TwoFactorAuth,
      TwoFactorRecovery,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET')!,
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN') as never,
        },
      }),
    }),
  ],
  controllers: [AuthController, ApiKeyController, TwoFactorController],
  providers: [
    AuthService,
    ApiKeyService,
    JwtStrategy,
    RateLimitService,
    OAuthService,
    TwoFactorService,
  ],
  exports: [
    AuthService,
    ApiKeyService,
    JwtModule,
    OAuthService,
    TwoFactorService,
  ],
})
export class AuthModule {}
