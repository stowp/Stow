import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import * as QRCode from 'qrcode';
import { Repository } from 'typeorm';
import { EmailService } from '../../notifications/email.service';
import { User } from '../../users/entities/user.entity';
import { TwoFactorAuth } from '../entities/two-factor-auth.entity';
import { TwoFactorRecovery } from '../entities/two-factor-recovery.entity';
import {
  buildOtpauthUrl,
  generateTotpSecret,
  matchTotpCounter,
  TOTP_STEP_SECONDS,
} from './totp';

const ISSUER = 'Stow';
const BACKUP_CODE_COUNT = 8;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 15;

export interface TwoFactorSetupResult {
  secret: string;
  otpauth_url: string;
  qr_code_data_url: string;
}

@Injectable()
export class TwoFactorService {
  constructor(
    @InjectRepository(TwoFactorAuth)
    private readonly twoFactorRepository: Repository<TwoFactorAuth>,
    @InjectRepository(TwoFactorRecovery)
    private readonly recoveryRepository: Repository<TwoFactorRecovery>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  /** Whether login for `userId` must present a second factor. */
  async isEnabledFor(userId: string): Promise<boolean> {
    const row = await this.twoFactorRepository.findOneBy({
      userId,
      isEnabled: true,
    });
    return row !== null;
  }

  /**
   * Starts 2FA setup. Stores a new encrypted secret (not yet active) and
   * returns it with an otpauth URI and a QR code image for the app to scan.
   */
  async setup(user: User): Promise<TwoFactorSetupResult> {
    const existing = await this.twoFactorRepository.findOneBy({
      userId: user.id,
    });
    if (existing?.isEnabled) {
      throw new ConflictException(
        'Two-factor authentication is already enabled',
      );
    }

    const secret = generateTotpSecret();
    const row =
      existing ?? this.twoFactorRepository.create({ userId: user.id });
    row.secret = this.encrypt(secret);
    row.isEnabled = false;
    row.isVerified = false;
    row.backupCodes = null;
    row.lastUsedAt = null;
    row.failedAttempts = 0;
    row.lockedUntil = null;
    await this.twoFactorRepository.save(row);

    const otpauthUrl = buildOtpauthUrl(
      ISSUER,
      user.email ?? user.stellar_address,
      secret,
    );
    return {
      secret,
      otpauth_url: otpauthUrl,
      qr_code_data_url: await QRCode.toDataURL(otpauthUrl),
    };
  }

  /**
   * Activates 2FA after the user proves they can produce a valid code.
   * Returns the backup codes; they are shown once and only hashes are kept.
   */
  async enable(user: User, code: string): Promise<{ backup_codes: string[] }> {
    const row = await this.twoFactorRepository.findOneBy({ userId: user.id });
    if (!row?.secret) {
      throw new BadRequestException('Two-factor setup has not been started');
    }
    if (row.isEnabled) {
      throw new ConflictException(
        'Two-factor authentication is already enabled',
      );
    }

    const counter = matchTotpCounter(this.decrypt(row.secret), code);
    if (counter === null) {
      throw new UnauthorizedException('Invalid two-factor code');
    }

    const backupCodes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
      formatBackupCode(randomBytes(5).toString('hex')),
    );
    row.isEnabled = true;
    row.isVerified = true;
    row.backupCodes = backupCodes.map((c) => this.hash(normalizeBackupCode(c)));
    row.lastUsedAt = counterToDate(counter);
    row.failedAttempts = 0;
    row.lockedUntil = null;
    await this.twoFactorRepository.save(row);

    return { backup_codes: backupCodes };
  }

