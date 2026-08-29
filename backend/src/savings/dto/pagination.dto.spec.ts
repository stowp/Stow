import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SavingsListQueryDto } from './pagination.dto';

async function validateDto(
  plain: Record<string, unknown>,
): Promise<{ errors: string[]; instance: SavingsListQueryDto }> {
  const instance = plainToInstance(SavingsListQueryDto, plain);
  const errs = await validate(instance);
  const errors = errs.flatMap((e) => Object.values(e.constraints ?? {}));
  return { errors, instance };
}

describe('SavingsListQueryDto', () => {
  describe('defaults', () => {
    it('applies default page=1, limit=20, and no sort when no params are provided', async () => {
      const { errors, instance } = await validateDto({});
      expect(errors).toHaveLength(0);
      expect(instance.page).toBe(1);
      expect(instance.limit).toBe(20);
      expect(instance.sort).toBeUndefined();
    });
  });

  describe('inherited page/limit validation', () => {
    it('accepts valid page/limit and coerces numeric strings', async () => {
      const { errors, instance } = await validateDto({
        page: '3',
        limit: '50',
      });
      expect(errors).toHaveLength(0);
      expect(instance.page).toBe(3);
      expect(instance.limit).toBe(50);
    });

    it('rejects page=0', async () => {
      const { errors } = await validateDto({ page: 0 });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects page=-1', async () => {
      const { errors } = await validateDto({ page: -1 });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects limit=0', async () => {
      const { errors } = await validateDto({ limit: 0 });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects limit=101 (over the shared cap)', async () => {
      const { errors } = await validateDto({ limit: 101 });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-numeric limit', async () => {
      const { errors } = await validateDto({ limit: 'not-a-number' });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('sort', () => {
    it('accepts sort=asc', async () => {
      const { errors, instance } = await validateDto({ sort: 'asc' });
      expect(errors).toHaveLength(0);
      expect(instance.sort).toBe('asc');
    });

    it('accepts sort=desc', async () => {
      const { errors, instance } = await validateDto({ sort: 'desc' });
      expect(errors).toHaveLength(0);
      expect(instance.sort).toBe('desc');
    });

    it('rejects an arbitrary sort value', async () => {
      const { errors } = await validateDto({ sort: 'newest' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join(' ')).toMatch(/sort/i);
    });

    it('rejects a sort value that looks like a column-injection attempt', async () => {
      const { errors } = await validateDto({ sort: 'created_at' });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('combined validation', () => {
    it('accepts a fully valid combination', async () => {
      const { errors } = await validateDto({ page: 2, limit: 10, sort: 'asc' });
      expect(errors).toHaveLength(0);
    });

    it('reports errors for multiple invalid fields at once', async () => {
      const { errors } = await validateDto({
        page: -1,
        limit: 200,
        sort: 'bogus',
      });
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});
