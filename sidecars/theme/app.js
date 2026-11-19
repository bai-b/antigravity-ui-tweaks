import { buildCss, color, colorTokens, fonts, generatePalette, normalizePack, normalizeStyle, paletteChecks, readableOn } from './palette.mjs';
import { $, api, chosen, configureTools, confirmAction, download, element, onClick, options, readJsonFile, status, table } from './panel-tools.mjs';

const colorLabels = {
  background: '主背景', card: '卡片', sidebar: '侧栏', border: '边框',
  foreground: '正文', 'muted-foreground': '次要文字',
  primary: '主色', 'primary-foreground': '主按钮文字', accent: '强调背景',
};
const fields = {
  radius: 'radius', fontScale: 'scale', lineHeight: 'line-height', sidebarWidth: 'sidebar-width',
  uiFont: 'ui-font', editorFont: 'editor-font', texture: 'texture', density: 'density', scrollbars: 'scrollbars',
};
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const contextId = new URLSearchParams(location.search).get('conversationId');
const host = window.sidecar;
const palette = new Map();
const extraTokens = new Set();
const injected = new Set();
const hiddenSections = [...document.querySelectorAll('[data-hide]')];
const sampler = document.createElement('canvas');
sampler.width = sampler.height = 1;
const sample = sampler.getContext('2d', { willReadFrequently: true });
let workspaces = [];
let probeRows = [];
let packState = { packs: [], projectPacks: [], schedule: {} };
let currentView = 'theme';
let images = {};
let lastAutomatic = '';
let autoInFlight = false;

function ensureColorInput(name) {
  if (palette.has(name)) return palette.get(name);
  const label = element('label', colorLabels[name.slice(2)] || name, 'field');
  const input = element('input');
  input.type = 'text';
  input.maxLength = 9;
  input.placeholder = '#RRGGBB';
  input.className = 'token-copy';
  input.spellcheck = false;
  input.addEventListener('input', updatePreview);
  label.append(input);
  $('palette').append(label);
  palette.set(name, input);
  return input;
}

function setColors(colors) {
  // 从宿主探测并入的令牌保持行不动，否则换一次配色方案就得重新探测。
  for (const [name, input] of palette) {
    if (!Object.hasOwn(colors, name) && !Object.hasOwn(colorLabels, name.slice(2)) && !extraTokens.has(name)) {
      input.parentElement.remove();
      palette.delete(name);
    } else input.value = colors[name] || '';
  }
  for (const [name, value] of Object.entries(colors)) ensureColorInput(name).value = value;
  const base = colors['--background'];
  const accent = colors['--primary'];
  if (base?.length === 7) $('base').value = base;
  if (accent?.length === 7) $('accent').value = accent;
}

function styleFromForm() {
  const colors = {};
  for (const [name, input] of palette) {
    try {
      const value = input.value.trim();
      if (value) colors[name] = color(value);
      input.setCustomValidity('');
    } catch (error) {
      input.setCustomValidity(error.message);
      throw new Error(name + ' 的颜色无效。');
    }
  }
  const values = Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, $(id).value]));
  if (values.fontScale !== '') values.fontScale = Number(values.fontScale) / 100;
  return normalizeStyle({ colors, ...values, hiddenSections: hiddenSections.filter((item) => item.checked).map((item) => item.dataset.hide) });
}

function setStyle(style) {
  setColors(style.colors);
  for (const [name, id] of Object.entries(fields)) {
    $(id).value = style[name] === undefined ? '' : name === 'fontScale' ? Math.round(style[name] * 100) : style[name];
  }
  for (const item of hiddenSections) item.checked = style.hiddenSections?.includes(item.dataset.hide) || false;
  updatePreview();
}

function updatePreview() {
  const root = $('preview');
  const checks = $('contrast-checks');
  try {
    const style = styleFromForm();
    root.removeAttribute('style');
    for (const [name, value] of Object.entries(style.colors)) root.style.setProperty('--sample-' + name.slice(2), value);
    if (style.uiFont) root.style.setProperty('--sample-font', fonts[style.uiFont]);
    if (style.radius !== undefined) root.style.setProperty('--sample-radius', style.radius + 'px');
    if (style.fontScale !== undefined) root.style.setProperty('--sample-size', 0.875 * style.fontScale + 'rem');
    if (style.lineHeight !== undefined) root.style.setProperty('--sample-line-height', style.lineHeight);
    if (style.colors['--primary']) {
      root.style.setProperty('--button-fallback', readableOn(style.colors['--primary']));
    }
    root.dataset.primarySolid = String(style.colors['--primary']?.length === 7);
    root.dataset.density = style.density;
    root.dataset.texture = style.texture;
    checks.replaceChildren(...paletteChecks(style.colors).map(({ label, ratio, passes }) => {
      const item = element('div', undefined, 'check-item');
      item.dataset.tone = ratio === null ? '' : passes ? 'ok' : 'error';
      const result = ratio === null ? '未测' : ratio.toFixed(2) + ':1 · ' + (passes ? '通过' : '不足');
      item.append(element('span', label), element('strong', result));
      return item;
    }));
  } catch (error) {
    const hint = element('p', error.message, 'muted');
    checks.replaceChildren(hint);
  }
}

