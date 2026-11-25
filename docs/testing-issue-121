# Issue #585: Locked Plans Service Tests

## Overview
This document describes testing strategies for the locked plans service, which manages time-locked savings plans that restrict withdrawals until a specified unlock date.

## Test Coverage

### Locked Plan Projection
The following tests ensure accurate locked plan management:

1. **Plan Creation (upsertCreated)**
   - Test successful creation of a new locked plan
   - Verify plan is stored with correct on_chain_id, owner, balance, and unlock_at
   - Confirm idempotency: re-inserting same plan returns existing record unchanged
   - Test event replay scenario: ensure no duplicate plans on redelivery

2. **Plan Listing (listByOwner)**
   - Test listing all plans for an account
   - Verify plans are ordered by unlock_at (soonest-first default)
   - Test descending sort (latest-unlocking first)
   - Validate pagination with multiple pages
   - Test limit capping at 100 entries

3. **Pagination**
   - Test default page/limit parameters
   - Verify correct skip/take calculations
   - Test total count accuracy
   - Validate empty result handling

4. **Data Integrity**
   - Test balance preservation across updates
   - Verify owner field cannot change
   - Confirm unlock_at cannot be modified after creation
   - Test on_chain_id immutability

## Service Methods

### upsertCreated(params)
- **Parameters**: onChainId, owner, balance, unlockAt
- **Returns**: LockedPlan entity
- **Idempotency**: Yes (keyed by on_chain_id)

### listByOwner(owner, page, limit, sort)
- **Parameters**: 
  - owner: Stellar account address
  - page: Pagination page (default 1)
  - limit: Results per page (default 20, max 100)
  - sort: 'asc' or 'desc' (default 'asc')
- **Returns**: PaginatedLockedPlans { data, total, page, limit }

## Related Code
- `src/savings/entities/locked-plan.entity.ts` - Entity definition
- `src/savings/locked-plans.service.ts` - Service implementation
- `src/savings-projection/` - Event projection pipeline

## Future Enhancements
- Performance optimization for accounts with many plans
- Caching of frequently accessed plan lists
- Notification system integration for unlock events
- Plan modification/early termination support
