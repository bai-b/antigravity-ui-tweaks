import assert from 'node:assert/strict';
import test from 'node:test';

import { nextCron } from '../sidecars/theme/host-data.mjs';

const now = Date.UTC(2026, 10, 19, 4, 0, 0); // 2026-11-19 12:00 上海时间，周四

test('nextCron 在显式时区算每日固定时刻', () => {
  assert.equal(nextCron('CRON_TZ=UTC 0 9 * * *', now), '2026-11-19T09:00:00.000Z');
  assert.equal(nextCron('CRON_TZ=Asia/Shanghai 0 9 * * *', now), '2026-11-20T01:00:00.000Z');
  assert.equal(nextCron('CRON_TZ=UTC 30 7 * * *', now), '2026-11-19T07:30:00.000Z');
});

test('nextCron 支持步进与星期范围', () => {
  assert.equal(nextCron('CRON_TZ=UTC */15 * * * *', now), '2026-11-19T04:15:00.000Z');
  assert.equal(nextCron('CRON_TZ=UTC 0 9 * * mon-fri', now), '2026-11-19T09:00:00.000Z');
  assert.equal(nextCron('CRON_TZ=UTC 0 9 * * sat', now), '2026-11-21T09:00:00.000Z');
});

test('nextCron 处理限制日期', () => {
  assert.equal(nextCron('CRON_TZ=UTC 0 9 1 * *', now), '2026-12-01T09:00:00.000Z');
});

test('nextCron 不指定时区时按本机时区', () => {
  const next = nextCron('0 9 * * *', now);
  assert.match(next, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  assert.equal(new Date(next).getHours(), 9);
  assert.equal(new Date(next).getMinutes(), 0);
  assert.ok(Date.parse(next) > now);
});

test('nextCron 拒绝非法表达式', () => {
  assert.throws(() => nextCron('0 9 * *', now), /五字段/);
  assert.throws(() => nextCron('70 9 * * *', now), /cron/);
});