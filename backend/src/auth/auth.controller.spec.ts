import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { User } from '../users/entities/user.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { VerifyChallengeDto } from './dto/verify-challenge.dto';
import { PasskeyAuthenticationFinishDto } from './dto/passkey-authentication.dto';
import { PasskeyRegistrationFinishDto } from './dto/passkey-registration.dto';
import { RateLimitService } from './rate-limit.service';

const mockAuthService = () => ({
  generateChallenge: jest
    .fn()
    .mockImplementation(
      (address: string) => `InsightArena:nonce:1234567890:randomhex:${address}`,
    ),
  verifyChallenge: jest.fn(),
  verifyStellarSignature: jest.fn(),
  rotateRefreshToken: jest.fn(),
  beginPasskeyAuthentication: jest.fn(),
  finishPasskeyAuthentication: jest.fn(),
  beginPasskeyRegistration: jest.fn(),
  finishPasskeyRegistration: jest.fn(),
});

const mockConfigService = () => ({
  get: jest.fn().mockReturnValue('7d'),
});

describe('AuthController', () => {
  let controller: AuthController;
  let authService: ReturnType<typeof mockAuthService>;
  let configService: ReturnType<typeof mockConfigService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService() },
        {
          provide: RateLimitService,
          useValue: { getStatus: jest.fn() },
        },
        { provide: ConfigService, useValue: mockConfigService() },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get(AuthService);
    configService = module.get(ConfigService);
  });

  describe('generateChallenge', () => {
    it('returns a challenge string for a valid stellar_address', () => {
      const result = controller.generateChallenge({ stellar_address: 'GABC' });
      expect(authService.generateChallenge).toHaveBeenCalledWith('GABC');
      expect(result.challenge).toMatch(/^InsightArena:nonce:/);
    });
  });

  describe('verifyChallenge', () => {
    const dto: VerifyChallengeDto = {
      stellar_address: 'GABC123XYZ',
      signed_challenge: 'aabbcc',
    };

    it('returns { access_token, user } on valid input', async () => {
      const user = Object.assign(new User(), {
        id: 'uuid-1',
        stellar_address: dto.stellar_address,
      });
      authService.verifyChallenge.mockResolvedValue({
        access_token: 'signed.jwt.token',
        user,
      });

      const result = await controller.verifyChallenge(dto);

      expect(authService.verifyChallenge).toHaveBeenCalledWith(
        dto.stellar_address,
        dto.signed_challenge,
      );
      expect(result).toEqual({ access_token: 'signed.jwt.token', user });
    });

    it('propagates UnauthorizedException from the service (invalid signature)', async () => {
      authService.verifyChallenge.mockRejectedValue(
        new UnauthorizedException('Invalid signature'),
      );

      await expect(controller.verifyChallenge(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('propagates UnauthorizedException from the service (expired nonce)', async () => {
      authService.verifyChallenge.mockRejectedValue(
        new UnauthorizedException(
          'No valid challenge found or challenge expired',
        ),
      );

      await expect(controller.verifyChallenge(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('propagates UnauthorizedException from the service (replay attack)', async () => {
      authService.verifyChallenge.mockRejectedValue(
        new UnauthorizedException('Challenge already used'),
      );

      await expect(controller.verifyChallenge(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('beginPasskeyAuthentication', () => {
    it('returns the WebAuthn authentication options from the service', async () => {
      const options = { challenge: 'abc123', rpId: 'localhost' };
      authService.beginPasskeyAuthentication.mockResolvedValue(options);

      const result = await controller.beginPasskeyAuthentication();

      expect(result).toEqual(options);
    });
  });

  describe('finishPasskeyAuthentication', () => {
    const dto = {
      response: {
        id: 'cred-id-1',
        rawId: 'cred-id-1',
        type: 'public-key',
        response: {
          clientDataJSON: 'client-data',
          authenticatorData: 'auth-data',
          signature: 'sig',
        },
        clientExtensionResults: {},
      },
    } as unknown as PasskeyAuthenticationFinishDto;

    it('returns access_token, refresh_token and user for a valid assertion', async () => {
      const user = Object.assign(new User(), {
        id: 'uuid-1',
        stellar_address: 'GPASSKEY',
      });
      authService.finishPasskeyAuthentication.mockResolvedValue({
        access_token: 'passkey.jwt.token',
        refresh_token: 'raw-refresh-token',
        user,
      });

      const result = await controller.finishPasskeyAuthentication(dto);

      expect(authService.finishPasskeyAuthentication).toHaveBeenCalledWith(
        dto.response,
      );
      expect(result).toEqual({
        access_token: 'passkey.jwt.token',
        refresh_token: 'raw-refresh-token',
        user,
      });
    });

    it('propagates UnauthorizedException for an invalid assertion', async () => {
      authService.finishPasskeyAuthentication.mockRejectedValue(
        new UnauthorizedException('Invalid passkey assertion'),
      );

      await expect(controller.finishPasskeyAuthentication(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('beginPasskeyRegistration', () => {
    it('returns the WebAuthn registration options from the service for the current user', async () => {
      const user = Object.assign(new User(), {
        id: 'uuid-1',
        stellar_address: 'GPASSKEY',
      });
      const options = { challenge: 'reg-abc123', rp: { id: 'localhost' } };
      authService.beginPasskeyRegistration.mockResolvedValue(options);

      const result = await controller.beginPasskeyRegistration(user);

      expect(authService.beginPasskeyRegistration).toHaveBeenCalledWith(user);
      expect(result).toEqual(options);
    });
  });

  describe('finishPasskeyRegistration', () => {
    const user = Object.assign(new User(), {
      id: 'uuid-1',
      stellar_address: 'GPASSKEY',
    });

    const dto = {
      response: {
        id: 'new-cred-id-1',
        rawId: 'new-cred-id-1',
        type: 'public-key',
        response: {
          clientDataJSON: 'client-data',
          attestationObject: 'attestation-object',
        },
        clientExtensionResults: {},
      },
    } as unknown as PasskeyRegistrationFinishDto;

    it('returns the stored credential summary for a valid attestation', async () => {
      const stored = {
        id: 'cred-row-new',
        credential_id: 'new-cred-id-1',
        created_at: new Date(),
      };
      authService.finishPasskeyRegistration.mockResolvedValue(stored);

      const result = await controller.finishPasskeyRegistration(user, dto);

      expect(authService.finishPasskeyRegistration).toHaveBeenCalledWith(
        user,
        dto.response,
      );
      expect(result).toEqual(stored);
    });

    it('propagates UnauthorizedException for an invalid attestation', async () => {
      authService.finishPasskeyRegistration.mockRejectedValue(
        new UnauthorizedException('Invalid passkey registration response'),
      );

      await expect(
        controller.finishPasskeyRegistration(user, dto),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('verifyWallet', () => {
    it('should return { verified: true } for a valid signature', () => {
      const dto = {
        stellar_address: 'G...Address',
        challenge: 'InsightArena:dispute:123',
        signature: 'a1b2c3d4',
      };
      authService.verifyStellarSignature.mockReturnValue(true);

      const result = controller.verifyWallet(dto);

      expect(result).toEqual({ verified: true });
      expect(authService.verifyStellarSignature).toHaveBeenCalledWith(
        dto.stellar_address,
        dto.challenge,
        dto.signature,
      );
    });

    it('should return { verified: false } for an invalid signature', () => {
      const dto = {
        stellar_address: 'G...Address',
        challenge: 'InsightArena:dispute:123',
        signature: 'wrong-signature',
      };
      authService.verifyStellarSignature.mockReturnValue(false);

      const result = controller.verifyWallet(dto);

      expect(result).toEqual({ verified: false });
    });
  });

  describe('refreshToken', () => {
    const dto = { refresh_token: 'raw-refresh-token' };

    it('should return new access token and refresh token with expiry', async () => {
      authService.rotateRefreshToken.mockResolvedValue({
        access_token: 'new.jwt.token',
        refresh_token: 'new-refresh-token',
      });

      const result = await controller.refreshToken(dto);

      expect(result.access_token).toBe('new.jwt.token');
      expect(result.refresh_token).toBe('new-refresh-token');
      expect(result.expires_at).toBeDefined();
      expect(authService.rotateRefreshToken).toHaveBeenCalledWith(
        'raw-refresh-token',
      );
    });

    it('should calculate correct expiry timestamp for 7d token', async () => {
      authService.rotateRefreshToken.mockResolvedValue({
        access_token: 'new.jwt.token',
        refresh_token: 'new-refresh-token',
      });
      configService.get.mockReturnValue('7d');

      const before = Date.now();
      const result = await controller.refreshToken(dto);
      const after = Date.now();

      const expiresAt = new Date(result.expires_at).getTime();
      const expected7Days = 7 * 24 * 60 * 60 * 1000;

      expect(expiresAt).toBeGreaterThanOrEqual(before + expected7Days);
      expect(expiresAt).toBeLessThanOrEqual(after + expected7Days);
    });

    it('should propagate UnauthorizedException if the refresh token is invalid', async () => {
      authService.rotateRefreshToken.mockRejectedValue(
        new UnauthorizedException('Invalid refresh token'),
      );

      await expect(controller.refreshToken(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should propagate UnauthorizedException on reuse detection', async () => {
      authService.rotateRefreshToken.mockRejectedValue(
        new UnauthorizedException(
          'Refresh token reuse detected; session revoked',
        ),
      );

      await expect(controller.refreshToken(dto)).rejects.toThrow(
        'Refresh token reuse detected; session revoked',
      );
    });

    it('should handle different expiry formats', async () => {
      authService.rotateRefreshToken.mockResolvedValue({
        access_token: 'new.jwt.token',
        refresh_token: 'new-refresh-token',
      });

      // Test 24h format
      configService.get.mockReturnValue('24h');
      const result24h = await controller.refreshToken(dto);
      expect(result24h.expires_at).toBeDefined();

      // Test 60m format
      configService.get.mockReturnValue('60m');
      const result60m = await controller.refreshToken(dto);
      expect(result60m.expires_at).toBeDefined();

      // Test 3600s format
      configService.get.mockReturnValue('3600s');
      const result3600s = await controller.refreshToken(dto);
      expect(result3600s.expires_at).toBeDefined();
    });
  });
});
