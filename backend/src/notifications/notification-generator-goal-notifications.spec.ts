import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationGeneratorService } from './notification-generator.service';
import { NotificationsService } from './notifications.service';
import { Notification, NotificationType } from './entities/notification.entity';
import { User } from '../users/entities/user.entity';
import { UserPreferences } from '../users/entities/user-preferences.entity';

describe('NotificationGeneratorService - Goal Notifications', () => {
  let service: NotificationGeneratorService;
  let notificationsService: NotificationsService;
  let notificationRepo: Repository<Notification>;
  let userRepo: Repository<User>;
  let userPreferencesRepo: Repository<UserPreferences>;

  const mockUser = {
    id: 'user-uuid',
    stellar_address: 'GTEST123',
  };

  const mockPreferences = {
    userId: 'user-uuid',
    goal_reached_notifications: true,
    goal_milestone_notifications: true,
    goal_contribution_notifications: true,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationGeneratorService,
        {
          provide: NotificationsService,
          useValue: {
            create: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Notification),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(UserPreferences),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<NotificationGeneratorService>(NotificationGeneratorService);
    notificationsService = module.get<NotificationsService>(NotificationsService);
    notificationRepo = module.get<Repository<Notification>>(getRepositoryToken(Notification));
    userRepo = module.get<Repository<User>>(getRepositoryToken(User));
    userPreferencesRepo = module.get<Repository<UserPreferences>>(
      getRepositoryToken(UserPreferences),
    );
  });

  describe('handleGoalReached', () => {
    it('should create a goal reached notification', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);

      await service.handleGoalReached({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        targetAmount: '1000000',
      });

      expect(notificationsService.create).toHaveBeenCalledWith(
        'GTEST123',
        NotificationType.GoalReached,
        'Savings goal reached! 🎯',
        expect.stringContaining('Emergency Fund'),
        expect.objectContaining({
          goal_id: 'goal-123',
          target_amount: '1000000',
        }),
        'user-uuid',
      );
    });

    it('should not create notification if user opted out', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue({
        ...mockPreferences,
        goal_reached_notifications: false,
      } as any);

      await service.handleGoalReached({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        targetAmount: '1000000',
      });

      expect(notificationsService.create).not.toHaveBeenCalled();
    });

    it('should create notification even if user not found (address-only)', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(null);

      await service.handleGoalReached({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        targetAmount: '1000000',
      });

      expect(notificationsService.create).toHaveBeenCalledWith(
        'GTEST123',
        NotificationType.GoalReached,
        'Savings goal reached! 🎯',
        expect.any(String),
        expect.any(Object),
        undefined,
      );
    });
  });

  describe('handleGoalMilestone', () => {
    it('should create a 25% milestone notification', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(null);

      await service.handleGoalMilestone({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        currentAmount: '250000',
        targetAmount: '1000000',
        milestonePercent: 25,
      });

      expect(notificationsService.create).toHaveBeenCalledWith(
        'GTEST123',
        NotificationType.GoalMilestone,
        '25% to your goal! 🌱',
        expect.stringContaining('25% complete'),
        expect.objectContaining({
          goal_id: 'goal-123',
          milestone_percent: 25,
        }),
        'user-uuid',
      );
    });

    it('should create a 50% milestone notification', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(null);

      await service.handleGoalMilestone({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        currentAmount: '500000',
        targetAmount: '1000000',
        milestonePercent: 50,
      });

      expect(notificationsService.create).toHaveBeenCalledWith(
        'GTEST123',
        NotificationType.GoalMilestone,
        '50% to your goal! 🌿',
        expect.any(String),
        expect.any(Object),
        'user-uuid',
      );
    });

    it('should create a 75% milestone notification', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue(null);

      await service.handleGoalMilestone({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        currentAmount: '750000',
        targetAmount: '1000000',
        milestonePercent: 75,
      });

      expect(notificationsService.create).toHaveBeenCalledWith(
        'GTEST123',
        NotificationType.GoalMilestone,
        '75% to your goal! 🌳',
        expect.any(String),
        expect.any(Object),
        'user-uuid',
      );
    });

    it('should not create duplicate milestone notifications', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);
      jest.spyOn(notificationRepo, 'findOne').mockResolvedValue({
        id: 1,
        type: NotificationType.GoalMilestone,
        data: { goal_id: 'goal-123', milestone_percent: 25 },
      } as any);

      await service.handleGoalMilestone({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        currentAmount: '250000',
        targetAmount: '1000000',
        milestonePercent: 25,
      });

      expect(notificationsService.create).not.toHaveBeenCalled();
    });

    it('should not create notification if user opted out', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue({
        ...mockPreferences,
        goal_milestone_notifications: false,
      } as any);

      await service.handleGoalMilestone({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        currentAmount: '250000',
        targetAmount: '1000000',
        milestonePercent: 25,
      });

      expect(notificationsService.create).not.toHaveBeenCalled();
    });
  });

  describe('handleGoalContribution', () => {
    it('should create a contribution notification with progress', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);

      await service.handleGoalContribution({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        contributionAmount: '100000',
        currentAmount: '400000',
        targetAmount: '1000000',
      });

      expect(notificationsService.create).toHaveBeenCalledWith(
        'GTEST123',
        NotificationType.GoalContribution,
        'Goal contribution received! 💰',
        expect.stringContaining('100000 stroops'),
        expect.objectContaining({
          goal_id: 'goal-123',
          contribution_amount: '100000',
          current_amount: '400000',
          target_amount: '1000000',
          progress_percent: 40,
        }),
        'user-uuid',
      );
    });

    it('should calculate progress percentage correctly', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);

      await service.handleGoalContribution({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        contributionAmount: '50000',
        currentAmount: '750000',
        targetAmount: '1000000',
      });

      const callArgs = (notificationsService.create as jest.Mock).mock.calls[0];
      expect(callArgs[4].progress_percent).toBe(75);
    });

    it('should not create notification if user opted out', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue({
        ...mockPreferences,
        goal_contribution_notifications: false,
      } as any);

      await service.handleGoalContribution({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        contributionAmount: '100000',
        currentAmount: '400000',
        targetAmount: '1000000',
      });

      expect(notificationsService.create).not.toHaveBeenCalled();
    });

    it('should handle zero target gracefully', async () => {
      jest.spyOn(userRepo, 'findOne').mockResolvedValue(mockUser as any);
      jest.spyOn(userPreferencesRepo, 'findOne').mockResolvedValue(mockPreferences as any);

      await service.handleGoalContribution({
        goalId: 'goal-123',
        owner: 'GTEST123',
        name: 'Emergency Fund',
        contributionAmount: '100000',
        currentAmount: '100000',
        targetAmount: '0',
      });

      const callArgs = (notificationsService.create as jest.Mock).mock.calls[0];
      expect(callArgs[4].progress_percent).toBe(0);
    });
  });
});
