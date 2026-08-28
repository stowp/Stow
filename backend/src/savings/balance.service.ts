import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Balance } from './entities/balance.entity';

export interface BalanceView {
  account: string;
  amount: string;
}

export interface AccountBalanceView {
  account: string;
  amount: string;
  created_at: Date;
  updated_at: Date;
}

/** TTL for balance reads: 10 seconds */
const BALANCE_CACHE_TTL_MS = 10_000;

const cacheKey = (account: string) => `savings:balance:${account}`;

@Injectable()
export class BalanceService {
  constructor(
    @InjectRepository(Balance)
    private readonly balanceRepository: Repository<Balance>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Credits `amount` stroops onto the account's running balance and invalidates cache. */
  async credit(account: string, amount: string): Promise<Balance> {
    let balance = await this.balanceRepository.findOne({
      where: { account },
    });
    if (!balance) {
      balance = this.balanceRepository.create({ account, amount: '0' });
    }
    balance.amount = (BigInt(balance.amount) + BigInt(amount)).toString();
    const saved = await this.balanceRepository.save(balance);
    await this.cache.del(cacheKey(account));
    return saved;
  }

  /**
   * Sets the account's balance to an absolute value and invalidates cache.
   *
   * Used for the `withdraw` projection instead of a `debit`-by-delta
   * method: the on-chain `withdraw` event already carries the contract's
   * own post-withdrawal balance (`new_balance`), so setting to that value
   * directly is idempotent by construction — replaying the same event
   * twice converges to the same final balance both times, unlike
   * decrementing by the withdrawn amount, which would double-apply on
   * redelivery. Mirrors `LockedPlansService.upsertCreated`'s
   * set-absolute-state approach for the same reason.
   */
  async setBalance(account: string, amount: string): Promise<Balance> {
    let balance = await this.balanceRepository.findOne({
      where: { account },
    });
    if (!balance) {
      balance = this.balanceRepository.create({ account, amount: '0' });
    }
    balance.amount = amount;
    const saved = await this.balanceRepository.save(balance);
    await this.cache.del(cacheKey(account));
    return saved;
  }

  async get(account: string): Promise<BalanceView> {
    const key = cacheKey(account);
    const cached = await this.cache.get<BalanceView>(key);
    if (cached) return cached;

    const balance = await this.balanceRepository.findOne({
      where: { account },
    });
    const view: BalanceView = { account, amount: balance?.amount ?? '0' };
    await this.cache.set(key, view, BALANCE_CACHE_TTL_MS);
    return view;
  }

  /**
   * Fetches the projected flexible balance for `account`, or `null` if no
   * account has ever been observed (i.e. no `deposit` event has ever been
   * recorded for it) — distinct from `get()`, which defaults an unknown
   * account to a zero balance for internal callers that don't need to
   * distinguish "zero balance" from "never existed".
   */
  async findAccount(account: string): Promise<AccountBalanceView | null> {
    const balance = await this.balanceRepository.findOne({
      where: { account },
    });
    if (!balance) return null;

    return {
      account: balance.account,
      amount: balance.amount,
      created_at: balance.created_at,
      updated_at: balance.updated_at,
    };
  }
}
