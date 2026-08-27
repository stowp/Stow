import { DataSource } from 'typeorm';
import { config } from 'dotenv';

config();

/**
 * Database seeding script for development and testing
 * Populates savings demo data (users, accounts, a goal, a group)
 */

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Cannot run seed in production environment!');
  process.exit(1);
}

const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
  synchronize: false,
  logging: false,
});

async function seed() {
  try {
    await dataSource.initialize();
    console.log('Database connection established');

    const queryRunner = dataSource.createQueryRunner();

    // 1. Users
    const users = [
      {
        id: '11111111-1111-4111-a111-111111111111',
        stellar_address: 'GUSER111111111111111111111111111111111111111111111111111',
        username: 'alice_saver',
        role: 'user',
        email: 'alice@example.com',
      },
      {
        id: '22222222-2222-4222-a222-222222222222',
        stellar_address: 'GUSER222222222222222222222222222222222222222222222222222',
        username: 'bob_saver',
        role: 'user',
        email: 'bob@example.com',
      },
      {
        id: '33333333-3333-4333-a333-333333333333',
        stellar_address: 'GUSER333333333333333333333333333333333333333333333333333',
        username: 'charlie_saver',
        role: 'user',
        email: 'charlie@example.com',
      }
    ];

    // 2. Savings Accounts
    const savingsAccounts = [
      {
        id: '11111111-1111-4111-b111-111111111111',
        owner: users[0].stellar_address,
        balance: '5000000000', // 500 XLM
      },
      {
        id: '22222222-2222-4222-b222-222222222222',
        owner: users[1].stellar_address,
        balance: '1500000000', // 150 XLM
      },
      {
        id: '33333333-3333-4333-b333-333333333333',
        owner: users[2].stellar_address,
        balance: '0',
      }
    ];

    // 3. Goals
    const goals = [
      {
        id: '11111111-1111-4111-c111-111111111111',
        on_chain_id: 'goal_001',
        owner: users[0].stellar_address,
        name: 'New Car Fund',
        target_amount: '100000000000', // 10,000 XLM
        current_amount: '25000000000', // 2,500 XLM
        status: 'active',
        reached_at: null,
      },
      {
        id: '22222222-2222-4222-c222-222222222222',
        on_chain_id: 'goal_002',
        owner: users[1].stellar_address,
        name: 'Emergency Savings',
        target_amount: '50000000000', // 5,000 XLM
        current_amount: '50000000000', // 5,000 XLM
        status: 'reached',
        reached_at: new Date(),
      }
    ];

    // 4. Groups
    const group_id = '11111111-1111-4111-d111-111111111111';
    const groups = [
      {
        id: group_id,
        on_chain_id: 'group_001',
        creator: users[0].stellar_address,
        name: 'Family Vacation',
        balance: '12000000000', // 1,200 XLM
        open: true,
        settled: false,
      }
    ];

    // 5. Group Members
    const groupMembers = [
      {
        id: '11111111-1111-4111-e111-111111111111',
        group_id: group_id,
        address: users[0].stellar_address,
        share_bps: 4000,
      },
      {
        id: '22222222-2222-4222-e222-222222222222',
        group_id: group_id,
        address: users[1].stellar_address,
        share_bps: 3000,
      },
      {
        id: '33333333-3333-4333-e333-333333333333',
        group_id: group_id,
        address: users[2].stellar_address,
        share_bps: 3000,
      }
    ];

    console.log('Seeding savings demo data...');

    // Insert Users
    for (const user of users) {
      await queryRunner.query(
        `INSERT INTO users (id, stellar_address, username, role, email) 
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [user.id, user.stellar_address, user.username, user.role, user.email],
      );
    }
    console.log(`✓ Inserted ${users.length} users`);

    // Insert Savings Accounts
    for (const account of savingsAccounts) {
      await queryRunner.query(
        `INSERT INTO savings_accounts (id, owner, balance) 
         VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [account.id, account.owner, account.balance],
      );
    }
    console.log(`✓ Inserted ${savingsAccounts.length} savings accounts`);

    // Insert Goals
    for (const goal of goals) {
      await queryRunner.query(
        `INSERT INTO goals (id, on_chain_id, owner, name, target_amount, current_amount, status, reached_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [goal.id, goal.on_chain_id, goal.owner, goal.name, goal.target_amount, goal.current_amount, goal.status, goal.reached_at],
      );
    }
    console.log(`✓ Inserted ${goals.length} goals`);

    // Insert Groups
    for (const group of groups) {
      await queryRunner.query(
        `INSERT INTO groups (id, on_chain_id, creator, name, balance, open, settled) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [group.id, group.on_chain_id, group.creator, group.name, group.balance, group.open, group.settled],
      );
    }
    console.log(`✓ Inserted ${groups.length} groups`);

    // Insert Group Members
    for (const member of groupMembers) {
      await queryRunner.query(
        `INSERT INTO group_members (id, group_id, address, share_bps) 
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [member.id, member.group_id, member.address, member.share_bps],
      );
    }
    console.log(`✓ Inserted ${groupMembers.length} group members`);

    console.log('\n✅ Seeding completed successfully!');
    console.log(`
Summary:
- Users: ${users.length}
- Savings Accounts: ${savingsAccounts.length}
- Goals: ${goals.length}
- Groups: ${groups.length}
- Group Members: ${groupMembers.length}
    `);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await dataSource.destroy();
  }
}

void seed();
