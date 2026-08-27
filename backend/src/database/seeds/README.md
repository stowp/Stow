# Database Seeding

This directory contains scripts for seeding and resetting the development database with realistic test data for Stow savings.

## Overview

The seeding system provides demo data for the Stow savings platform:

- **3 sample users** with Stellar addresses
- **3 savings accounts** with varying balances
- **2 goals** (1 active, 1 reached)
- **1 group** pool with 3 members
- **3 group members** representing shares in the group pool

## Usage

### Seed Database

Populate the database with sample data:

```bash
npm run seed
```

This will:

1. Connect to the database
2. Check that the environment is not production
3. Insert all sample data
4. Display a summary of inserted records

### Reset Database

Clear all seeded data and prepare for re-seeding:

```bash
npm run db:reset
```

This will:

1. Drop all seeded tables
2. Display confirmation

After resetting, run migrations and seed again:

```bash
npm run migration:run
npm run seed
```

## Data Structure

### Users

| Field           | Type   | Description            |
| --------------- | ------ | ---------------------- |
| id              | uuid   | Unique user identifier |
| stellar_address | string | Stellar wallet address |
| username        | string | Display name           |
| role            | string | User role ('user')     |
| email           | string | Email address          |

### Savings Accounts

| Field   | Type   | Description                    |
| ------- | ------ | ------------------------------ |
| id      | uuid   | Unique account ID              |
| owner   | string | User's Stellar wallet address  |
| balance | string | Flexible balance in stroops    |

### Goals

| Field          | Type   | Description                           |
| -------------- | ------ | ------------------------------------- |
| id             | uuid   | Unique goal ID                        |
| on_chain_id    | string | Contract's identifier for this goal   |
| owner          | string | User's Stellar wallet address         |
| name           | string | Name of the goal                      |
| target_amount  | string | Target amount in stroops              |
| current_amount | string | Current saved amount in stroops       |
| status         | enum   | 'active' or 'reached'                 |
| reached_at     | date   | Timestamp when the goal was reached   |

### Groups

| Field       | Type    | Description                           |
| ----------- | ------- | ------------------------------------- |
| id          | uuid    | Unique group ID                       |
| on_chain_id | string  | Contract's identifier for this group  |
| creator     | string  | Creator's Stellar wallet address      |
| name        | string  | Name of the group                     |
| balance     | string  | Total pooled balance in stroops       |
| open        | boolean | Whether the group is open for members |
| settled     | boolean | Whether the group has been settled    |

### Group Members

| Field     | Type    | Description                                  |
| --------- | ------- | -------------------------------------------- |
| id        | uuid    | Unique member ID                             |
| group_id  | uuid    | Parent group ID                              |
| address   | string  | Member's Stellar wallet address              |
| share_bps | integer | Basis-point share for group-split (0-10000)  |

## Notes

- Seed data is idempotent and uses fixed UUIDs to avoid duplicates (safe to run multiple times)
- Timestamps and relations are correctly mapped
- Balances and amounts are stored as strings to avoid JS number precision loss on large i128 values (represented in stroops)
- The script checks for `NODE_ENV === 'production'` to prevent execution in production environments
