import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import * as crypto from 'crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { AnchorCallbackController } from './anchor-callback.controller';
import { AnchorService } from './anchor.service';
import { AnchorDeposit } from './entities/anchor-deposit.entity';
import { WebhookSignatureGuard } from '../webhooks/guards/webhook-signature.guard';
import { WebhookSignatureService } from '../webhooks/services/webhook-signature.service';
import { WebhookProcessedEvent } from '../webhooks/entities/webhook-processed-event.entity';

describe('Anchor SEP-24 Callback E2E', () => {
  let app: INestApplication;
  let depositRepo: any;
  let processedEventRepo: any;
  const testSecret = 'test-webhook-secret';

  beforeAll(async () => {
    const mockDepositRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
    };

    const mockProcessedEventRepo = {
      findOne: jest.fn(),
      create: jest.fn((dto) => dto),
      save: jest.fn((dto) => dto),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AnchorCallbackController],
      providers: [
        AnchorService,
        WebhookSignatureGuard,
        WebhookSignatureService,
        {
          provide: getRepositoryToken(AnchorDeposit),
          useValue: mockDepositRepo,
        },
        {
          provide: getRepositoryToken(WebhookProcessedEvent),
          useValue: mockProcessedEventRepo,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'WEBHOOK_HMAC_SECRET') return testSecret;
              if (key === 'WEBHOOK_REPLAY_WINDOW_SECONDS') return 300;
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    depositRepo = moduleFixture.get(getRepositoryToken(AnchorDeposit));
    processedEventRepo = moduleFixture.get(
      getRepositoryToken(WebhookProcessedEvent),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  function createSignature(body: string): string {
    return crypto.createHmac('sha256', testSecret).update(body).digest('hex');
  }

  describe('POST /savings/anchor/callbacks/sep24', () => {
    it('should accept valid callback with correct signature', async () => {
      const payload = {
        transaction_id: 'anchor-tx-123',
        status: 'completed',
        event_id: 'evt_' + Date.now(),
      };

      const body = JSON.stringify(payload);
      const signature = createSignature(body);

      depositRepo.findOne.mockResolvedValue({
        id: 'dep-123',
        transaction_id: 'anchor-tx-123',
        status: 'pending',
      });
      depositRepo.save.mockResolvedValue({
        id: 'dep-123',
        status: 'completed',
      });
      processedEventRepo.findOne.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .post('/savings/anchor/callbacks/sep24')
        .set('X-Webhook-Signature', signature)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({
        received: true,
        updated: true,
      });
    });

    it('should reject callback with invalid signature', async () => {
      const payload = {
        transaction_id: 'anchor-tx-456',
        status: 'completed',
        event_id: 'evt_' + Date.now(),
      };

      await request(app.getHttpServer())
        .post('/savings/anchor/callbacks/sep24')
        .set('X-Webhook-Signature', 'invalid-signature')
        .send(payload)
        .expect(401);
    });

    it('should reject callback without signature header', async () => {
      const payload = {
        transaction_id: 'anchor-tx-789',
        status: 'completed',
        event_id: 'evt_' + Date.now(),
      };

      await request(app.getHttpServer())
        .post('/savings/anchor/callbacks/sep24')
        .send(payload)
        .expect(401);
    });

    it('should reject replayed event_id', async () => {
      const eventId = 'evt_' + Date.now();
      const payload = {
        transaction_id: 'anchor-tx-replay',
        status: 'completed',
        event_id: eventId,
      };

      const body = JSON.stringify(payload);
      const signature = createSignature(body);

      processedEventRepo.findOne.mockResolvedValue({
        source: 'anchor',
        event_id: eventId,
        received_at: new Date(),
      });

      await request(app.getHttpServer())
        .post('/savings/anchor/callbacks/sep24')
        .set('X-Webhook-Signature', signature)
        .send(payload)
        .expect(401);
    });

    it('should reject callback missing event_id', async () => {
      const payload = {
        transaction_id: 'anchor-tx-no-event',
        status: 'completed',
      };

      const body = JSON.stringify(payload);
      const signature = createSignature(body);

      await request(app.getHttpServer())
        .post('/savings/anchor/callbacks/sep24')
        .set('X-Webhook-Signature', signature)
        .send(payload)
        .expect(400);
    });

    it('should reject callback payloads with unknown fields', async () => {
      const payload = {
        transaction_id: 'anchor-tx-extra-field',
        status: 'completed',
        event_id: 'evt_' + Date.now(),
        extra: 'unexpected',
      };

      const signature = createSignature(JSON.stringify(payload));

      await request(app.getHttpServer())
        .post('/savings/anchor/callbacks/sep24')
        .set('X-Webhook-Signature', signature)
        .send(payload)
        .expect(400);
    });

    it('should handle idempotent callbacks (deposit already at status)', async () => {
      const payload = {
        transaction_id: 'anchor-tx-idempotent',
        status: 'completed',
        event_id: 'evt_' + Date.now(),
      };

      const body = JSON.stringify(payload);
      const signature = createSignature(body);

      depositRepo.findOne.mockResolvedValue({
        id: 'dep-idempotent',
        transaction_id: 'anchor-tx-idempotent',
        status: 'completed',
      });
      processedEventRepo.findOne.mockResolvedValue(null);

      const response = await request(app.getHttpServer())
        .post('/savings/anchor/callbacks/sep24')
        .set('X-Webhook-Signature', signature)
        .send(payload)
        .expect(200);

      expect(response.body).toEqual({
        received: true,
        updated: false,
      });
    });

    it('should accept all valid status transitions', async () => {
      const statuses = ['pending', 'processing', 'completed', 'failed'];

      for (const status of statuses) {
        const payload = {
          transaction_id: `anchor-tx-${status}`,
          status,
          event_id: 'evt_' + Date.now() + '_' + status,
        };

        const body = JSON.stringify(payload);
        const signature = createSignature(body);

        depositRepo.findOne.mockResolvedValue({
          id: `dep-${status}`,
          transaction_id: `anchor-tx-${status}`,
          status: 'pending',
        });
        depositRepo.save.mockResolvedValue({
          id: `dep-${status}`,
          status,
        });
        processedEventRepo.findOne.mockResolvedValue(null);

        await request(app.getHttpServer())
          .post('/savings/anchor/callbacks/sep24')
          .set('X-Webhook-Signature', signature)
          .send(payload)
          .expect(200);
      }
    });
  });
});
