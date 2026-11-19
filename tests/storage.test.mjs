import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ui-tweaks-storage-'));
process.env.AGY_UI_TWEAKS_CONFIG_DIR = root;
const { updateJson } = await import('../sidecars/theme/storage.mjs');
const target = join(root, 'config.json');

test('updateJson 无变化时不重写文件', async () => {
  await writeFile(target, '{"keep":true}\n');
  const before = await readFile(target, 'utf8');
  await updateJson(target, () => {});
  assert.equal(await readFile(target, 'utf8'), before);
});

test('updateJson 保留其它键并写入缩进 JSON', async () => {
  await updateJson(target, (document) => { document.sidecars = { 'antigravity-ui-tweaks/theme': { enabled: true } }; });
  const document = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(document.keep, true);
  assert.equal(document.sidecars['antigravity-ui-tweaks/theme'].enabled, true);
});

test('updateJson 备份原文到 .ui-tweaks-backups', async () => {
  await updateJson(target, (document) => { document.themeMode = 'THEME_MODE_DARK'; }, { backup: true });
  const files = await readdir(join(root, '.ui-tweaks-backups'));
  assert.equal(files.length, 1);
  const backup = JSON.parse(await readFile(join(root, '.ui-tweaks-backups', files[0]), 'utf8'));
  assert.equal(backup.themeMode, undefined);
});

test('updateJson 在文件不是对象时报错', async () => {
  const bad = join(root, 'bad.json');
  await writeFile(bad, '[]');
  await assert.rejects(() => updateJson(bad, (document) => { document.x = 1; }), /JSON 对象/);
});

test('updateJson 串行化同一文件的并发写入', async () => {
  const counter = join(root, 'counter.json');
  await writeFile(counter, '{"n":0}\n');
  await Promise.all(Array.from({ length: 8 }, () => updateJson(counter, (document) => { document.n += 1; }, { backup: true })));
  assert.equal(JSON.parse(await readFile(counter, 'utf8')).n, 8);
});