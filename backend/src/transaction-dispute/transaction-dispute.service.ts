import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { TransactionDispute, DisputeStatus } from './entities/transaction-dispute.entity';
import {
  CreateDisputeDto,
  UpdateDisputeStatusDto,
  DisputeQueryDto,
  DisputeResponseDto,
} from './dto/transaction-dispute.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';

@Injectable()
export class TransactionDisputeService {
  private readonly logger = new Logger(TransactionDisputeService.name);

  constructor(
    @InjectRepository(TransactionDispute)
    private readonly disputeRepo: Repository<TransactionDispute>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async createDispute(userId: string, dto: CreateDisputeDto): Promise<TransactionDispute> {
    const dispute = this.disputeRepo.create({
      user_id: userId,
      transaction_id: dto.transaction_id,
      reason: dto.reason,
      description: dto.description,
      evidence: dto.evidence?.map((e) => ({
        ...e,
        uploaded_at: new Date().toISOString(),
      })),
      status: DisputeStatus.PENDING,
    });

    const saved = await this.disputeRepo.save(dispute);
    this.logger.log(`Dispute ${saved.id} created by user ${userId}`);

    // Notify admin team
    await this.notifyAdminTeam(saved.id);

    return saved;
  }

  async getMyDisputes(userId: string, query: DisputeQueryDto): Promise<{
    data: DisputeResponseDto[];
    meta: any;
  }> {
    const { page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const [data, total] = await this.disputeRepo.findAndCount({
      where: { user_id: userId },
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });

    return {
      data: data.map(this.toResponseDto),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getDisputeById(id: string, userId?: string): Promise<TransactionDispute> {
    const dispute = await this.disputeRepo.findOne({
      where: { id },
      relations: ['user', 'assigned_admin', 'resolver'],
    });

    if (!dispute) {
      throw new NotFoundException(`Dispute ${id} not found`);
    }

    // If user is not admin, they can only see their own disputes
    if (userId && dispute.user_id !== userId) {
      // Check if user is admin - for now, just allow access
      // In production, check user role
    }

    return dispute;
  }

  async adminListDisputes(query: DisputeQueryDto): Promise<{
    data: DisputeResponseDto[];
    meta: any;
  }> {
    const { page = 1, limit = 20, status, user_id } = query;
    const skip = (page - 1) * limit;

    const qb = this.disputeRepo
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.user', 'user')
      .leftJoinAndSelect('d.assigned_admin', 'assigned_admin')
      .leftJoinAndSelect('d.resolver', 'resolver');

    if (status) {
      qb.andWhere('d.status = :status', { status });
    }

    if (user_id) {
      qb.andWhere('d.user_id = :userId', { userId: user_id });
    }

    qb.orderBy('d.created_at', 'DESC').skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data: data.map(this.toResponseDto),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async adminUpdateDispute(
    id: string,
    adminId: string,
    dto: UpdateDisputeStatusDto,
  ): Promise<TransactionDispute> {
    const dispute = await this.getDisputeById(id);

    if (dto.status) {
      dispute.status = dto.status;
    }

    if (dto.assigned_to) {
      dispute.assigned_to = dto.assigned_to;
      dispute.assigned_admin = await this.userRepo.findOneBy({ id: dto.assigned_to });
      
      if (dto.status === DisputeStatus.INVESTIGATING && dispute.status !== DisputeStatus.INVESTIGATING) {
        // Notify user that dispute is being investigated
        await this.notificationsService.createNotification({
          user_id: dispute.user_id,
          type: 'dispute_update',
          title: 'Dispute Under Investigation',
          message: `Your dispute for transaction ${dispute.transaction_id} is now being investigated.`,
          metadata: { dispute_id: dispute.id },
        });
      }
    }

    if (dto.resolution_notes) {
      dispute.resolution_notes = dto.resolution_notes;
    }

    if (dto.resolution_outcome) {
      dispute.resolution_outcome = dto.resolution_outcome;
    }

    if (dto.status === DisputeStatus.RESOLVED || dto.status === DisputeStatus.REJECTED) {
      dispute.resolved_at = new Date();
      dispute.resolved_by = adminId;
      dispute.resolver = await this.userRepo.findOneBy({ id: adminId });

      // Notify user of resolution
      await this.notificationsService.createNotification({
        user_id: dispute.user_id,
        type: 'dispute_resolved',
        title: 'Dispute Resolved',
        message: `Your dispute for transaction ${dispute.transaction_id} has been ${dto.status}.`,
        metadata: { 
          dispute_id: dispute.id,
          outcome: dto.resolution_outcome,
          notes: dto.resolution_notes,
        },
      });
    }

    const saved = await this.disputeRepo.save(dispute);
    this.logger.log(`Dispute ${id} updated by admin ${adminId}`);
    return saved;
  }

  async getDisputeStats(): Promise<{
    total: number;
    pending: number;
    investigating: number;
    resolved: number;
    rejected: number;
    avg_resolution_time_hours: number | null;
  }> {
    const [total, pending, investigating, resolved, rejected] = await Promise.all([
      this.disputeRepo.count(),
      this.disputeRepo.count({ where: { status: DisputeStatus.PENDING } }),
      this.disputeRepo.count({ where: { status: DisputeStatus.INVESTIGATING } }),
      this.disputeRepo.count({ where: { status: DisputeStatus.RESOLVED } }),
      this.disputeRepo.count({ where: { status: DisputeStatus.REJECTED } }),
    ]);

    // Calculate average resolution time
    const resolvedDisputes = await this.disputeRepo
      .createQueryBuilder('d')
      .where('d.status IN (:...statuses)', {
        statuses: [DisputeStatus.RESOLVED, DisputeStatus.REJECTED],
      })
      .andWhere('d.resolved_at IS NOT NULL')
      .getMany();

    let avgResolutionTimeHours: number | null = null;
    if (resolvedDisputes.length > 0) {
      const totalHours = resolvedDisputes.reduce((sum, d) => {
        const diff = d.resolved_at!.getTime() - d.created_at.getTime();
        return sum + diff / (1000 * 60 * 60);
      }, 0);
      avgResolutionTimeHours = Math.round(totalHours / resolvedDisputes.length);
    }

    return {
      total,
      pending,
      investigating,
      resolved,
      rejected,
      avg_resolution_time_hours: avgResolutionTimeHours,
    };
  }

  private async notifyAdminTeam(disputeId: string): Promise<void> {
    // Find admin users
    const admins = await this.userRepo.find({ where: { role: 'admin' } });
    
    for (const admin of admins) {
      await this.notificationsService.createNotification({
        user_id: admin.id,
        type: 'new_dispute',
        title: 'New Transaction Dispute',
        message: `A new transaction dispute (${disputeId}) has been filed and requires review.`,
        metadata: { dispute_id: disputeId },
      });
    }
  }

  private toResponseDto(dispute: TransactionDispute): DisputeResponseDto {
    return {
      id: dispute.id,
      user_id: dispute.user_id,
      transaction_id: dispute.transaction_id,
      reason: dispute.reason,
      description: dispute.description,
      evidence: dispute.evidence as any,
      status: dispute.status,
      assigned_to: dispute.assigned_to,
      resolution_notes: dispute.resolution_notes,
      resolution_outcome: dispute.resolution_outcome,
      resolved_at: dispute.resolved_at,
      created_at: dispute.created_at,
      updated_at: dispute.updated_at,
    };
  }
}