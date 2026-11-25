/**
 * Two-factor authentication – integration test (issue #621)
 *
 * Runs the real TwoFactorController, TwoFactorService and AuthService wallet
 * login together over HTTP and in-process, with in-memory repositories and
 * real Stellar signatures, TOTP codes and QR codes.
 */

import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Keypair } from '@stellar/stellar-sdk';
import type { NextFunction, Request, Response } from 'express';
import * as QRCode from 'qrcode';
import request from 'supertest';
import { AuthService } from '../../src/auth/auth.service';
import { AuthAuditEvent } from '../../src/auth/entities/auth-audit-event.entity';
import { RefreshToken } from '../../src/auth/entities/refresh-token.entity';
import { TwoFactorAuth } from '../../src/auth/entities/two-factor-auth.entity';
import { TwoFactorRecovery } from '../../src/auth/entities/two-factor-recovery.entity';
import { WebAuthnCredential } from '../../src/auth/entities/webauthn-credential.entity';
import {
  base32Decode,
  generateTotpForCounter,
  totpCounterAt,
} from '../../src/auth/two-factor/totp';
import { TwoFactorController } from '../../src/auth/two-factor/two-factor.controller';
import { TwoFactorService } from '../../src/auth/two-factor/two-factor.service';
import { EmailService } from '../../src/notifications/email.service';
import { UserPreferences } from '../../src/users/entities/user-preferences.entity';
import { User } from '../../src/users/entities/user.entity';

const ENCRYPTION_KEY = 'ab'.repeat(32);

type Row = Record<string, unknown>;

/** In-memory stand-in for the TypeORM repository methods these services use. */
function memoryRepo<T extends object>() {
  const rows: T[] = [];
  let nextId = 1;
  const matches = (row: T, where: Partial<T>) =>
    Object.entries(where).every(([key, value]) => (row as Row)[key] === value);
  return {
    rows,
    create: (data: Partial<T>) => ({ ...data }) as T,
    findOneBy: async (where: Partial<T>) => {
      const found = rows.find((row) => matches(row, where));
      return found ? ({ ...found } as T) : null;
    },
    save: async (entity: T) => {
      const record = entity as Row;
      record.id ??= `id-${nextId++}`;
      const index = rows.findIndex((row) => (row as Row).id === record.id);
      if (index === -1) rows.push({ ...entity });
      else rows[index] = { ...entity };
      return { ...entity };
    },
    delete: async (where: Partial<T>) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
    },
  };
}

