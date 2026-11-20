import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { object, privateDir, readJson, serialize, settingsPath, updateJson } from './storage.mjs';
import { buildCss, color, colorTokens, normalizePack } from './palette.mjs';
import { applyRenderer, captureRenderer, probeRenderer, rendererTargets } from './renderer.mjs';
import { describeMcp, inspectMcp } from './mcp-health.mjs';
import {
  agentsFragment, automationLog, automations, conversation, conversations,
  customizations, hookReport, runAutomation, setAuditEnabled, systemHealth, toggleCustomization,
} from './host-data.mjs';

if (!process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN) throw new Error('缺少 Antigravity Sidecar UI token。');

// 宿主按退出码做退避重启：一次漏接的异步异常就让整个面板掉线，这里只记录不退出。
process.on('unhandledRejection', (error) => {
  console.error('[sidecar] unhandled rejection:', error && error.stack ? error.stack : error);
});
process.on('uncaughtException', (error) => {
  console.error('[sidecar] uncaught exception:', error && error.stack ? error.stack : error);
});

const here = dirname(fileURLToPath(import.meta.url));
const optionsPath = join(privateDir, 'options.json');
const app = new SidecarApp();
const histories = new Map();
const applying = new Map();
const themeKeys = { light: 'customThemeSeedsLight', dark: 'customThemeSeedsDark' };
const themeModes = ['THEME_MODE_LIGHT', 'THEME_MODE_DARK', 'THEME_MODE_SYSTEM'];

const assetHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

for (const [path, file, type] of [
  ['/styles.css', 'styles.css', 'text/css'],
  ['/app.js', 'app.js', 'application/javascript'],
  ['/panel-tools.mjs', 'panel-tools.mjs', 'application/javascript'],
  ['/palette.mjs', 'palette.mjs', 'application/javascript'],
]) {
  app.page(path, async () => new Response(await readFile(join(here, file), 'utf8'), {
    contentType: type + '; charset=utf-8',
    headers: assetHeaders,
  }));
}

// 宿主的 plugin:// 代理会用 401 拒掉 iframe 里的 module 子资源请求，因此面板只加载
// 一个内联样式的 HTML 加一个经典脚本；脚本由三个模块去掉 import/export 后拼成。
let panelCache = null;

function stripModuleSyntax(source) {
  return source
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/[^']+';?\s*$/gm, '')
    .replace(/^import[^\n]*from\s*'\.\/[^']+';?\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function|const|let|var|class)/gm, '');
}

async function panel() {
  if (panelCache) return panelCache;
  const parts = [];
  for (const file of ['palette.mjs', 'panel-tools.mjs', 'app.js']) {
    parts.push('// ---- ' + file + ' ----', stripModuleSyntax(await readFile(join(here, file), 'utf8')));
  }
  const bundle = '(function () {\n' + parts.join('\n') + '\n})();\n';
  const css = await readFile(join(here, 'styles.css'), 'utf8');
  const page = await readFile(join(here, 'index.html'), 'utf8');
  const styled = page.replace('<link rel="stylesheet" href="/styles.css">',
    () => '<style>\n' + css + '\n</style>');
  const html = styled.replace('<script type="module" src="/app.js"></script>',
    () => '<script src="/bundle.js"></script>');
  if (styled === page || html === styled) throw new Error('index.html 缺少样式或脚本占位，面板无法打包。');
  panelCache = { bundle, html };
  return panelCache;
}

app.page('/', async () => new Response((await panel()).html, {
  contentType: 'text/html; charset=utf-8',
  headers: assetHeaders,
}));

app.page('/bundle.js', async () => new Response((await panel()).bundle, {
  contentType: 'application/javascript; charset=utf-8',
  headers: assetHeaders,
}));

function route(path, handler) {
  app.api('/api/' + path, async (body) => {
    try { return await handler(body); }
    catch (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message || '操作失败。' }), {
        status: 400, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' },
      });
    }
  });
}