function generate() {
  setColors(generatePalette($('base').value, $('accent').value));
  updatePreview();
}

for (const name of colorTokens.filter((name) => Object.hasOwn(colorLabels, name))) ensureColorInput('--' + name);
for (const id of Object.values(fields)) $(id).addEventListener('input', updatePreview);
onClick('generate', generate);
generate();

function selectedPack() {
  return packState.packs.find((pack) => pack.name === $('packs').value);
}

function refreshPacks(state, selected) {
  packState = state;
  const rows = state.packs.map(({ name }) => [name, name]);
  for (const id of ['packs', 'schedule-day', 'schedule-night']) options(id, rows, '选择配方');
  if (selected) $('packs').value = selected;
  $('schedule-mode').value = state.schedule.mode || 'off';
  $('schedule-day').value = state.schedule.day || '';
  $('schedule-night').value = state.schedule.night || '';
  $('day-at').value = state.schedule.dayAt || '07:00';
  $('night-at').value = state.schedule.nightAt || '20:00';
  workspaceMessage();
}

function workspaceKey() {
  return workspaces.slice().sort().join('\n');
}

function workspaceMessage() {
  const bound = packState.projectPacks.find((pack) => pack.workspace === workspaceKey());
  const labels = workspaces.map((uri) => {
    const name = uri.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1);
    try { return decodeURIComponent(name); } catch { return name; }
  });
  $('workspace-label').textContent = labels.length
    ? labels.join('、') + (bound ? ' · 已绑定「' + bound.name + '」' : ' · 未绑定配方')
    : '当前会话没有工作区。';
}

function packFromForm(defaultName = '') {
  return normalizePack({
    version: 1, name: $('pack-name').value.trim() || defaultName, style: styleFromForm(),
  });
}

onClick('save-pack', async () => {
  const pack = packFromForm();
  refreshPacks(await api('pack', { pack }), pack.name);
  status('已保存「' + pack.name + '」。', 'ok');
});
onClick('load-pack', () => {
  const pack = selectedPack();
  if (!pack) throw new Error('请选择已保存的配方。');
  $('pack-name').value = pack.name;
  setStyle(pack.style);
  status('已载入配方预览。', 'ok');
});
onClick('export-pack', () => {
  const pack = packFromForm('主题配方');
  download(pack.name + '.json', JSON.stringify(pack, null, 2), 'application/json');
});
onClick('import-pack', () => $('pack-file').click());
readJsonFile('pack-file', 150_000, (json) => {
  const pack = normalizePack(json);
  $('pack-name').value = pack.name;
  setStyle(pack.style);
  status('配方已导入预览。可选择保存或应用。', 'ok');
});
onClick('bind-pack', async () => {
  const name = chosen('packs');
  refreshPacks(await api('workspace-pack', { workspace: workspaceKey(), name }), name);
  lastAutomatic = '';
  await applyWorkspaceTheme();
});
onClick('unbind-pack', async () => {
  refreshPacks(await api('workspace-pack', { workspace: workspaceKey() }));
  lastAutomatic = '';
  await applyWorkspaceTheme();
});
onClick('save-schedule', async () => {
  refreshPacks(await api('theme-schedule', {
    mode: $('schedule-mode').value, day: $('schedule-day').value, night: $('schedule-night').value,
    dayAt: $('day-at').value, nightAt: $('night-at').value,
  }));
  lastAutomatic = '';
  await applyWorkspaceTheme();
  status('切换计划已保存。', 'ok');
});
onClick('save-host', async () => {
  const style = styleFromForm();
  if (!await confirmAction('将当前配色种子写入 Antigravity 配置？宿主下次启动时读取。')) return;
  await api('theme', {
    themeMode: $('theme-mode').value,
    [$('seed-target').value]: {
      background: style.colors['--background'],
      foregroundOverride: style.colors['--foreground'],
      primary: style.colors['--primary'],
    },
  });
  status('已写入宿主配置。', 'ok');
});

