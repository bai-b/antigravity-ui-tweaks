import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ui-tweaks-cust-'));
process.env.AGY_UI_TWEAKS_CONFIG_DIR = root;
process.env.AGY_UI_TWEAKS_APP_DATA = join(root, 'app');
const data = await import('../sidecars/theme/host-data.mjs');

test.after(() => rm(root, { recursive: true, force: true }));

async function write(path, value) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, value);
}

test('插件内组件一律由宿主管理，不改文件名', async () => {
  const skill = join(root, 'plugins', 'demo', 'skills', 'thing', 'SKILL.md');
  await write(skill, '# thing');
  const rows = await data.customizations([]);
  const row = rows.find((item) => item.name === 'thing');
  assert.equal(row.managed, 'host');
  const result = await data.toggleCustomization(row.key, [], false);
  assert.equal(result.changed, false);
  assert.equal(result.mode ?? result.managed, 'host');
  assert.equal((await stat(skill)).isFile(), true);
});

test('独立技能默认不动文件，明确离线停用才改名并可恢复', async () => {
  const skill = join(root, 'skills', 'loose', 'SKILL.md');
  await write(skill, '# loose');
  const row = (await data.customizations([])).find((item) => item.name === 'loose');
  assert.equal(row.managed, 'file');
  const hint = await data.toggleCustomization(row.key, [], false);
  assert.equal(hint.changed, false);
  assert.equal((await stat(skill)).isFile(), true);
  const offline = await data.toggleCustomization(row.key, [], false, 'file');
  assert.equal(offline.changed, true);
  assert.equal((await stat(skill + '.ui-tweaks-disabled')).isFile(), true);
  assert.equal((await data.customizations([])).find((item) => item.name === 'loose').disabled, true);
  const back = await data.toggleCustomization(row.key, [], true, 'file');
  assert.equal(back.changed, true);
  assert.equal((await stat(skill)).isFile(), true);
});

test('automationCommand 放宽参数顺序', () => {
  const a = data.automationCommand({ args: ['0 9 * * *', 'agentapi', 'new-conversation', '发日报', '--model', 'flash'] });
  assert.deepEqual([a.cron, a.message, a.model, a.problem], ['0 9 * * *', '发日报', 'flash', null]);
  const b = data.automationCommand({ args: ['0 9 * * *', 'node', 'new-conversation', '--model=pro', '写周报'] });
  assert.deepEqual([b.message, b.model, b.problem], ['写周报', 'pro', null]);
  const c = data.automationCommand({ args: ['0 9 * * *', 'node', 'new-conversation', '给 ${workspace} 写总结'] });
  assert.equal(c.problem, '消息里还有模板变量');
  const d = data.automationCommand({ args: ['0 9 * * *', 'node', 'close-conversation'] });
  assert.equal(d.problem, '命令里没有 new-conversation');
});

test('automations 用新的可运行判定并给出原因', async () => {
  await write(join(root, 'sidecars', 'demo', 'sidecar.json'), JSON.stringify({
    builtin: 'schedule', display_name: '日报',
    args: ['0 9 * * *', 'node', 'new-conversation', '--model', 'flash', '发日报'],
  }));
  await write(join(root, 'config.json'), JSON.stringify({ sidecars: {} }));
  const idle = (await data.automations()).find((row) => row.id === 'demo');
  assert.equal(idle.runnable, false);
  assert.equal(idle.reason, '已停用');
  await write(join(root, 'config.json'), JSON.stringify({ sidecars: { demo: { enabled: true, projectId: 'p1' } } }));
  const ready = (await data.automations()).find((row) => row.id === 'demo');
  assert.equal(ready.runnable, true);
  assert.equal(ready.reason, null);
  await write(join(root, 'sidecars', 'demo', 'sidecar.json'), JSON.stringify({
    builtin: 'schedule', args: ['0 9 * * *', 'definitely-missing-binary', 'new-conversation', '跑一下'],
  }));
  const missing = (await data.automations()).find((row) => row.id === 'demo');
  assert.equal(missing.runnable, false);
  assert.match(missing.reason, /找不到程序/);
});