function getSettings(config) {
  const settings = config.userSettings ?? {};
  if (!object(settings)) throw new Error('config.json 的 userSettings 应为对象。');
  return settings;
}

function seeds(input) {
  if (input === undefined) return {};
  if (!object(input)) throw new Error('主题种子应为对象。');
  return Object.fromEntries(['background', 'foregroundOverride', 'primary']
    .filter((name) => input[name])
    .map((name) => [name, color(input[name])]));
}

function optionsView(options) {
  return {
    packs: Array.isArray(options.packs) ? options.packs : [],
    projectPacks: Array.isArray(options.projectPacks) ? options.projectPacks : [],
    schedule: object(options.schedule) ? options.schedule : {},
  };
}

route('state', async () => {
  const options = optionsView(await readJson(optionsPath));
  try {
    const settings = getSettings(await readJson(settingsPath));
    return { ...options, themeMode: settings.themeMode || '', tokens: colorTokens,
      light: settings[themeKeys.light] || {}, dark: settings[themeKeys.dark] || {} };
  } catch {
    return { ...options, themeMode: '', tokens: colorTokens, configError: '无法解析宿主主题配置。写入前应检查 config.json。' };
  }
});

route('theme', async ({ themeMode, light, dark }) => {
  if (themeMode && !themeModes.includes(themeMode)) throw new Error('未知主题模式。');
  const values = { light: seeds(light), dark: seeds(dark) };
  const config = await updateJson(settingsPath, (document) => {
    document.userSettings = getSettings(document);
    if (themeMode) document.userSettings.themeMode = themeMode;
    for (const [mode, key] of Object.entries(themeKeys)) {
      if (Object.keys(values[mode]).length) {
        const before = document.userSettings[key] ?? {};
        if (!object(before)) throw new Error('宿主主题种子结构不符合预期。');
        document.userSettings[key] = { ...before, ...values[mode] };
      }
    }
  }, { backup: true });
  return { ok: true, themeMode: config.userSettings.themeMode || '' };
});

route('pack', async ({ pack }) => {
  const normalized = normalizePack(pack);
  const updated = await updateJson(optionsPath, (options) => {
    const { packs } = optionsView(options);
    options.packs = [normalized, ...packs.filter((item) => item.name !== normalized.name)].slice(0, 40);
  });
  return optionsView(updated);
});

route('workspace-pack', async ({ workspace, name }) => {
  if (typeof workspace !== 'string' || !workspace || workspace.length > 10_000) throw new Error('当前会话没有工作区。');
  const updated = await updateJson(optionsPath, (options) => {
    const { packs, projectPacks } = optionsView(options);
    if (name && !packs.some((pack) => pack.name === name)) throw new Error('请先保存主题配方。');
    const previous = projectPacks.filter((item) => item.workspace !== workspace);
    options.projectPacks = (name ? [{ workspace, name }, ...previous] : previous).slice(0, 100);
  });
  return optionsView(updated);
});

