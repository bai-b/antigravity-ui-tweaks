import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appData, readJson } from './storage.mjs';

const desktopData = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity');
const portFile = process.env.AGY_UI_TWEAKS_PORT_FILE || join(desktopData, 'DevToolsActivePort');
const styleId = 'agy-ui-tweaks';

function parseUrl(input) {
  try { return new URL(input); } catch { return null; }
}

function usablePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 1023 && port < 65536 ? port : null;
}

async function devtoolsPorts() {
  const ports = new Set();
  const explicit = usablePort(process.env.AGY_UI_TWEAKS_CDP_PORT);
  if (explicit) ports.add(explicit);
  try {
    const written = usablePort((await readFile(portFile, 'utf8')).split(/\r?\n/)[0].trim());
    if (written) ports.add(written);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const hub = join(appData, 'daemon');
  const files = await readdir(hub).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const name of files.filter((item) => /^hub_.*\.json$/.test(item))) {
    const info = await readJson(join(hub, name)).catch(() => ({}));
    for (const key of ['devToolsPort', 'devtoolsPort', 'cdpPort', 'devtoolsActivePort']) {
      const port = usablePort(info?.[key]);
      if (port) ports.add(port);
    }
  }
  return [...ports];
}

async function appPorts() {
  const hub = join(appData, 'daemon');
  const files = await readdir(hub).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const ports = await Promise.all(files.filter((name) => /^hub_.*\.json$/.test(name))
    .map(async (name) => usablePort((await readJson(join(hub, name)).catch(() => ({}))).httpsPort)));
  return new Set(ports.filter(Boolean));
}

async function candidates() {
  const hosts = await appPorts();
  let targets = null;
  let port = null;
  let failure = null;
  for (const candidate of await devtoolsPorts()) {
    try {
      const response = await fetch(`http://127.0.0.1:${candidate}/json/list`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
      if (!response.ok) { failure = failure || new Error('读取调试目标失败。'); continue; }
      targets = await response.json();
      port = candidate;
      break;
    } catch (error) { failure = failure || error; }
  }
  if (!targets) { if (failure) throw failure; return []; }
  return targets.filter((target) => {
    const page = parseUrl(target.url);
    const socket = parseUrl(target.webSocketDebuggerUrl);
    if (target.type !== 'page' || page?.protocol !== 'https:' || page.hostname !== '127.0.0.1') return false;
    if (hosts.size && !hosts.has(Number(page.port))) return false;
    if (Number(page.port) === port) return false;
    return socket?.protocol === 'ws:' && socket.hostname === '127.0.0.1'
      && Number(socket.port) === port && /^\/devtools\/page\/[\da-f]+$/i.test(socket.pathname)
      && !socket.username && !socket.password;
  });
}

async function withCdp(target, operation) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const closed = () => {
    for (const { reject } of pending.values()) reject(new Error('渲染页面调试连接已关闭。'));
    pending.clear();
  };
  socket.addEventListener('close', closed);
  socket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const timer = setTimeout(() => socket.close(), 9000);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('无法连接选中的渲染窗口。')), { once: true });
      socket.addEventListener('close', () => reject(new Error('渲染窗口连接已关闭。')), { once: true });
    });
    return await operation((method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    }));
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, silent: true });
  if (result.exceptionDetails) throw new Error('渲染页面不支持本次操作。');
  return result.result?.value;
}

const identify = `(() => ({
  host: Boolean(document.querySelector('a[href*="/customizations"], [data-testid="agent-input-box"], [data-testid="conversation-view"]')),
  conversations: [...document.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]')]
     .filter(node => node.getClientRects().length).map(node => node.dataset.cascadeId),
}))()`;

export async function rendererTargets() {
  const rows = await Promise.allSettled((await candidates()).slice(0, 12).map(async (target) => {
    const info = await withCdp(target, (send) => evaluate(send, identify));
    return info?.host && { id: target.id, title: target.title || 'Antigravity', conversations: info.conversations };
  }));
  return rows.flatMap((row) => row.status === 'fulfilled' && row.value ? [row.value] : []);
}

async function inWindow({ targetId, conversationId }, operation) {
  const target = (await candidates()).find((item) => item.id === targetId);
  if (!target) throw new Error('请重新检测并选择 Antigravity 窗口。');
  return withCdp(target, async (send) => {
    const info = await evaluate(send, identify);
    if (!info?.host) throw new Error('目标已切换，无法识别 Antigravity 主界面。');
    if (conversationId && !info.conversations.includes(conversationId)) throw new Error('选中的窗口没有显示此会话。');
    return operation(send);
  });
}

export async function probeRenderer(window) {
  return inWindow(window, async (send) => {
    const result = await evaluate(send, `(() => {
      const root = document.documentElement;
      const computed = getComputedStyle(root);
      const tokens = [];
      for (const name of Array.from(computed)) {
        if (!name.startsWith('--')) continue;
        const value = computed.getPropertyValue(name).trim();
        if (value) tokens.push({ name, value, inline: root.style.getPropertyValue(name).trim() });
      }
      return { tokens, selectors: {
        sidebar: document.querySelectorAll('[data-testid="project-sidebar"]').length,
        conversation: document.querySelectorAll('[data-testid="conversation-view"]').length
      }};
    })()`);
    try {
      await send('DOM.enable');
      await send('CSS.enable');
      const { root } = await send('DOM.getDocument');
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'html' });
      const matched = await send('CSS.getMatchedStylesForNode', { nodeId });
      const declared = new Set(matched.matchedCSSRules?.flatMap(({ rule }) =>
        rule.style.cssProperties.filter((property) => !property.disabled && property.parsedOk !== false)
          .map((property) => property.name)) || []);
      for (const token of result.tokens) token.stylesheet = declared.has(token.name);
    } catch {
      result.stylesheetUnavailable = true;
    }
    return result;
  });
}

export async function applyRenderer(window, css) {
  return inWindow(window, (send) => evaluate(send, `(() => {
    const id = ${JSON.stringify(styleId)};
    const css = ${JSON.stringify(css)};
    const existing = document.getElementById(id);
    if (!css) { existing?.remove(); return 0; }
    const style = existing || document.createElement('style');
    style.id = id;
    style.textContent = css;
    if (!existing) document.head.append(style);
    return style.textContent.length;
  })()`));
}

export async function captureRenderer(window) {
  return inWindow(window, async (send) => {
    const { cssVisualViewport } = await send('Page.getLayoutMetrics');
    const { clientWidth: width, clientHeight: height, pageX: x, pageY: y } = cssVisualViewport;
    if (!width || !height) throw new Error('目标窗口不可见。');
    const { data } = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
      clip: { x, y, width, height, scale: Math.min(1, 1440 / width, 1000 / height) },
    });
    return data;
  });
}