describe('Two-factor authentication (integration)', () => {
  let app: INestApplication;
  let auth: AuthService;
  let users: ReturnType<typeof memoryRepo<User>>;
  let twoFactorRows: ReturnType<typeof memoryRepo<TwoFactorAuth>>;
  let recoveryRows: ReturnType<typeof memoryRepo<TwoFactorRecovery>>;
  let email: { queueEmail: jest.Mock };
  let wallet: Keypair;
  let user: User;

  /** Signs in with the wallet, optionally passing a 2FA code. */
  const walletLogin = (code?: string) => {
    const challenge = auth.generateChallenge(wallet.publicKey());
    const signature = wallet
      .sign(Buffer.from(challenge, 'utf-8'))
      .toString('hex');
    return auth.verifyChallenge(wallet.publicKey(), signature, code);
  };

  const codeAt = (secret: string, stepOffset = 0) =>
    generateTotpForCounter(secret, totpCounterAt(Date.now()) + stepOffset);

  /** Runs setup + enable over HTTP and returns the secret and backup codes. */
  async function enableTwoFactor() {
    const setup = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .expect(200);
    const enable = await request(app.getHttpServer())
      .post('/auth/2fa/enable')
      .send({ code: codeAt(setup.body.secret) })
      .expect(200);
    return {
      setup: setup.body as {
        secret: string;
        otpauth_url: string;
        qr_code_data_url: string;
      },
      backupCodes: enable.body.backup_codes as string[],
    };
  }

  beforeEach(async () => {
    users = memoryRepo<User>();
    twoFactorRows = memoryRepo<TwoFactorAuth>();
    recoveryRows = memoryRepo<TwoFactorRecovery>();
    email = { queueEmail: jest.fn().mockResolvedValue({ queued: true }) };
    wallet = Keypair.random();

    const moduleRef = await Test.createTestingModule({
      controllers: [TwoFactorController],
      providers: [
        AuthService,
        TwoFactorService,
        { provide: getRepositoryToken(User), useValue: users },
        {
          provide: getRepositoryToken(UserPreferences),
          useValue: memoryRepo<UserPreferences>(),
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: memoryRepo<RefreshToken>(),
        },
        {
          provide: getRepositoryToken(AuthAuditEvent),
          useValue: memoryRepo<AuthAuditEvent>(),
        },
        {
          provide: getRepositoryToken(WebAuthnCredential),
          useValue: memoryRepo<WebAuthnCredential>(),
        },
        { provide: getRepositoryToken(TwoFactorAuth), useValue: twoFactorRows },
        {
          provide: getRepositoryToken(TwoFactorRecovery),
          useValue: recoveryRows,
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'TWO_FACTOR_ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
          },
        },
        {
          provide: JwtService,
          useValue: { signAsync: jest.fn().mockResolvedValue('access-token') },
        },
        { provide: EmailService, useValue: email },
      ],
    }).compile();

    auth = moduleRef.get(AuthService);

    // First login creates the user; later requests act as that user.
    user = (await walletLogin()).user;
    user.email = 'saver@example.com';
    await users.save(user);

    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: User }).user = user;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('setup generates a valid TOTP secret and stores it encrypted', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .expect(200);

    const secret = res.body.secret as string;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);

    const stored = twoFactorRows.rows[0];
    expect(stored.isEnabled).toBe(false);
    expect(stored.secret).not.toContain(secret);
    expect(stored.secret!.split(':')).toHaveLength(3);
  });

  it('QR code encodes the correct otpauth URI', async () => {
    const { setup } = await enableTwoFactor();

    const uri = new URL(setup.otpauth_url);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Stow:saver@example.com');
    expect(uri.searchParams.get('secret')).toBe(setup.secret);
    expect(uri.searchParams.get('issuer')).toBe('Stow');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');

    expect(setup.qr_code_data_url).toMatch(/^data:image\/png;base64,/);
    expect(setup.qr_code_data_url).toBe(
      await QRCode.toDataURL(setup.otpauth_url),
    );
  });

  it('login works without a code until 2FA is enabled', async () => {
    const session = await walletLogin();
    expect(session.access_token).toBe('access-token');
    expect(session.refresh_token).toEqual(expect.any(String));
  });

  it('login requires a valid TOTP code once 2FA is enabled', async () => {
    const { setup } = await enableTwoFactor();

    await expect(walletLogin()).rejects.toThrow('TWO_FACTOR_REQUIRED');

    // Enabling used the current step, so the next step's code signs in.
    const session = await walletLogin(codeAt(setup.secret, 1));
    expect(session.access_token).toBe('access-token');
    expect(session.user.id).toBe(user.id);
  });

  it('rejects invalid and replayed codes', async () => {
    const { setup } = await enableTwoFactor();

    await expect(walletLogin('123456')).rejects.toThrow(
      'INVALID_TWO_FACTOR_CODE',
    );
    await expect(walletLogin(codeAt(setup.secret, 5))).rejects.toThrow(
      'INVALID_TWO_FACTOR_CODE',
    );

    const code = codeAt(setup.secret, 1);
    await walletLogin(code);
    await expect(walletLogin(code)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    await request(app.getHttpServer())
      .post('/auth/2fa/enable')
      .send({ code: 'abc' })
      .expect(400);
  });

  it('backup codes sign in once each', async () => {
    const { backupCodes } = await enableTwoFactor();
    expect(backupCodes).toHaveLength(8);
    expect(new Set(backupCodes).size).toBe(8);

    const stored = JSON.stringify(twoFactorRows.rows[0].backupCodes);
    for (const code of backupCodes) {
      expect(stored).not.toContain(code);
    }

    await expect(walletLogin(backupCodes[0])).resolves.toHaveProperty(
      'access_token',
    );
    await expect(walletLogin(backupCodes[0])).rejects.toThrow(
      'INVALID_TWO_FACTOR_CODE',
    );
    await expect(
      walletLogin(backupCodes[1].toUpperCase()),
    ).resolves.toBeTruthy();
  });

  it('reset sends a verification email and the emailed token disables 2FA', async () => {
    await enableTwoFactor();

    await request(app.getHttpServer())
      .post('/auth/2fa/reset/request')
      .send({ email: 'saver@example.com' })
      .expect(200);

    expect(email.queueEmail).toHaveBeenCalledTimes(1);
    const sent = email.queueEmail.mock.calls[0][0] as {
      to: string;
      text: string;
    };
    expect(sent.to).toBe('saver@example.com');
    const token = sent.text.match(/: (\S+)\n/)?.[1] ?? '';
    expect(token).not.toBe('');

    await request(app.getHttpServer())
      .post('/auth/2fa/reset/confirm')
      .send({ token: 'wrong-token' })
      .expect(400);
    await expect(walletLogin()).rejects.toThrow('TWO_FACTOR_REQUIRED');

    await request(app.getHttpServer())
      .post('/auth/2fa/reset/confirm')
      .send({ token })
      .expect(200);
    await expect(walletLogin()).resolves.toHaveProperty('access_token');

    // The token is single-use.
    await request(app.getHttpServer())
      .post('/auth/2fa/reset/confirm')
      .send({ token })
      .expect(400);
  });

  it('reset request gives the same answer for unknown emails and sends nothing', async () => {
    await enableTwoFactor();

    const res = await request(app.getHttpServer())
      .post('/auth/2fa/reset/request')
      .send({ email: 'nobody@example.com' })
      .expect(200);

    expect(res.body.message).toMatch(/If two-factor authentication/);
    expect(email.queueEmail).not.toHaveBeenCalled();
  });
});