route('theme-schedule', async ({ mode, day, night, dayAt, nightAt }) => {
  if (!['off', 'system', 'clock'].includes(mode)) throw new Error('未知切换方式。');
  const updated = await updateJson(optionsPath, (options) => {
    const { packs } = optionsView(options);
    if (mode !== 'off' && ![day, night].every((name) => packs.some((pack) => pack.name === name))) {
      throw new Error('请为浅色和深色各选择一套已保存的配方。');
    }
    if (mode === 'clock' && (![dayAt, nightAt].every((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) || dayAt === nightAt)) {
      throw new Error('请选择两个不同的切换时间。');
    }
    options.schedule = { mode, day, night, dayAt, nightAt };
  });
  return optionsView(updated);
});

route('targets', async () => ({ targets: await rendererTargets() }));
route('probe', (body) => probeRenderer(body));
route('css', ({ style }) => ({ css: buildCss(style) }));
route('capture', async (body) => ({ png: await captureRenderer(body) }));

route('history', ({ targetId }) => ({
  history: (histories.get(targetId) || []).map(({ id, time, label }) => ({ id, time, label })),
}));

route('inject', ({ targetId, conversationId, style, clear, restore, name }) => {
  if (typeof targetId !== 'string' || !targetId) throw new Error('请选择渲染窗口。');
  return serialize(applying, targetId, async () => {
    const history = histories.get(targetId) || [];
    const revision = restore && history.find((item) => item.id === restore);
    if (restore && !revision) throw new Error('该样式记录已经失效。');
    const css = clear === true ? '' : revision ? revision.css : buildCss(style);
    const bytes = await applyRenderer({ targetId, conversationId }, css);
    const applied = (typeof name === 'string' && name.trim().slice(0, 60)) || '临时样式';
    const label = revision ? '恢复 ' + revision.label : css ? applied : '清除样式';
    histories.delete(targetId);
    histories.set(targetId, [{ id: randomUUID(), time: new Date().toISOString(), label, css }, ...history].slice(0, 30));
    if (histories.size > 24) histories.delete(histories.keys().next().value);
    return { ok: true, bytes };
  });
});

const probing = new Map();

/** 同一台服务器同时只能有一个探测：MCP 握手会拉起进程，并发探测会互相干扰。 */
function probe(key, workspaceUris, mode) {
  if (typeof key !== 'string' || !key) throw new Error('请先选择 MCP 配置。');
  if (probing.has(key)) throw new Error('该服务器正在探测中，请等这次探测结束。');
  const run = inspectMcp(key, workspaceUris, mode);
  probing.set(key, run);
  return run.finally(() => probing.delete(key));
}

route('mcp', ({ workspaceUris }) => describeMcp(workspaceUris));
route('mcp-probe', ({ key, workspaceUris }) => probe(key, workspaceUris));
route('rea', ({ key, workspaceUris }) => probe(key, workspaceUris, 'rea'));
route('health', systemHealth);
route('port', ({ port }) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口须在 1 至 65535 之间。');
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); resolve({ state: '回环地址有监听服务' }); });
    socket.once('error', (error) => resolve({ state: error.code === 'ECONNREFUSED' ? '回环地址未检测到监听服务' : '无法判定监听状态' }));
    socket.once('timeout', () => { socket.destroy(); resolve({ state: '连接超时，监听状态未知' }); });
  });
});
route('conversations', async () => ({ conversations: await conversations() }));
route('conversation', ({ id }) => conversation(id));
route('customizations', async ({ workspaceUris }) => ({ rows: await customizations(workspaceUris) }));
route('customization-toggle', ({ key, workspaceUris, enabled, mode }) => toggleCustomization(key, workspaceUris, enabled, mode));
route('agents-fragment', ({ uri, content }) => agentsFragment(uri, content));
route('automations', async () => ({ rows: await automations() }));
route('automation-log', ({ id }) => automationLog(id));
route('automation-run', ({ id }) => {
  if (!process.env.ANTIGRAVITY_AGENTAPI_EXE) throw new Error('当前环境没有宿主 Agent API。');
  return runAutomation(app, id);
});
route('hooks', ({ workspaceUris }) => hookReport(workspaceUris));
route('hooks-option', ({ enabled, workspaceUris }) => setAuditEnabled(enabled, workspaceUris));
route('rea-notes', async ({ note, remove }) => {
  if (!note && !remove) return { notes: (await readJson(optionsPath)).reaNotes || [] };
  if (note && (!['待核实', '函数书签'].includes(note.type) || typeof note.text !== 'string'
      || !note.text.trim() || note.text.length > 300)) throw new Error('请输入不超过 300 字符的地址或问题。');
  const document = await updateJson(optionsPath, (options) => {
    const current = Array.isArray(options.reaNotes) ? options.reaNotes : [];
    options.reaNotes = note
      ? [{ id: randomUUID(), text: note.text.trim(), type: note.type }, ...current].slice(0, 250)
      : current.filter((item) => item.id !== remove);
  });
  return { notes: document.reaNotes };
});

await app.run();

