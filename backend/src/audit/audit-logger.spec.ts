import {
  AuditConfigError,
  AuditLoggerService,
  DEFAULT_RETENTION_DAYS,
  MAX_PAGE_SIZE,
  csvCell,
  normalizeIp,
  sanitizeMetadata,
} from './audit-logger.service';
import { makeAuditService, TEST_KEY_HEX } from './audit-test-utils';

const DAY = 86_400_000;

async function seed(
  harness: ReturnType<typeof makeAuditService>,
  entries: Array<
    Parameters<AuditLoggerService['record']>[0] & { ageDays?: number }
  >,
) {
  const now = Date.now();
  for (const { ageDays = 0, ...entry } of entries) {
    harness.repository.setClock(() => new Date(now - ageDays * DAY));
    await harness.service.record(entry);
  }
  harness.repository.setClock(() => new Date());
}

describe('AuditLoggerService', () => {
  describe('logging user actions', () => {
    it('records who did what, where, when and with what result', async () => {
      const { service, repository } = makeAuditService();
      const before = Date.now();

      const saved = await service.record({
        userId: 'user-1',
        action: 'POST /api/v1/savings/deposit',
        method: 'post',
        endpoint: '/api/v1/savings/deposit',
        statusCode: 201,
        durationMs: 42.6,
      });

      expect(repository.rows).toHaveLength(1);
      expect(saved).toMatchObject({
        userId: 'user-1',
        action: 'POST /api/v1/savings/deposit',
        method: 'POST',
        endpoint: '/api/v1/savings/deposit',
        statusCode: 201,
        durationMs: 43,
      });
      expect(saved.id).toEqual(expect.any(String));
      expect(saved.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(saved.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('records anonymous requests with no user', async () => {
      const { service } = makeAuditService();

      const saved = await service.record({ action: 'GET /api/v1/ping' });

      expect(saved.userId).toBeNull();
    });

    it('rejects an entry with no action', async () => {
      const { service, repository } = makeAuditService();

      await expect(service.record({ action: '   ' })).rejects.toThrow(
        'needs an action',
      );
      expect(repository.rows).toHaveLength(0);
    });

    it('trims over-long values instead of failing', async () => {
      const { service } = makeAuditService();

      const saved = await service.record({
        action: 'a'.repeat(500),
        endpoint: '/x'.repeat(500),
        userAgent: 'u'.repeat(2000),
        method: 'DELETE-EVERYTHING',
      });

      expect(saved.action).toHaveLength(255);
      expect(saved.endpoint).toHaveLength(512);
      expect(saved.method).toHaveLength(10);
      const [view] = (await service.search()).items;
      expect(view.userAgent).toHaveLength(512);
    });

    it('never stores a negative duration', async () => {
      const { service } = makeAuditService();

      const saved = await service.record({ action: 'x', durationMs: -5 });

      expect(saved.durationMs).toBe(0);
    });

    it('leaves optional fields null when absent', async () => {
      const { service } = makeAuditService();

      const saved = await service.record({ action: 'x' });

      expect(saved).toMatchObject({
        method: null,
        endpoint: null,
        statusCode: null,
        durationMs: null,
        ipHash: null,
        ipAddressEnc: null,
        userAgentEnc: null,
        metadataEnc: null,
      });
    });
  });

  describe('capturing request metadata', () => {
    it('captures the IP address, user agent and metadata accurately', async () => {
      const { service } = makeAuditService();

      await service.record({
        userId: 'user-1',
        action: 'GET /api/v1/goals/:id',
        ipAddress: '203.0.113.9',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0',
        metadata: { params: { id: 'goal-7' }, queryKeys: ['expand'] },
      });

      const [entry] = (await service.search()).items;
      expect(entry.ipAddress).toBe('203.0.113.9');
      expect(entry.userAgent).toBe(
        'Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0',
      );
      expect(entry.metadata).toEqual({
        params: { id: 'goal-7' },
        queryKeys: ['expand'],
      });
      expect(entry.decryptionFailed).toBe(false);
    });

    it('stores an IPv4-mapped IPv6 address as plain IPv4', async () => {
      const { service } = makeAuditService();

      await service.record({ action: 'x', ipAddress: '::ffff:198.51.100.4' });

      expect((await service.search()).items[0].ipAddress).toBe('198.51.100.4');
    });

    it('keeps IPv6 addresses intact', async () => {
      const { service } = makeAuditService();

      await service.record({ action: 'x', ipAddress: '2001:db8::1' });

      expect((await service.search()).items[0].ipAddress).toBe('2001:db8::1');
    });

    it('redacts secrets nested anywhere in the metadata', async () => {
      const { service, repository } = makeAuditService();

      await service.record({
        action: 'x',
        metadata: {
          password: 'hunter2',
          nested: {
            accessToken: 'abc',
            Authorization: 'Bearer abc',
            ok: 'fine',
          },
          list: [{ apiKey: 'k' }, { private_key: 'p' }],
          mnemonic: 'one two three',
        },
      });

      const [entry] = (await service.search()).items;
      expect(entry.metadata).toEqual({
        password: '[REDACTED]',
        nested: {
          accessToken: '[REDACTED]',
          Authorization: '[REDACTED]',
          ok: 'fine',
        },
        list: [{ apiKey: '[REDACTED]' }, { private_key: '[REDACTED]' }],
        mnemonic: '[REDACTED]',
      });
      // Not even the ciphertext row may mention the secret in the clear.
      expect(JSON.stringify(repository.rows)).not.toContain('hunter2');
    });

    it('replaces oversized metadata with a marker', async () => {
      const { service } = makeAuditService();
      const wide = Object.fromEntries(
        Array.from({ length: 60 }, (_, i) => [`key${i}`, 'v'.repeat(400)]),
      );

      await service.record({ action: 'x', metadata: wide });

      expect((await service.search()).items[0].metadata).toEqual({
        truncated: true,
      });
    });

    it('stores no metadata when none is given or it is empty', async () => {
      const { service } = makeAuditService();

      const a = await service.record({ action: 'x', metadata: {} });
      const b = await service.record({ action: 'x', metadata: null });

      expect(a.metadataEnc).toBeNull();
      expect(b.metadataEnc).toBeNull();
    });
  });

  describe('encryption at rest', () => {
    const ip = '203.0.113.77';
    const agent = 'DistinctivelyNamedBrowser/9.9';
    const meta = { note: 'distinctive-metadata-marker' };

    async function stored() {
      const harness = makeAuditService();
      await harness.service.record({
        action: 'x',
        ipAddress: ip,
        userAgent: agent,
        metadata: meta,
      });
      return { ...harness, row: harness.repository.rows[0] };
    }

    it('does not keep the IP address, user agent or metadata in the clear', async () => {
      const { row } = await stored();
      const everything = JSON.stringify(row);

      expect(everything).not.toContain(ip);
      expect(everything).not.toContain('DistinctivelyNamedBrowser');
      expect(everything).not.toContain('distinctive-metadata-marker');
    });

    it('uses a versioned AES-GCM format: version, iv, tag and ciphertext', async () => {
      const { row } = await stored();

      for (const value of [
        row.ipAddressEnc,
        row.userAgentEnc,
        row.metadataEnc,
      ]) {
        expect(value).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
      }
    });

    it('encrypts the same value differently every time (random IV)', async () => {
      const { service, repository } = makeAuditService();

      await service.record({ action: 'x', ipAddress: ip });
      await service.record({ action: 'x', ipAddress: ip });

      expect(repository.rows[0].ipAddressEnc).not.toBe(
        repository.rows[1].ipAddressEnc,
      );
    });

    it('stores a keyed hash, not the plain IP, for searching', async () => {
      const { row } = await stored();

      expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.ipHash).not.toContain(ip);
    });

    it('hashes the same IP identically so it can be searched', async () => {
      const { service, repository } = makeAuditService();

      await service.record({ action: 'a', ipAddress: ip });
      await service.record({ action: 'b', ipAddress: `::ffff:${ip}` });

      expect(repository.rows[0].ipHash).toBe(repository.rows[1].ipHash);
    });

    it('produces different hashes under a different key', async () => {
      const other = makeAuditService({
        AUDIT_LOG_ENCRYPTION_KEY: 'f'.repeat(64),
      });
      await other.service.record({ action: 'x', ipAddress: ip });
      const { row } = await stored();

      expect(other.repository.rows[0].ipHash).not.toBe(row.ipHash);
    });

    it('cannot be read with a different key', async () => {
      const { row } = await stored();
      const other = makeAuditService({
        AUDIT_LOG_ENCRYPTION_KEY: 'f'.repeat(64),
      });
      other.repository.rows.push(row);

      const [view] = (await other.service.search()).items;

      expect(view.decryptionFailed).toBe(true);
      expect(view.ipAddress).toBeNull();
      expect(view.userAgent).toBeNull();
      expect(view.metadata).toBeNull();
    });

    it('detects tampering with the ciphertext', async () => {
      const { service, row } = await stored();
      const [version, iv, tag, body] = row.ipAddressEnc!.split('.');
      const flipped = Buffer.from(body, 'base64url');
      flipped[0] ^= 0xff;
      row.ipAddressEnc = [version, iv, tag, flipped.toString('base64url')].join(
        '.',
      );

      const [view] = (await service.search()).items;

      expect(view.decryptionFailed).toBe(true);
      expect(view.ipAddress).toBeNull();
      // Other fields are still readable.
      expect(view.userAgent).toBe(agent);
    });

    it('rejects a ciphertext moved to another column', async () => {
      const { service, row } = await stored();
      row.ipAddressEnc = row.userAgentEnc;

      const [view] = (await service.search()).items;

      expect(view.decryptionFailed).toBe(true);
      expect(view.ipAddress).toBeNull();
    });

    it('treats a malformed value as undecryptable instead of throwing', async () => {
      const { service, row } = await stored();
      row.userAgentEnc = 'not-a-ciphertext';

      const [view] = (await service.search()).items;

      expect(view.decryptionFailed).toBe(true);
      expect(view.userAgent).toBeNull();
    });

    it('accepts the key as base64 as well as hex', async () => {
      const base64 = Buffer.from(TEST_KEY_HEX, 'hex').toString('base64');
      const { service } = makeAuditService({
        AUDIT_LOG_ENCRYPTION_KEY: base64,
      });

      await service.record({ action: 'x', ipAddress: ip });

      expect((await service.search()).items[0].ipAddress).toBe(ip);
    });
  });

  describe('configuration', () => {
    it('refuses to start without an encryption key', () => {
      expect(() =>
        makeAuditService({ AUDIT_LOG_ENCRYPTION_KEY: undefined }),
      ).toThrow(AuditConfigError);
      expect(() => makeAuditService({ AUDIT_LOG_ENCRYPTION_KEY: '' })).toThrow(
        /AUDIT_LOG_ENCRYPTION_KEY is required/,
      );
    });

    it.each([
      ['too short', 'abcd'],
      [
        'the .env.example placeholder',
        'replace-with-64-hex-characters-from-openssl-rand-hex-32',
      ],
      ['31 bytes of hex', 'a'.repeat(62)],
    ])('refuses a key that is %s', (_label, key) => {
      expect(() => makeAuditService({ AUDIT_LOG_ENCRYPTION_KEY: key })).toThrow(
        /must be 32 bytes/,
      );
    });

    it('defaults retention to 365 days', () => {
      expect(makeAuditService().service.getRetentionDays()).toBe(
        DEFAULT_RETENTION_DAYS,
      );
      expect(DEFAULT_RETENTION_DAYS).toBe(365);
    });

    it('reads the retention period from config', () => {
      expect(
        makeAuditService({
          AUDIT_LOG_RETENTION_DAYS: '90',
        }).service.getRetentionDays(),
      ).toBe(90);
    });

    it.each(['0', '-5', '1.5', 'abc'])(
      'refuses the invalid retention %p',
      (days) => {
        expect(() =>
          makeAuditService({ AUDIT_LOG_RETENTION_DAYS: days }),
        ).toThrow(/AUDIT_LOG_RETENTION_DAYS/);
      },
    );
  });

  describe('recordSafely', () => {
    it('never throws, even when the database write fails', async () => {
      const { service, repository } = makeAuditService();
      repository.failSaveWith = new Error('database is down');
      const errors = jest
        .spyOn(
          (service as unknown as { logger: { error: () => void } }).logger,
          'error',
        )
        .mockImplementation();

      await expect(
        service.recordSafely({ action: 'x' }),
      ).resolves.toBeUndefined();

      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('database is down'),
      );
    });

    it('never throws for an invalid entry either', async () => {
      const { service } = makeAuditService();
      jest
        .spyOn(
          (service as unknown as { logger: { error: () => void } }).logger,
          'error',
        )
        .mockImplementation();

      await expect(
        service.recordSafely({ action: '' }),
      ).resolves.toBeUndefined();
    });

    it('writes the entry when everything works', async () => {
      const { service, repository } = makeAuditService();

      await service.recordSafely({ action: 'x', userId: 'u' });

      expect(repository.rows).toHaveLength(1);
    });
  });

  describe('searching', () => {
    async function populated() {
      const harness = makeAuditService();
      await seed(harness, [
        {
          userId: 'alice',
          action: 'POST /api/v1/savings/deposit',
          method: 'POST',
          endpoint: '/api/v1/savings/deposit',
          statusCode: 201,
          ipAddress: '203.0.113.1',
          ageDays: 5,
        },
        {
          userId: 'alice',
          action: 'GET /api/v1/goals/:id',
          method: 'GET',
          endpoint: '/api/v1/goals/:id',
          statusCode: 200,
          ipAddress: '203.0.113.1',
          ageDays: 3,
        },
        {
          userId: 'bob',
          action: 'POST /api/v1/goals',
          method: 'POST',
          endpoint: '/api/v1/goals',
          statusCode: 403,
          ipAddress: '198.51.100.2',
          ageDays: 1,
        },
        {
          userId: null,
          action: 'GET /api/v1/ping',
          method: 'GET',
          endpoint: '/api/v1/ping',
          statusCode: 200,
          ipAddress: '192.0.2.50',
          ageDays: 0,
        },
      ]);
      return harness.service;
    }

    it('returns everything, newest first, with decrypted fields', async () => {
      const service = await populated();

      const { items, total } = await service.search();

      expect(total).toBe(4);
      expect(items.map((i) => i.action)).toEqual([
        'GET /api/v1/ping',
        'POST /api/v1/goals',
        'GET /api/v1/goals/:id',
        'POST /api/v1/savings/deposit',
      ]);
      expect(items[1].ipAddress).toBe('198.51.100.2');
    });

    it('filters by user', async () => {
      const service = await populated();

      const { items } = await service.search({ userId: 'alice' });

      expect(items).toHaveLength(2);
      expect(items.every((i) => i.userId === 'alice')).toBe(true);
    });

    it('filters by action text, ignoring case', async () => {
      const service = await populated();

      const { items } = await service.search({ action: 'goals' });

      expect(items.map((i) => i.action)).toEqual([
        'POST /api/v1/goals',
        'GET /api/v1/goals/:id',
      ]);
      expect((await service.search({ action: 'SAVINGS' })).total).toBe(1);
    });

    it('filters by endpoint text', async () => {
      const service = await populated();

      expect((await service.search({ endpoint: '/deposit' })).total).toBe(1);
    });

    it('filters by method, case-insensitively', async () => {
      const service = await populated();

      expect((await service.search({ method: 'get' })).total).toBe(2);
    });

    it('filters by status code', async () => {
      const service = await populated();

      const { items } = await service.search({ statusCode: 403 });

      expect(items).toHaveLength(1);
      expect(items[0].userId).toBe('bob');
    });

    it('filters by IP address without decrypting rows', async () => {
      const service = await populated();

      const { items } = await service.search({ ip: '203.0.113.1' });

      expect(items).toHaveLength(2);
      expect(items.every((i) => i.ipAddress === '203.0.113.1')).toBe(true);
    });

    it('matches an IP given in IPv4-mapped form', async () => {
      const service = await populated();

      expect((await service.search({ ip: '::ffff:198.51.100.2' })).total).toBe(
        1,
      );
    });

    it('returns nothing for an IP that never appeared', async () => {
      const service = await populated();

      expect((await service.search({ ip: '10.9.8.7' })).total).toBe(0);
    });

    it('filters by a date range', async () => {
      const service = await populated();
      const now = Date.now();

      const between = await service.search({
        from: new Date(now - 4 * DAY),
        to: new Date(now - 2 * DAY),
      });
      expect(between.items.map((i) => i.action)).toEqual([
        'GET /api/v1/goals/:id',
      ]);

      expect(
        (await service.search({ from: new Date(now - 2 * DAY) })).total,
      ).toBe(2);
      expect(
        (await service.search({ to: new Date(now - 2 * DAY) })).total,
      ).toBe(2);
    });

    it('combines filters', async () => {
      const service = await populated();

      const { items } = await service.search({
        userId: 'alice',
        method: 'POST',
        statusCode: 201,
      });

      expect(items).toHaveLength(1);
      expect(items[0].endpoint).toBe('/api/v1/savings/deposit');
    });

    it('treats % and _ in a search as plain text, not wildcards', async () => {
      const service = await populated();

      expect((await service.search({ action: '%' })).total).toBe(0);
      expect((await service.search({ action: 'GET /api/v1/p_ng' })).total).toBe(
        0,
      );
      expect((await service.search({ action: 'p%g' })).total).toBe(0);
    });

    it('returns an empty page when nothing matches', async () => {
      const service = await populated();

      const result = await service.search({ userId: 'nobody' });

      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 50 });
    });

    describe('paging', () => {
      it('returns the requested page and the overall total', async () => {
        const service = await populated();

        const second = await service.search({}, 2, 3);

        expect(second.total).toBe(4);
        expect(second.page).toBe(2);
        expect(second.limit).toBe(3);
        expect(second.items.map((i) => i.action)).toEqual([
          'POST /api/v1/savings/deposit',
        ]);
      });

      it('caps the page size', async () => {
        const service = await populated();

        expect((await service.search({}, 1, 10_000)).limit).toBe(MAX_PAGE_SIZE);
      });

      it.each([0, -3, Number.NaN])(
        'falls back to page 1 for page %p',
        async (page) => {
          const service = await populated();

          expect((await service.search({}, page)).page).toBe(1);
        },
      );
    });
  });

  describe('endpoint access patterns', () => {
    it('summarises requests, users, errors and latency per endpoint', async () => {
      const { service, repository } = makeAuditService();
      repository.rawResult = [
        {
          method: 'POST',
          endpoint: '/api/v1/savings/deposit',
          requests: '120',
          uniqueUsers: '45',
          errors: '6',
          averageDurationMs: '83.4',
          lastAccessedAt: '2026-09-01T10:00:00.000Z',
        },
      ];

      const patterns = await service.getAccessPatterns();

      expect(patterns).toEqual([
        {
          method: 'POST',
          endpoint: '/api/v1/savings/deposit',
          requests: 120,
          uniqueUsers: 45,
          errors: 6,
          averageDurationMs: 83,
          lastAccessedAt: new Date('2026-09-01T10:00:00.000Z'),
        },
      ]);
    });

    it('groups by method and endpoint and ranks by request count', async () => {
      const { service, repository } = makeAuditService();

      await service.getAccessPatterns();

      const calls = repository.builderCalls.map(([name]) => name);
      expect(calls).toEqual(
        expect.arrayContaining(['groupBy', 'addGroupBy', 'orderBy']),
      );
      expect(repository.builderCalls).toContainEqual([
        'orderBy',
        'requests',
        'DESC',
      ]);
      expect(repository.builderCalls).toContainEqual(['limit', 20]);
    });

    it('applies user and time filters', async () => {
      const { service, repository } = makeAuditService();
      const from = new Date('2026-01-01');
      const to = new Date('2026-02-01');

      await service.getAccessPatterns({ userId: 'alice', from, to });

      const wheres = repository.builderCalls
        .filter(([name]) => name === 'andWhere')
        .map(([, clause]) => clause);
      expect(wheres).toEqual([
        'log.user_id = :userId',
        'log.created_at >= :from',
        'log.created_at <= :to',
      ]);
    });

    it('applies every advertised filter to endpoint access patterns', async () => {
      const { service, repository } = makeAuditService();
      const from = new Date('2026-01-01');
      const to = new Date('2026-02-01');

      await service.getAccessPatterns({
        userId: 'alice',
        action: 'deposit%',
        endpoint: '/savings/_',
        method: 'post',
        statusCode: 403,
        ip: '::ffff:203.0.113.9',
        from,
        to,
      });

      const conditions = repository.builderCalls.filter(
        ([name]) => name === 'andWhere',
      );
      expect(conditions).toEqual([
        ['andWhere', 'log.user_id = :userId', { userId: 'alice' }],
        ['andWhere', 'log.action ILIKE :action', { action: '%deposit\\%%' }],
        [
          'andWhere',
          'log.endpoint ILIKE :endpoint',
          { endpoint: '%/savings/\\_%' },
        ],
        ['andWhere', 'log.method = :method', { method: 'POST' }],
        ['andWhere', 'log.status_code = :statusCode', { statusCode: 403 }],
        [
          'andWhere',
          'log.ip_hash = :ipHash',
          { ipHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        ],
        ['andWhere', 'log.created_at >= :from', { from }],
        ['andWhere', 'log.created_at <= :to', { to }],
      ]);
    });

    it('clamps the number of endpoints returned', async () => {
      const { service, repository } = makeAuditService();

      await service.getAccessPatterns({}, 5000);
      await service.getAccessPatterns({}, 0);

      const limits = repository.builderCalls
        .filter(([name]) => name === 'limit')
        .map(([, value]) => value);
      expect(limits).toEqual([100, 20]);
    });

    it('returns an empty list when there is no traffic', async () => {
      const { service } = makeAuditService();

      await expect(service.getAccessPatterns()).resolves.toEqual([]);
    });
  });

  describe('exporting', () => {
    it('exports a header and one row per entry with every field decrypted', async () => {
      const harness = makeAuditService();
      await seed(harness, [
        {
          userId: 'alice',
          action: 'POST /api/v1/goals',
          method: 'POST',
          endpoint: '/api/v1/goals',
          statusCode: 201,
          durationMs: 17,
          ipAddress: '203.0.113.1',
          userAgent: 'TestAgent/1.0',
          metadata: { queryKeys: ['a'] },
        },
      ]);

      const csv = await harness.service.exportCsv();
      const [header, row] = csv.trimEnd().split('\r\n');

      expect(header).toBe(
        'id,timestamp,userId,action,method,endpoint,statusCode,durationMs,ipAddress,userAgent,metadata',
      );
      const saved = harness.repository.rows[0];
      expect(row).toBe(
        [
          saved.id,
          saved.createdAt.toISOString(),
          'alice',
          'POST /api/v1/goals',
          'POST',
          '/api/v1/goals',
          '201',
          '17',
          '203.0.113.1',
          'TestAgent/1.0',
          '"{""queryKeys"":[""a""]}"',
        ].join(','),
      );
    });

    it('exports only a header when there is nothing to export', async () => {
      const { service } = makeAuditService();

      const csv = await service.exportCsv();

      expect(csv.trimEnd().split('\r\n')).toHaveLength(1);
    });

    it('respects the same filters as search', async () => {
      const harness = makeAuditService();
      await seed(harness, [
        { userId: 'alice', action: 'a' },
        { userId: 'bob', action: 'b' },
      ]);

      const csv = await harness.service.exportCsv({ userId: 'bob' });

      expect(csv).toContain(',bob,b,');
      expect(csv).not.toContain('alice');
    });

    it('exports every row across batch boundaries', async () => {
      const harness = makeAuditService();
      await seed(
        harness,
        Array.from({ length: 2500 }, (_, i) => ({
          userId: 'u',
          action: `a${i}`,
        })),
      );

      const csv = await harness.service.exportCsv();

      expect(csv.trimEnd().split('\r\n')).toHaveLength(2501);
    });

    it('exports newest first', async () => {
      const harness = makeAuditService();
      await seed(harness, [
        { action: 'old', ageDays: 9 },
        { action: 'new', ageDays: 0 },
      ]);

      const lines = (await harness.service.exportCsv()).trimEnd().split('\r\n');

      expect(lines[1]).toContain(',new,');
      expect(lines[2]).toContain(',old,');
    });

    it('quotes commas, quotes and line breaks in cells', async () => {
      const harness = makeAuditService();
      await seed(harness, [
        { action: 'say "hi", please', userAgent: 'line1\nline2' },
      ]);

      const csv = await harness.service.exportCsv();

      expect(csv).toContain('"say ""hi"", please"');
      expect(csv).toContain('"line1\nline2"');
    });

    it('defuses spreadsheet formulas in exported text', async () => {
      const harness = makeAuditService();
      await seed(harness, [
        { action: '=HYPERLINK("http://evil")', userAgent: '+cmd|calc' },
      ]);

      const csv = await harness.service.exportCsv();

      expect(csv).not.toMatch(/,=HYPERLINK/);
      expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(csv).toContain(`'+cmd|calc`);
    });
  });

  describe('retention', () => {
    it('deletes entries older than the retention window and keeps the rest', async () => {
      const harness = makeAuditService({ AUDIT_LOG_RETENTION_DAYS: '30' });
      await seed(harness, [
        { action: 'ancient', ageDays: 400 },
        { action: 'old', ageDays: 31 },
        { action: 'recent', ageDays: 29 },
        { action: 'today', ageDays: 0 },
      ]);

      const deleted = await harness.service.purgeExpired();

      expect(deleted).toBe(2);
      expect(harness.repository.rows.map((r) => r.action).sort()).toEqual([
        'recent',
        'today',
      ]);
    });

    it('keeps an entry exactly at the boundary', async () => {
      const harness = makeAuditService({ AUDIT_LOG_RETENTION_DAYS: '10' });
      const now = new Date('2026-09-30T12:00:00Z');
      harness.repository.setClock(() => new Date(now.getTime() - 10 * DAY));
      await harness.service.record({ action: 'on the line' });

      expect(await harness.service.purgeExpired(now)).toBe(0);
      expect(
        await harness.service.purgeExpired(new Date(now.getTime() + 1)),
      ).toBe(1);
    });

    it('uses the default 365 day window when none is configured', async () => {
      const harness = makeAuditService();
      await seed(harness, [
        { action: 'last year', ageDays: 366 },
        { action: 'this year', ageDays: 364 },
      ]);

      await harness.service.purgeExpired();

      expect(harness.repository.rows.map((r) => r.action)).toEqual([
        'this year',
      ]);
    });

    it('returns 0 and deletes nothing when nothing has expired', async () => {
      const harness = makeAuditService();
      await seed(harness, [{ action: 'fresh' }]);

      expect(await harness.service.purgeExpired()).toBe(0);
      expect(harness.repository.rows).toHaveLength(1);
    });

    it('runs on a schedule and survives a failure', async () => {
      const harness = makeAuditService();
      const purge = jest
        .spyOn(harness.service, 'purgeExpired')
        .mockRejectedValueOnce(new Error('db gone'))
        .mockResolvedValue(3);
      jest
        .spyOn(
          (harness.service as unknown as { logger: { error: () => void } })
            .logger,
          'error',
        )
        .mockImplementation();

      await expect(
        harness.service.purgeExpiredOnSchedule(),
      ).resolves.toBeUndefined();
      await expect(
        harness.service.purgeExpiredOnSchedule(),
      ).resolves.toBeUndefined();

      expect(purge).toHaveBeenCalledTimes(2);
    });
  });
});

describe('sanitizeMetadata', () => {
  it('passes through plain values', () => {
    expect(sanitizeMetadata({ a: 1, b: true, c: 'x', d: null })).toEqual({
      a: 1,
      b: true,
      c: 'x',
      d: null,
    });
  });

  it('cuts long strings and long arrays', () => {
    const result = sanitizeMetadata({
      text: 'x'.repeat(900),
      list: Array.from({ length: 200 }, (_, i) => i),
    }) as { text: string; list: number[] };

    expect(result.text).toHaveLength(500);
    expect(result.list).toHaveLength(50);
  });

  it('caps nesting depth', () => {
    const deep = { a: { b: { c: { d: { e: 'bottom' } } } } };

    expect(JSON.stringify(sanitizeMetadata(deep))).toContain('[TRUNCATED]');
    expect(JSON.stringify(sanitizeMetadata(deep))).not.toContain('bottom');
  });

  it('turns bigint into text and drops functions and symbols', () => {
    expect(
      sanitizeMetadata({ big: BigInt(10), fn: () => 1, sym: Symbol('s') }),
    ).toEqual({ big: '10', fn: null, sym: null });
  });

  it.each([
    'password',
    'Password',
    'userPassword',
    'access_token',
    'x-api-key',
    'clientSecret',
    'sessionCookie',
    'sig',
    'otp',
    'pin',
  ])('redacts the key %p when it is sensitive', (key) => {
    const result = sanitizeMetadata({ [key]: 'value' }) as Record<
      string,
      unknown
    >;
    const expected = key === 'sig' ? 'value' : '[REDACTED]';
    expect(result[key]).toBe(expected);
  });
});

describe('normalizeIp', () => {
  it('strips the IPv4-mapped prefix and whitespace', () => {
    expect(normalizeIp(' ::ffff:10.0.0.1 ')).toBe('10.0.0.1');
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp('10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('csvCell', () => {
  it.each([
    [null, ''],
    [undefined, ''],
    [0, '0'],
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "x"', '"say ""x"""'],
    ['two\nlines', '"two\nlines"'],
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    [new Date('2026-01-02T03:04:05Z'), '2026-01-02T03:04:05.000Z'],
  ])('renders %p as %p', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
});
