import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * Pagination + sort-direction query DTO for the savings list endpoints
 * (`GET /savings/goals`, `GET /savings/locked`). Extends the shared
 * `PaginationQueryDto` (`page`/`limit`, already validated and capped —
 * see that file's own tests) rather than redeclaring page/limit here.
 *
 * Must be paired with `@UsePipes(new ValidationPipe({ whitelist: true }))`
 * on the route — this app has no global `ValidationPipe` registered (see
 * `main.ts`), so a `@Query()`-typed DTO's decorators are inert unless a
 * pipe is applied somewhere; `users.controller.ts` already establishes this
 * same per-route workaround for the same reason.
 *
 * `sort` is deliberately just a direction (`asc`/`desc`), not a free-text
 * field name — each savings list endpoint has exactly one meaningful sort
 * column already fixed by its query (goals: `created_at` DESC; locked:
 * `unlock_at` ASC), so a field-selector would let a caller request a sort
 * column with no supporting index. Direction alone still lets a caller
 * reverse the fixed column's order without that risk.
 */
export class SavingsListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description:
      "Sort direction for the endpoint's fixed sort column " +
      '(goals: created_at; locked: unlock_at)',
    enum: ['asc', 'desc'],
  })
  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'sort must be "asc" or "desc"' })
  sort?: 'asc' | 'desc';
}
