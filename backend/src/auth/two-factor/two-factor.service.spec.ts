import {
  BadRequestException,
  ConflictException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { EmailService } from '../../notifications/email.service';
import { User } from '../../users/entities/user.entity';
import { TwoFactorAuth } from '../entities/two-factor-auth.entity';
import { TwoFactorRecovery } from '../entities/two-factor-recovery.entity';
import { generateTotpForCounter, totpCounterAt } from './totp';
import { TwoFactorService } from './two-factor.service';

const ENCRYPTION_KEY = '11'.repeat(32);

/** Minimal in-memory stand-in for a TypeORM repository. */
function fakeRepo<T extends { id?: string }>() {
  const rows: T[] = [];
  return {
    rows,
    create: jest.fn((entity: Partial<T>) => ({ ...entity }) as T),
    findOneBy: jest.fn((where: Partial<T>) => {
      const found = rows.find((row) =>
        Object.entries(where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        ),
      );
      return Promise.resolve(found ? { ...found } : null);
    }),
    save: jest.fn((entity: T) => {
      const index = rows.findIndex((row) => row.id && row.id === entity.id);
      const stored = { id: entity.id ?? `id-${rows.length + 1}`, ...entity };
      if (index === -1) {
        rows.push(stored as T);
      } else {
        rows[index] = stored as T;
      }
      return Promise.resolve({ ...stored });
    }),
    delete: jest.fn((where: Partial<T>) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (
          Object.entries(where).every(
            ([key, value]) =>
              (rows[i] as Record<string, unknown>)[key] === value,
          )
        ) {
          rows.splice(i, 1);
        }
      }
      return Promise.resolve();
    }),
  };
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('TwoFactorService', () => {
  let service: TwoFactorService;
  let twoFactorRepo: ReturnType<typeof fakeRepo<TwoFactorAuth>>;
  let recoveryRepo: ReturnType<typeof fakeRepo<TwoFactorRecovery>>;
  let usersRepo: { findOneBy: jest.Mock };
  let emailService: { queueEmail: jest.Mock };

  const user = Object.assign(new User(), {
    id: 'user-1',
    stellar_address: 'GABC',
    email: 'user@example.com',
  });

  beforeEach(async () => {
    twoFactorRepo = fakeRepo<TwoFactorAuth>();
    recoveryRepo = fakeRepo<TwoFactorRecovery>();
    usersRepo = { findOneBy: jest.fn(() => Promise.resolve(user)) };
    emailService = {
      queueEmail: jest.fn().mockResolvedValue({ queued: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwoFactorService,
        { provide: getRepositoryToken(TwoFactorAuth), useValue: twoFactorRepo },
        {
          provide: getRepositoryToken(TwoFactorRecovery),
          useValue: recoveryRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'TWO_FACTOR_ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
            ),
          },
        },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    service = module.get(TwoFactorService);
  });

  const currentCode = (secret: string) =>
    generateTotpForCounter(secret, totpCounterAt(Date.now()));

  async function setupAndEnable() {
    const setup = await service.setup(user);
    const result = await service.enable(user, currentCode(setup.secret));
    return { secret: setup.secret, backupCodes: result.backup_codes };
  }

  it('stores the secret encrypted and returns an otpauth URI and QR code', async () => {
    const result = await service.setup(user);

    const stored = twoFactorRepo.rows[0];
    expect(stored.secret).not.toContain(result.secret);
    expect(stored.isEnabled).toBe(false);
    expect(result.otpauth_url).toContain(`secret=${result.secret}`);
    expect(result.qr_code_data_url).toMatch(/^data:image\/png;base64,/);
  });

  it('enables 2FA with a valid code and returns backup codes stored only as hashes', async () => {
    const setup = await service.setup(user);
    const { backup_codes } = await service.enable(
      user,
      currentCode(setup.secret),
    );

    expect(backup_codes).toHaveLength(8);
    expect(await service.isEnabledFor(user.id)).toBe(true);
    const stored = twoFactorRepo.rows[0];
    for (const code of backup_codes) {
      expect(stored.backupCodes).not.toContain(code);
    }
  });

  it('rejects enabling with a wrong code and refuses setup once enabled', async () => {
    const setup = await service.setup(user);
    await expect(service.enable(user, '000000')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    await setupAndEnableFrom(setup.secret);
    await expect(service.setup(user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts a TOTP code once, then rejects a replay of it', async () => {
    const { secret } = await setupAndEnable();
    // Enabling consumed the current step, so log in with the next step's code.
    const code = generateTotpForCounter(secret, totpCounterAt(Date.now()) + 1);

    expect(await service.verifyLoginCode(user.id, code)).toBe(true);
    expect(await service.verifyLoginCode(user.id, code)).toBe(false);
  });

  it('accepts a backup code once', async () => {
    const { backupCodes } = await setupAndEnable();

    expect(await service.verifyLoginCode(user.id, backupCodes[0])).toBe(true);
    expect(await service.verifyLoginCode(user.id, backupCodes[0])).toBe(false);
    expect(await service.verifyLoginCode(user.id, backupCodes[1])).toBe(true);
  });

  it('locks login after repeated failures', async () => {
    await setupAndEnable();

    for (let i = 0; i < 5; i++) {
      expect(await service.verifyLoginCode(user.id, '000000')).toBe(false);
    }
    await expect(
      service.verifyLoginCode(user.id, '000000'),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('emails a reset token and disables 2FA when the token is confirmed', async () => {
    await setupAndEnable();

    await service.requestReset(user.email);
    expect(emailService.queueEmail).toHaveBeenCalledTimes(1);
    const sent = emailService.queueEmail.mock.calls[0][0] as { text: string };
    const token = sent.text.match(/: (\S+)\n/)?.[1] ?? '';
    expect(recoveryRepo.rows[0].recoveryToken).toBe(sha256(token));

    await service.confirmReset(token);
    expect(await service.isEnabledFor(user.id)).toBe(false);
    await expect(service.confirmReset(token)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('does not send a reset email for unknown addresses', async () => {
    usersRepo.findOneBy.mockResolvedValueOnce(null);
    await service.requestReset('nobody@example.com');
    expect(emailService.queueEmail).not.toHaveBeenCalled();
  });

  // Helper: enable using a secret that setup already produced.
  async function setupAndEnableFrom(secret: string) {
    await service.enable(user, currentCode(secret));
  }
});
