import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, privateDir } from './storage.mjs';

const phase = process.argv[2];
const recordable = ['PostToolUse', 'SessionStart'];
try {
  const settings = JSON.parse(readFileSync(join(configDir, 'hooks.json'), 'utf8').replace(/^\uFEFF/, ''));
  const hook = settings['antigravity-ui-tweaks-audit'];
  if (hook && hook.enabled !== false && recordable.includes(phase)) {
    const event = JSON.parse(readFileSync(0, 'utf8'));
    const rawTool = event.toolCall?.name || event.tool_name || event.toolName || event.tool?.name || '';
    const tool = phase === 'SessionStart' ? '会话开始'
      : typeof rawTool === 'string' && /^[\w.:-]{1,120}$/.test(rawTool) ? rawTool : '未知工具';
    const outcome = phase === 'SessionStart' ? 'started'
      : event.decision || event.status || (event.error ? 'error' : 'completed');
    const record = {
      time: new Date().toISOString(), phase, tool, step: Number.isInteger(event.stepIdx) ? event.stepIdx : undefined,
      status: typeof outcome === 'string' && /^[a-zA-Z_]{1,40}$/.test(outcome) ? outcome : '',
    };
    mkdirSync(privateDir, { recursive: true });
    const path = join(privateDir, 'hooks.jsonl');
    try {
      if (statSync(path).size > 3_000_000) renameSync(path, path + '.previous');
    } catch { /* append even if another hook just rotated the log */ }
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
  }
} catch { /* audit failures must not interfere with the agent */ }
// 审计只观测，不改权限：PreToolUse 的 decision 会直接接管放行流程，本插件不再订阅它。
// 旧配置若仍触发 PreToolUse，这里保持沉默，交给宿主默认权限流程。
if (phase === 'PreToolUse') process.exit(0);
process.stdout.write('{}\n');