function windowSpec() {
  return { targetId: chosen('targets') };
}

async function refreshHistory() {
  const id = $('targets').value;
  const { history } = id ? await api('history', { targetId: id }) : { history: [] };
  if (id !== $('targets').value) return;
  options('history', history.map((item) => [item.id, new Date(item.time).toLocaleTimeString() + ' · ' + item.label]), history.length ? '选择历史版本' : '暂无记录');
}

onClick('refresh-targets', async () => {
  const { targets } = await api('targets');
  options('targets', targets.map((target, index) => [target.id, (index + 1) + ' · ' + target.title]), '选择窗口');
  if (targets.length === 1) $('targets').value = targets[0].id;
  await refreshHistory();
  status(targets.length ? '检测到 ' + targets.length + ' 个 Antigravity 窗口。'
    : '没有检测到可用的 Antigravity 渲染窗口。', targets.length ? 'ok' : 'error');
});
$('targets').addEventListener('change', () => {
  refreshHistory().catch((error) => status(error.message, 'error'));
});

async function applyStyle(body, message) {
  const spec = windowSpec();
  const result = await api('inject', { ...spec, ...body });
  if (result.bytes) injected.add(spec.targetId); else injected.delete(spec.targetId);
  await refreshHistory();
  status(message || (result.bytes ? '样式已应用到选中的窗口。' : '选中窗口的临时样式已清除。'), 'ok');
}

// 宿主切换浅/深主题时会把新令牌写成内联变量，注入的 !important 会盖住它们。
// 收到 theme-change 就撤掉临时样式，让窗口回到宿主的新配色，再按需重新应用。
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'theme-change' || !injected.size) return;
  const targets = [...injected];
  injected.clear();
  Promise.allSettled(targets.map((targetId) => api('inject', { targetId, clear: true })))
    .then(() => refreshHistory())
    .catch(() => {});
  status('宿主切换了主题，临时样式已清除。改好后再应用一次。');
});

onClick('apply', () => applyStyle({ style: styleFromForm(), name: $('pack-name').value }));
onClick('clear', () => applyStyle({ clear: true }));
onClick('restore', () => applyStyle({ restore: chosen('history') }, '已恢复选中的样式版本。'));
onClick('copy-css', async () => {
  const css = buildCss(styleFromForm());
  try { await navigator.clipboard.writeText(css); status('CSS 已复制。', 'ok'); }
  catch { download('antigravity-theme.css', css, 'text/css'); status('已生成 CSS 文件。', 'ok'); }
});

