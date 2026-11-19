import { createHash, randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { open, mkdir, readFile, readdir, realpath, rename, stat, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable } from './mcp-health.mjs';
import { appData, configDir, object, privateDir, readJson, settingsPath, updateJson } from './storage.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const audit = join(privateDir, 'hooks.jsonl');
const hooksFile = join(configDir, 'hooks.json');
const settingsGroup = 'antigravity-ui-tweaks-audit';

async function list(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function text(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readSlice(path, bytes, tail = false) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, bytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, tail ? Math.max(0, size - bytes) : 0);
    return { size, text: buffer.subarray(0, bytesRead).toString('utf8'), truncated: size > bytes };
  } finally { await file.close(); }
}

async function queries(path, read) {
  try { await stat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

export async function conversations() {
  return await queries(join(appData, 'conversation_summaries.db'), (db) => db.prepare(`
    SELECT conversation_id AS id, title, last_modified_time AS modified, project_id AS project,
           workspace_uris AS workspaces, step_count AS steps, status
    FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 500
  `).all().filter((row) => uuid.test(row.id))) || [];
}

function parseLines(raw) {
  return raw.split(/\r?\n/).flatMap((line) => {
    try { const value = JSON.parse(line); return object(value) ? [value] : []; }
    catch { return []; }
  });
}

function transcriptEntry(step) {
  return {
    index: step.step_index, type: step.type, status: step.status, time: step.created_at,
    content: typeof step.content === 'string' ? step.content.slice(0, 24_000) : '',
    tools: (Array.isArray(step.tool_calls) ? step.tool_calls : []).map((call) => String(call.name || '').slice(0, 150)),
    input: Number.isFinite(step.input_tokens) ? step.input_tokens : null,
    cache: Number.isFinite(step.cache_read_tokens) ? step.cache_read_tokens : null,
    output: Number.isFinite(step.output_tokens) ? step.output_tokens : null,
  };
}

export async function conversation(id) {
  if (!uuid.test(id || '')) throw new Error('会话 ID 无效。');
  const summary = await queries(join(appData, 'conversation_summaries.db'), (db) => db.prepare(
    'SELECT title, project_id AS project FROM conversation_summaries WHERE conversation_id = ?',
  ).get(id));
  let source;
  try {
    source = await readSlice(join(appData, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), 4_000_000, true);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!source) {
    const chunks = await queries(join(appData, 'conversation_summaries.db'), (db) => {
      const hasIndex = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'conversations_fts'").get();
      return hasIndex ? db.prepare(`
        SELECT chunk_index AS idx, substr(user_body,1,12000) AS user, substr(agent_body,1,12000) AS agent
        FROM conversations_fts WHERE conversation_id = ? ORDER BY chunk_index DESC LIMIT 80
      `).all(id).reverse() : [];
    });
    const entries = (chunks || []).flatMap((row) => [
      { index: row.idx, type: '用户索引片段', content: row.user, tools: [] },
      { index: row.idx, type: '助手索引片段', content: row.agent, tools: [] },
    ].filter((step) => step.content));
    return { id, title: summary?.title || '未命名会话', entries, source: '搜索索引（片段）', truncated: true };
  }
  const raw = parseLines(source.truncated ? source.text.replace(/^[^\n]*\n/, '') : source.text);
  const entries = raw.slice(-700).map(transcriptEntry);
  const totals = { input: 0, cache: 0, output: 0, recorded: 0 };
  for (const step of entries) {
    if (step.input === null && step.cache === null && step.output === null) continue;
    totals.recorded++;
    for (const key of ['input', 'cache', 'output']) totals[key] += step[key] ?? 0;
  }
  return {
    id, title: summary?.title || '未命名会话', entries, source: '本机会话日志',
    truncated: source.truncated || raw.length > entries.length || raw.some((step) => step.content?.length > 24_000),
    totals: totals.recorded ? totals : null,
  };
}

function cronValues(field, min, max, aliases = []) {
  const values = new Set();
  const parse = (item) => {
    const alias = aliases.indexOf(item.toLowerCase());
    const value = alias < 0 ? (/^\d+$/.test(item) ? Number(item) : NaN) : alias + min;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error('不支持此 cron 字段。');
    return value;
  };
  for (const token of field.split(',')) {
    const [range, stride = '1', extra] = token.split('/');
    const step = Number(stride);
    if (extra || !Number.isInteger(step) || step <= 0) throw new Error('无效的 cron 步长。');
    let first = min;
    let last = max;
    if (range !== '*') {
      const [lower, upper, overflow] = range.split('-');
      if (overflow) throw new Error('无效的 cron 范围。');
      first = parse(lower);
      last = upper !== undefined ? parse(upper) : token.includes('/') ? max : first;
      if (last < first) throw new Error('无效的 cron 范围。');
    }
    for (let value = first; value <= last; value += step) values.add(value);
  }
  return values;
}

export function nextCron(expression, now = Date.now()) {
  const parts = expression.trim().split(/\s+/);
  const zone = parts[0]?.startsWith('CRON_TZ=') ? parts.shift().slice(8) : undefined;
  if (parts.length !== 5) throw new Error('需要五字段 cron 表达式。');
  const [minutes, hours, days, months, weekdays] = parts;
  const weekNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const matchMinute = cronValues(minutes, 0, 59);
  const matchHour = cronValues(hours, 0, 23);
  const matchDay = cronValues(days, 1, 31);
  const matchMonth = cronValues(months, 1, 12, ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
  const matchWeek = cronValues(weekdays, 0, 7, weekNames);
  const format = zone && new Intl.DateTimeFormat('en-US', {
    timeZone: zone, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
  const start = Math.floor(now / 60_000) * 60_000 + 60_000;
  const maximum = start + 370 * 86400_000;
  for (let time = start; time < maximum; time += 60_000) {
    const date = new Date(time);
    // Convert configured zones only at candidate UTC minute offsets. Modern time zones use whole quarter-hours.
    if (format ? ![0, 15, 30, 45].some((offset) => matchMinute.has((date.getUTCMinutes() + offset) % 60))
      : !matchMinute.has(date.getMinutes())) continue;
    let hour = date.getHours();
    let minute = date.getMinutes();
    let day = date.getDate();
    let month = date.getMonth() + 1;
    let weekday = date.getDay();
    if (format) {
      const stamp = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]));
      day = Number(stamp.day); month = Number(stamp.month); hour = Number(stamp.hour);
      weekday = weekNames.indexOf(stamp.weekday.toLowerCase());
      minute = Number(stamp.minute);
    }
    const byDay = matchDay.has(day);
    const byWeek = matchWeek.has(weekday) || (weekday === 0 && matchWeek.has(7));
    const dayMatches = !days.startsWith('*') && !weekdays.startsWith('*') ? byDay || byWeek : byDay && byWeek;
    if (matchMinute.has(minute) && matchHour.has(hour) && matchMonth.has(month) && dayMatches) return new Date(time).toISOString();
  }
  return null;
}

export function automationCommand(config) {
  const parts = (Array.isArray(config?.args) ? config.args : []).map((value) => String(value));
  const [cron, executable] = parts;
  const rest = parts.slice(2);
  const index = rest.findIndex((token) => token === 'new-conversation');
  const tail = index < 0 ? rest : rest.slice(index + 1);
  const values = [];
  const options = {};
  for (let position = 0; position < tail.length; position += 1) {
    const token = tail[position];
    if (token === '--') { values.push(...tail.slice(position + 1)); break; }
    const inline = /^--([a-z][a-z0-9-]*)=(.*)$/s.exec(token);
    if (inline) { options[inline[1]] = inline[2]; continue; }
    if (/^--[a-z][a-z0-9-]*$/.test(token)) {
      const next = tail[position + 1];
      if (next !== undefined && !next.startsWith('--')) { options[token.slice(2)] = next; position += 1; }
      else options[token.slice(2)] = true;
      continue;
    }
    values.push(token);
  }
  const message = values.join(' ').trim();
  const problem = index < 0 ? '命令里没有 new-conversation'
    : !executable ? '缺少可执行文件'
    : !message ? '缺少消息内容'
    : /\$\{/.test(message) ? '消息里还有模板变量'
    : null;
  return { cron, executable, operation: index < 0 ? '' : 'new-conversation', message, model: typeof options.model === 'string' ? options.model : undefined, problem };
}

async function automationEntries() {
  const settings = await readJson(settingsPath);
  const pluginRoot = join(configDir, 'plugins');
  const roots = [{ directory: join(configDir, 'sidecars'), prefix: '' }];
  for (const plugin of await list(pluginRoot)) {
    if (plugin.isDirectory()) roots.push({ directory: join(pluginRoot, plugin.name, 'sidecars'), prefix: plugin.name + '/' });
  }
  const entries = [];
  for (const { directory, prefix } of roots) {
    for (const dir of await list(directory)) {
      if (!dir.isDirectory()) continue;
      let config;
      try { config = await readJson(join(directory, dir.name, 'sidecar.json')); }
      catch { continue; }
      if (config.builtin !== 'schedule' || !Array.isArray(config.args)) continue;
      const id = prefix + dir.name;
      const enabled = settings.sidecars?.[id]?.enabled === true;
      const projectId = settings.sidecars?.[id]?.projectId;
      const command = automationCommand(config);
      const found = command.executable ? Boolean(await findExecutable(command.executable, directory)) : false;
      const reason = !enabled ? '已停用' : !projectId ? '缺少项目'
        : command.problem || (!found ? '找不到程序 ' + command.executable : null);
      entries.push({ id, title: config.display_name || id, enabled, cron: command.cron, runnable: !reason, reason,
        projectId, message: command.message, model: command.model });
    }
  }
  return entries;
}

export async function automations() {
  return (await automationEntries()).map(({ message, model, projectId, ...row }) => {
    try { return { ...row, next: row.enabled && row.cron ? nextCron(row.cron) : null }; }
    catch (error) { return { ...row, next: null, scheduleError: error.message }; }
  });
}

async function findAutomation(id) {
  const record = (await automationEntries()).find((row) => row.id === id);
  if (!record) throw new Error('自动化任务不存在。');
  return record;
}

export async function runAutomation(app, id) {
  const job = await findAutomation(id);
  if (!job.runnable) throw new Error('这个任务不能手动运行：' + (job.reason || '需要宿主 Automations') + '。');
  await app.startConversation(job.message, { model: job.model, projectId: job.projectId });
  return { ok: true };
}

export async function automationLog(id) {
  await findAutomation(id);
  const directory = join(appData, 'sidecar_data', id, 'logs');
  const candidates = await Promise.all((await list(directory)).filter((file) => file.isFile()).map(async (file) => {
    try { return { path: join(directory, file.name), time: (await stat(join(directory, file.name))).mtimeMs }; }
    catch { return null; }
  }));
  const latest = candidates.filter(Boolean).sort((a, b) => b.time - a.time)[0];
  if (!latest) return { text: '', modified: null };
  const source = await readSlice(latest.path, 30_000, true);
  return { text: source.text, modified: new Date(latest.time).toISOString(), truncated: source.truncated };
}

function workspacePath(uri) {
  try { return fileURLToPath(uri); } catch { return null; }
}

async function customizationEntries(uris) {
  const roots = [{ root: configDir, scope: '全局' }];
  for (const uri of Array.isArray(uris) ? uris.slice(0, 16) : []) {
    const root = workspacePath(uri);
    if (root) roots.push({ root: join(root, '.agents'), scope: basename(root) });
  }
  for (const dir of await list(join(configDir, 'plugins'))) {
    if (dir.isDirectory()) roots.push({ root: join(configDir, 'plugins', dir.name), scope: dir.name, plugin: true });
  }
  const entries = [];
  for (const { root, scope, plugin } of roots) {
    for (const dir of await list(join(root, 'skills'))) {
      if (!dir.isDirectory()) continue;
      const files = new Set((await list(join(root, 'skills', dir.name))).filter((item) => item.isFile()).map((file) => file.name));
      if (files.has('SKILL.md') || files.has('SKILL.md.ui-tweaks-disabled')) {
        entries.push({ name: dir.name, path: join(root, 'skills', dir.name, 'SKILL.md'), type: 'Skill',
          scope, plugin, managed: plugin ? 'host' : 'file', disabled: !files.has('SKILL.md') });
      }
    }
    for (const file of await list(join(root, 'rules'))) {
      if (file.isFile() && /\.md(?:\.ui-tweaks-disabled)?$/i.test(file.name)) {
        const name = file.name.replace(/\.ui-tweaks-disabled$/, '');
        entries.push({ name, path: join(root, 'rules', name), type: '规则', scope, plugin,
          managed: plugin ? 'host' : 'file', disabled: name !== file.name });
      }
    }
  }
  return entries.map((row) => ({ ...row, key: createHash('sha256').update(row.path).digest('hex').slice(0, 20) }));
}

export async function customizations(uris) {
  return (await customizationEntries(uris)).map(({ path, ...row }) => row);
}

export async function toggleCustomization(key, uris, enabled, mode = 'host') {
  if (typeof enabled !== 'boolean') throw new Error('请指定启停状态。');
  const row = (await customizationEntries(uris)).find((entry) => entry.key === key);
  if (!row) throw new Error('找不到这条规则或技能。');
  if (row.managed === 'host') {
    return { ok: true, changed: false, managed: 'host',
      note: '插件与内置组件的启停由宿主管理：在 Customizations 面板或聊天里的 customization:// 链接切换，这里不改动文件。' };
  }
  if (mode !== 'file') {
    return { ok: true, changed: false, managed: 'file',
      note: '这条规则或技能默认跟随宿主的 Customizations 开关。确认要改文件名离线停用时，再选「离线停用」。' };
  }
  if (row.disabled !== enabled) return { ok: true, changed: false, managed: 'file', note: '状态已经是目标值。' };
  const alternate = row.path + '.ui-tweaks-disabled';
  const [from, to] = enabled ? [alternate, row.path] : [row.path, alternate];
  const canonical = await realpath(from);
  if (normalize(canonical).toLowerCase() !== normalize(from).toLowerCase()) throw new Error('请在真实工作区路径操作。');
  if (await stat(to).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))) throw new Error('目标文件已存在。');
  await rename(from, to);
  return { ok: true, changed: true, managed: 'file', offline: !enabled,
    note: enabled ? '已恢复加载。' : '已离线停用：宿主面板可能仍显示为已启用。' };
}

const startBlock = '<!-- antigravity-ui-tweaks:start -->';
const endBlock = '<!-- antigravity-ui-tweaks:end -->';
const blockPattern = /(?:\r?\n){0,2}<!-- antigravity-ui-tweaks:start -->\r?\n[\s\S]*?\r?\n<!-- antigravity-ui-tweaks:end -->(?:\r?\n)?/g;

async function replaceText(path, original, updated) {
  if (updated === original || (updated === '' && original === null)) return;
  if (original !== null) {
    const folder = join(privateDir, 'backups');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, randomUUID() + '-' + basename(path)), original, { flag: 'wx' });
  }
  const temporary = join(dirname(path), '.ui-tweaks-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, updated, { flag: 'wx' });
    if (await text(path) !== original) throw new Error('原文件刚刚发生修改。请刷新后重试。');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function agentsFragment(uri, content) {
  const root = workspacePath(uri);
  if (!root || !(await stat(root)).isDirectory()) throw new Error('请选择本地工作区文件夹。');
  const path = join(await realpath(root), 'AGENTS.md');
  const original = await text(path);
  const matches = [...(original || '').matchAll(blockPattern)];
  if (content === undefined) {
    return { content: matches[0]?.[0].split(startBlock)[1].split(endBlock)[0].trim() || '' };
  }
  if (original !== null && normalize(await realpath(path)).toLowerCase() !== normalize(path).toLowerCase()) {
    throw new Error('AGENTS.md 是指向其他路径的链接。');
  }
  if (typeof content !== 'string' || /<!-- antigravity-ui-tweaks:/.test(content) || content.length > 12_000) {
    throw new Error('规则片段无效或超过 12000 字符。');
  }
  if (!content.trim() && !matches.length) return { ok: true };
  const withBlock = content.trim() ? '\n\n' + startBlock + '\n' + content.trim() + '\n' + endBlock + '\n' : '';
  const base = original || '';
  const updated = matches.length ? base.replace(blockPattern, () => withBlock) : base + withBlock;
  await replaceText(path, original, updated);
  return { ok: true };
}

export async function hookReport(workspaceUris = []) {
  let events = [];
  try {
    const data = await readSlice(audit, 240_000, true);
    events = parseLines(data.truncated ? data.text.replace(/^[^\n]*\n/, '') : data.text).slice(-250).reverse();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sources = [];
  const global = await readJson(hooksFile);
  const configs = [{ scope: '全局', data: global }];
  const pluginRoot = join(configDir, 'plugins');
  for (const plugin of await list(pluginRoot)) {
    if (plugin.isDirectory()) configs.push({
      scope: plugin.name, data: await readJson(join(pluginRoot, plugin.name, 'hooks.json')).catch(() => ({})),
    });
  }
  for (const uri of Array.isArray(workspaceUris) ? workspaceUris.slice(0, 16) : []) {
    const root = workspacePath(uri);
    if (root) configs.push({
      scope: basename(root), data: await readJson(join(root, '.agents', 'hooks.json')).catch(() => ({})),
    });
  }
  for (const { scope, data } of configs) {
    for (const [name, group] of Object.entries(data)) {
      if (object(group)) sources.push({
        name, scope, enabled: group.enabled !== false, events: Object.keys(group).filter((key) => Array.isArray(group[key])),
      });
    }
  }
  return { enabled: Boolean(global[settingsGroup] && global[settingsGroup].enabled !== false), events, sources };
}

export async function setAuditEnabled(enabled, workspaceUris) {
  if (typeof enabled !== 'boolean') throw new Error('无效的审计状态。');
  await updateJson(hooksFile, (config) => {
    if (!enabled) {
      delete config[settingsGroup];
      return;
    }
    const script = fileURLToPath(new URL('./hook-audit.mjs', import.meta.url));
    const quote = (path) => '"' + path.replaceAll('\\', '/') + '"';
    const command = (phase) => ({
      type: 'command', command: quote(process.execPath) + ' ' + quote(script) + ' ' + phase, timeout: 4,
    });
    // 只观测不表态：PreToolUse 的 decision 会接管权限流程（allow 等于自动放行），
    // 因此审计只订阅 PostToolUse 与 SessionStart，二者按契约返回空对象。
    config[settingsGroup] = {
      SessionStart: [command('SessionStart')],
      PostToolUse: [{ matcher: '*', hooks: [command('PostToolUse')] }],
    };
  });
  return hookReport(workspaceUris);
}

export async function systemHealth() {
  const sidecars = join(appData, 'sidecar_data');
  let visited = 0;
  let bytes = 0;
  const dirs = [sidecars];
  while (dirs.length && visited < 6000) {
    for (const entry of await list(dirs.pop())) {
      if (++visited > 6000) break;
      const path = join(entry.parentPath, entry.name);
      if (entry.isDirectory()) dirs.push(path);
      else if (entry.isFile()) bytes += (await stat(path).catch(() => null))?.size || 0;
    }
  }
  return { node: process.version, platform: process.platform, cores: cpus().length, bytes, partial: visited > 6000 || dirs.length > 0 };
}
