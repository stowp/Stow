import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SavingsController } from './savings.controller';
import { SavingsService } from './savings.service';

describe('SavingsController', () => {
  let controller: SavingsController;
  let savingsService: {
    ping: jest.Mock;
    listGroups: jest.Mock;
    summary: jest.Mock;
  };

  const ADDRESS = 'GADDRESS1234567890';

  beforeEach(async () => {
    savingsService = {
      ping: jest.fn(),
      listGroups: jest.fn(),
      summary: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SavingsController],
      providers: [
        {
          provide: SavingsService,
          useValue: savingsService,
        },
      ],
    }).compile();

    controller = module.get<SavingsController>(SavingsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('ping', () => {
    it('delegates to SavingsService.ping', () => {
      savingsService.ping.mockReturnValue({ status: 'ok' });

      expect(controller.ping()).toEqual({ status: 'ok' });
      expect(savingsService.ping).toHaveBeenCalled();
    });
  });

  describe('listGroups', () => {
    it('delegates to SavingsService.listGroups with the given address', async () => {
      const serviceResult = {
        address: ADDRESS,
        groups: [
          {
            on_chain_id: 'chain-group-1',
            creator: 'GCREATOR1',
            name: 'Vacation Fund',
            members: [ADDRESS],
            balance: '1000000',
            open: true,
          },
        ],
      };
      savingsService.listGroups.mockResolvedValue(serviceResult);

      const result = await controller.listGroups(ADDRESS);

      expect(savingsService.listGroups).toHaveBeenCalledWith(ADDRESS);
      expect(result).toBe(serviceResult);
    });

    it('throws BadRequestException when address is missing', () => {
      expect(() => controller.listGroups(undefined)).toThrow(
        BadRequestException,
      );
      expect(savingsService.listGroups).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when address is an empty string', () => {
      expect(() => controller.listGroups('')).toThrow(BadRequestException);
      expect(savingsService.listGroups).not.toHaveBeenCalled();
    });

    it('propagates errors thrown by SavingsService', async () => {
      const error = new Error('database unavailable');
      savingsService.listGroups.mockRejectedValue(error);

      await expect(controller.listGroups(ADDRESS)).rejects.toThrow(
        'database unavailable',
      );
    });
  });

  describe('summary', () => {
    it('delegates to SavingsService.summary with the given address', async () => {
      const serviceResult = {
        address: ADDRESS,
        products: [
          { product: 'flexible', total: '500000' },
          { product: 'goals', total: '750000' },
        ],
        total: '1250000',
      };
      savingsService.summary.mockResolvedValue(serviceResult);

      const result = await controller.summary(ADDRESS);

      expect(savingsService.summary).toHaveBeenCalledWith(ADDRESS);
      expect(result).toBe(serviceResult);
    });

    it('throws BadRequestException when address is missing', () => {
      expect(() => controller.summary(undefined)).toThrow(BadRequestException);
      expect(savingsService.summary).not.toHaveBeenCalled();
    });

    it('propagates errors thrown by SavingsService', async () => {
      const error = new Error('database unavailable');
      savingsService.summary.mockRejectedValue(error);

      await expect(controller.summary(ADDRESS)).rejects.toThrow(
        'database unavailable',
      );
    });
  });
});