function computedColor(value) {
  if (!sample || !CSS.supports('color', value) || /var\(|currentcolor/i.test(value)) return '';
  sample.fillStyle = '#123456';
  sample.fillStyle = value;
  const first = sample.fillStyle;
  sample.fillStyle = '#654321';
  sample.fillStyle = value;
  if (sample.fillStyle !== first) return '';
  sample.clearRect(0, 0, 1, 1);
  sample.fillRect(0, 0, 1, 1);
  const channels = [...sample.getImageData(0, 0, 1, 1).data];
  if (channels[3] === 255) channels.pop();
  return '#' + channels.map((channel) => channel.toString(16).padStart(2, '0')).join('');
}

function group(name) {
  if (/ground|border|shadow|glass|surface|card|sidebar/.test(name) && !/foreground/.test(name)) return '背景与边界';
  if (/text|foreground|font|placeholder/.test(name)) return '文字';
  if (/primary|accent|success|warning|error|link|chart|cta/.test(name)) return '强调与状态';
  return '其他';
}

function renderProbe() {
  const filter = $('filter-tokens').value.trim().toLowerCase();
  const section = $('token-group').value;
  const justColors = $('only-colors').checked;
  const rows = probeRows.filter((token) => (!section || token.group === section) && (!justColors || token.hex)
    && [token.name, token.value, token.hex, token.origin].join(' ').toLowerCase().includes(filter));
  table('token-results', '渲染令牌', ['令牌', '值', '来源'], rows.slice(0, 150).map((token) => {
    const label = token.hex ? element('button', token.hex, 'token-copy') : token.value;
    if (token.hex) {
      const swatch = element('span', undefined, 'swatch');
      swatch.style.background = token.hex;
      swatch.setAttribute('aria-hidden', 'true');
      label.prepend(swatch);
      label.setAttribute('aria-label', '吸取 ' + token.name + ' ' + token.hex);
      onClick(label, () => {
        ensureColorInput(token.name).value = token.hex;
        updatePreview();
        status('已从宿主吸取 ' + token.name + '。', 'ok');
      });
    }
    return [token.name, label, token.origin];
  }), '没有匹配的令牌。');
}

onClick('probe', async () => {
  const report = await api('probe', windowSpec());
  probeRows = report.tokens.map((token) => ({
    ...token, hex: computedColor(token.value), group: group(token.name),
    origin: [token.inline && 'inline', token.stylesheet && 'stylesheet'].filter(Boolean).join(' / ') || '计算值',
  }));
  const merged = probeRows.filter((token) => token.hex && !palette.has(token.name)).slice(0, 80);
  for (const token of merged) { extraTokens.add(token.name); ensureColorInput(token.name); }
  $('probe-info').textContent = probeRows.length + ' 个令牌，列表最多显示 150 条。'
    + '侧栏选择器命中 ' + report.selectors.sidebar + ' 处。'
    + (merged.length ? '已并入 ' + merged.length + ' 个未收录令牌。' : '')
    + (report.stylesheetUnavailable ? '当前无法读取样式表来源。' : '');
  $('token-details').open = true;
  renderProbe();
});
for (const id of ['filter-tokens', 'token-group', 'only-colors']) $(id).addEventListener('input', renderProbe);

async function capture(which) {
  const scope = windowSpec();
  if (!await confirmAction('截取选中 Antigravity 窗口的一张渲染画面？画面会包含窗口当前可见的内容。')) return;
  const result = await api('capture', scope);
  const image = new Image();
  image.alt = which === 'before' ? '改前渲染画面' : '改后渲染画面';
  image.src = 'data:image/png;base64,' + result.png;
  await image.decode();
  images[which] = { image, id: scope.targetId };
  renderImages();
}

function renderImages() {
  const { before, after } = images;
  const container = $('images');
  container.replaceChildren();
  for (const item of [before, after].filter(Boolean)) {
    const figure = element('figure');
    figure.append(item.image, element('figcaption', item.image.alt));
    container.append(figure);
  }
  if (!before || !after) return;
  if (before.id !== after.id) {
    container.append(element('p', '两次截图来自不同窗口，先选定同一个窗口再对比。', 'muted'));
    return;
  }
  // 两帧尺寸不同（窗口被拖动或缩放）时只比较重叠区域，而不是直接拒绝。
  const resized = before.image.naturalWidth !== after.image.naturalWidth || before.image.naturalHeight !== after.image.naturalHeight;
  const width = Math.min(before.image.naturalWidth, after.image.naturalWidth);
  const height = Math.min(before.image.naturalHeight, after.image.naturalHeight);
  const canvas = element('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(before.image, 0, 0);
  const oldPixels = context.getImageData(0, 0, width, height).data;
  context.drawImage(after.image, 0, 0);
  const result = context.getImageData(0, 0, width, height);
  let changed = 0;
  for (let index = 0; index < result.data.length; index += 4) {
    const delta = Math.max(
      Math.abs(result.data[index] - oldPixels[index]),
      Math.abs(result.data[index + 1] - oldPixels[index + 1]),
      Math.abs(result.data[index + 2] - oldPixels[index + 2]),
    );
    if (delta > 10) {
      changed++;
      result.data[index] = 246;
      result.data[index + 1] = 68;
      result.data[index + 2] = 108;
    }
  }
  context.putImageData(result, 0, 0);
  const caption = (100 * changed / (width * height)).toFixed(1) + '% 像素变化（RGB 差值 > 10）'
    + (resized ? '，两帧尺寸不同，只比较左上角 ' + width + '×' + height + ' 的重叠区域' : '');
  canvas.setAttribute('aria-label', caption);
  const figure = element('figure');
  figure.append(canvas, element('figcaption', caption));
  container.append(figure);
}
onClick('capture-before', () => capture('before'));
onClick('capture-after', () => capture('after'));
onClick('clear-images', () => { images = {}; renderImages(); });

function schedulePack() {
  const scheduled = packState.schedule;
  if (scheduled.mode === 'system') return systemDark.matches ? scheduled.night : scheduled.day;
  if (scheduled.mode !== 'clock') return '';
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const day = minutes(scheduled.dayAt);
  const night = minutes(scheduled.nightAt);
  const now = new Date();
  const clock = now.getHours() * 60 + now.getMinutes();
  const daytime = day < night ? clock >= day && clock < night : clock >= day || clock < night;
  return daytime ? scheduled.day : scheduled.night;
}

async function applyWorkspaceTheme() {
  if (autoInFlight) return;
  const workspace = workspaceKey();
  const name = packState.projectPacks.find((pack) => pack.workspace === workspace)?.name || schedulePack();
  const pack = packState.packs.find((item) => item.name === name);
  if (!pack) return;
  const automatic = $('auto-apply').checked && contextId;
  const key = [workspace, name, automatic ? 'apply' : 'preview'].join('\0');
  if (key === lastAutomatic) return;
  lastAutomatic = key;
  $('pack-name').value = pack.name;
  $('packs').value = pack.name;
  setStyle(pack.style);
  if (!automatic) return;
  autoInFlight = true;
  try {
    const targets = (await api('targets')).targets.filter((target) => target.conversations.includes(contextId));
    if (targets.length !== 1 || workspaceKey() !== workspace || !$('auto-apply').checked) {
      status('当前会话未匹配到唯一渲染窗口，配方已保留在预览。');
      return;
    }
    await api('inject', { targetId: targets[0].id, conversationId: contextId, style: pack.style, name: pack.name });
    injected.add(targets[0].id);
    await refreshHistory();
    status('已为当前会话窗口应用「' + pack.name + '」。', 'ok');
  } finally { autoInFlight = false; }
}
const scheduleTick = () => applyWorkspaceTheme().catch((error) => status(error.message, 'error'));
$('auto-apply').addEventListener('change', () => { lastAutomatic = ''; scheduleTick(); });
systemDark.addEventListener('change', scheduleTick);
setInterval(() => { if (packState.schedule.mode === 'clock') scheduleTick(); }, 20_000);

for (const [id, action] of [['request-theme', 'sendMessage'], ['new-theme', 'startConversation']]) {
  onClick(id, async () => {
    if (!host?.agent?.[action] || window.parent === window) throw new Error('请在 Antigravity 面板中使用 Agent。');
    const request = chosen('theme-request');
    if (!await confirmAction(action === 'sendMessage' ? '发送到当前会话？' : '创建一个新的调校会话？')) return;
    const message = '请根据要求修改下面的 Antigravity 主题配方，并返回可导入的 version=1 JSON。只提供配方内容。\n要求：'
      + request + '\n当前配方：\n' + JSON.stringify(packFromForm('主题配方'), null, 2);
    if (action === 'sendMessage') {
      if (!contextId) throw new Error('面板没有绑定当前会话。');
      await host.agent.sendMessage(message, contextId);
    } else await host.agent.startConversation(message, '主题调校');
    status('已向宿主提交调校请求。', 'ok');
  });
}

const pages = configureTools(() => workspaces, contextId);
const seen = new Set();
const navigation = [...document.querySelectorAll('[data-view]')];
const sections = [...document.querySelectorAll('[data-page]')];
for (const button of navigation) {
  onClick(button, async () => {
    currentView = button.dataset.view;
    for (const control of navigation) control.setAttribute('aria-pressed', String(control === button));
    for (const section of sections) section.hidden = section.dataset.page !== currentView;
    const load = pages[currentView];
    if (load && !seen.has(currentView)) {
      const view = currentView;
      await load();
      seen.add(view);
    }
  });
}

async function initialize() {
  $('connection').textContent = window.parent === window ? '本地预览' : '宿主面板';
  const state = await api('state');
  if (state.themeMode) $('theme-mode').value = state.themeMode;
  const seeds = systemDark.matches ? state.dark : state.light;
  if (seeds) {
    try {
      if (seeds.background) $('base').value = color(seeds.background).slice(0, 7);
      if (seeds.primary) $('accent').value = color(seeds.primary).slice(0, 7);
      generate();
      if (seeds.foregroundOverride) {
        ensureColorInput('--foreground').value = color(seeds.foregroundOverride);
        updatePreview();
      }
    } catch { /* retain the initial usable theme */ }
  }
  refreshPacks(state);
  if (host?.getWorkspaceUris) workspaces = await host.getWorkspaceUris();
  workspaceMessage();
  host?.onWorkspaceChange?.((uris) => {
    const previous = workspaceKey();
    workspaces = Array.isArray(uris) ? uris : [];
    if (workspaceKey() === previous) return;
    lastAutomatic = '';
    workspaceMessage();
    for (const view of ['rules', 'mcp', 'rea']) {
      seen.delete(view);
      if (currentView === view) pages[view]().catch((error) => status(error.message, 'error'));
    }
    scheduleTick();
  });
  scheduleTick();
  status(state.configError || '可以生成配色，也可以先检测要应用的窗口。', state.configError ? 'error' : '');
}
initialize().catch((error) => status(error.message, 'error'));