  /**
   * Checks a login code for a user with 2FA enabled. Accepts the current
   * TOTP code (each counter only once) or an unused backup code.
   * Returns false for a wrong code and throws while the account is locked.
   */
  async verifyLoginCode(userId: string, code: string): Promise<boolean> {
    const row = await this.twoFactorRepository.findOneBy({
      userId,
      isEnabled: true,
    });
    if (!row?.secret) {
      return false;
    }
    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
      throw new HttpException(
        'Too many failed two-factor attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const counter = matchTotpCounter(this.decrypt(row.secret), code.trim());
    const lastCounter = row.lastUsedAt
      ? Math.floor(row.lastUsedAt.getTime() / 1000 / TOTP_STEP_SECONDS)
      : -1;
    if (counter !== null && counter > lastCounter) {
      row.lastUsedAt = counterToDate(counter);
      return this.recordSuccess(row);
    }

    const backupIndex =
      row.backupCodes?.indexOf(this.hash(normalizeBackupCode(code))) ?? -1;
    if (backupIndex !== -1) {
      row.backupCodes = (row.backupCodes ?? []).filter(
        (_, i) => i !== backupIndex,
      );
      return this.recordSuccess(row);
    }

    row.failedAttempts += 1;
    if (row.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      row.failedAttempts = 0;
      row.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
    }
    await this.twoFactorRepository.save(row);
    return false;
  }

  /**
   * Starts 2FA reset: emails a single-use token to the account's address.
   * Always resolves the same way so callers cannot learn which emails exist.
   */
  async requestReset(email: string): Promise<void> {
    const user = await this.usersRepository.findOneBy({ email: email.trim() });
    if (!user || !(await this.isEnabledFor(user.id))) {
      return;
    }

    const token = randomBytes(32).toString('base64url');
    await this.recoveryRepository.save(
      this.recoveryRepository.create({
        userId: user.id,
        recoveryToken: this.hash(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
        isUsed: false,
      }),
    );

    await this.emailService.queueEmail({
      to: user.email!,
      subject: 'Reset your two-factor authentication',
      text: `Use this code to reset two-factor authentication: ${token}\nIt expires in ${RESET_TOKEN_TTL_MINUTES} minutes. If you did not ask for this, ignore this email.`,
      html: `<p>Use this code to reset two-factor authentication:</p><p><code>${token}</code></p><p>It expires in ${RESET_TOKEN_TTL_MINUTES} minutes. If you did not ask for this, ignore this email.</p>`,
    });
  }

  /** Completes a reset: consumes the emailed token and removes 2FA. */
  async confirmReset(token: string): Promise<void> {
    const record = await this.recoveryRepository.findOneBy({
      recoveryToken: this.hash(token),
      isUsed: false,
    });
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    record.isUsed = true;
    record.usedAt = new Date();
    await this.recoveryRepository.save(record);
    await this.twoFactorRepository.delete({ userId: record.userId });
  }

  private async recordSuccess(row: TwoFactorAuth): Promise<boolean> {
    row.failedAttempts = 0;
    row.lockedUntil = null;
    await this.twoFactorRepository.save(row);
    return true;
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private encryptionKey(): Buffer {
    const raw = this.configService.get<string>('TWO_FACTOR_ENCRYPTION_KEY');
    if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new InternalServerErrorException(
        'TWO_FACTOR_ENCRYPTION_KEY must be 64 hex characters (32 bytes)',
      );
    }
    return Buffer.from(raw, 'hex');
  }

  /** AES-256-GCM. Output is `iv:tag:ciphertext` in hex. */
  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), encrypted]
      .map((part) => part.toString('hex'))
      .join(':');
  }

  private decrypt(payload: string): string {
    const [ivHex, tagHex, dataHex] = payload.split(':');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }
}

function counterToDate(counter: number): Date {
  return new Date(counter * TOTP_STEP_SECONDS * 1000);
}

/** Formats 10 hex characters as `xxxxx-xxxxx` for readability. */
function formatBackupCode(hex: string): string {
  return `${hex.slice(0, 5)}-${hex.slice(5)}`;
}

function normalizeBackupCode(code: string): string {
  return code.toLowerCase().replace(/[^0-9a-f]/g, '');
}
