import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { configDir, object, readJson } from './storage.mjs';

async function executable(program, cwd) {
  if (typeof program !== 'string' || !program) return null;
  const paths = /[\\/]/.test(program) ? [''] : [cwd, ...(process.env.PATH || '').split(delimiter)];
  const extensions = process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(program) ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const path of paths) {
    for (const extension of extensions) {
      const candidate = path ? join(path, program + extension) : resolve(cwd, program + extension);
      try {
        if ((await stat(candidate)).isFile()) {
          await access(candidate, process.platform === 'win32' ? 0 : 1);
          return candidate;
        }
      } catch { /* try the next PATH entry */ }
    }
  }
  return null;
}

/** 探测进程可能自己再拉起子进程（npx、包装器），只杀一层会留下孤儿。 */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); return; }
    catch { /* 落到 child.kill */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* 落到 child.kill */ }
  }
  try { child.kill('SIGKILL'); } catch { /* 进程已经不在了 */ }
}

let versionCache;
async function clientVersion() {
  if (versionCache) return versionCache;
  try {
    const manifest = JSON.parse(await readFile(new URL('../../plugin.json', import.meta.url), 'utf8'));
    versionCache = String(manifest.version || '0.0.0');
  } catch { versionCache = '0.0.0'; }
  return versionCache;
}

function endpoint(server) {
  const raw = server.serverUrl || server.url || server.httpUrl;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export { executable as findExecutable };

export async function mcpInventory(workspaceUris = []) {
  const entries = [];
  const errors = [];
  const roots = [
    { path: join(configDir, 'mcp_config.json'), scope: '全局', cwd: configDir },
  ];
  for (const uri of Array.isArray(workspaceUris) ? workspaceUris.slice(0, 16) : []) {
    try {
      const cwd = fileURLToPath(uri);
      if (isAbsolute(cwd)) roots.push({ path: join(cwd, '.agents', 'mcp_config.json'), scope: basename(cwd), cwd });
    } catch { /* remote workspace */ }
  }
  const plugins = join(configDir, 'plugins');
  const dirs = await readdir(plugins, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const dir of dirs.filter((item) => item.isDirectory() || item.isSymbolicLink()).slice(0, 128)) {
    const cwd = join(plugins, dir.name);
    roots.push({ path: join(cwd, 'mcp_config.json'), scope: dir.name, cwd });
  }
  for (const { path, scope, cwd } of roots) {
    let data;
    try { data = await readJson(path); }
    catch { errors.push(scope + ' 的 MCP 配置无法解析。'); continue; }
    for (const [name, config] of Object.entries(data.mcpServers || {})) {
      if (!object(config)) continue;
      const url = endpoint(config);
      entries.push({
        key: createHash('sha256').update(path + '\0' + name).digest('hex').slice(0, 20),
        name, scope, cwd, config, url,
      });
    }
  }
  return { entries, errors };
}

export async function describeMcp(workspaceUris) {
  const { entries, errors } = await mcpInventory(workspaceUris);
  const servers = await Promise.all(entries.map(async ({ key, name, scope, cwd, config, url }) => ({
    key, name, scope,
    transport: url ? 'HTTP' : config.command ? 'stdio' : '未知',
    disabled: config.disabled === true,
    command: config.command ? basename(config.command) : '',
    found: config.command ? Boolean(await executable(config.command, cwd)) : null,
    endpoint: url?.origin || '',
    port: url ? (url.port || (url.protocol === 'https:' ? '443' : '80')) : '',
    credentials: config.headers || config.env || config.oauth ? '已配置载入项' : '无显式配置',
  })));
  return { servers, errors };
}

function transportError(stage, message) {
  const error = new Error(message);
  error.stage = stage;
  return error;
}

async function connectStdio(entry) {
  const { config, cwd } = entry;
  let file = await executable(config.command, cwd);
  if (!file) throw transportError('命令', '找不到配置的程序。');
  let args = Array.isArray(config.args) ? config.args.map(String) : [];
  if (/\.(?:cmd|bat)$/i.test(file) && /^npx\.cmd$/i.test(basename(file))) {
    args = [join(dirname(file), 'node_modules', 'npm', 'bin', 'npx-cli.js'), ...args];
    file = join(dirname(file), 'node.exe');
  }
  if (/\.(?:cmd|bat)$/i.test(file)) throw transportError('命令', '此包装脚本需要 shell。体检支持配置实际程序路径。');
  const child = spawn(file, args, {
    cwd, env: { ...process.env, ...(object(config.env) ? config.env : {}) },
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
    detached: process.platform !== 'win32',
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let failure;
  let id = 0;
  let stage = '握手';
  function fail(error) {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  const timer = setTimeout(() => {
    fail(transportError(stage, '探测超时。'));
    killTree(child);
  }, 9000);
  child.on('error', () => fail(transportError('进程', '程序无法启动。')));
  child.stdin.on('error', () => fail(transportError(stage, '子进程已关闭输入。')));
  child.on('exit', (code) => fail(transportError(stage, '探测进程退出，代码 ' + (code ?? '未知') + '。')));
  lines.on('line', (line) => {
    let data;
    try { data = JSON.parse(line); } catch { return; }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) {
      const error = transportError(stage, '工具服务返回错误 ' + data.error.code + '。');
      error.rpcCode = data.error.code;
      request.reject(error);
    } else request.resolve(data.result);
  });
  return {
    get pid() { return child.pid; },
    request(method, params = {}, notification = false) {
      if (failure) return Promise.reject(failure);
      const call = { jsonrpc: '2.0', method, params };
      if (notification) {
        child.stdin.write(JSON.stringify(call) + '\n');
        return Promise.resolve();
      }
      stage = method === 'initialize' ? '握手' : '工具';
      call.id = ++id;
      return new Promise((resolve, reject) => {
        pending.set(call.id, { resolve, reject });
        child.stdin.write(JSON.stringify(call) + '\n');
      });
    },
    close() {
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      const stop = setTimeout(() => child.kill(), 400);
      stop.unref();
      child.once('exit', () => clearTimeout(stop));
    },
  };
}

async function readRpc(body, id) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 4_000_000) throw transportError('协议', 'MCP 回复超过 4 MB。');
      if (done) return JSON.parse(buffer);
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop();
      for (const event of events) {
        const payload = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n');
        if (!payload) continue;
        const message = JSON.parse(payload);
        if (message.id === id) return message;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function connectHttp(entry) {
  const { config, url } = entry;
  let session;
  let protocol = '2025-11-25';
  let current = false;
  let id = 0;
  return {
    async request(method, params = {}, notification = false) {
      const headers = new Headers(object(config.headers) ? config.headers : {});
      headers.set('Accept', 'application/json, text/event-stream');
      headers.set('Content-Type', 'application/json');
      headers.set('MCP-Protocol-Version', protocol);
      if (session) headers.set('Mcp-Session-Id', session);
      if (current) {
        headers.set('Mcp-Method', method);
        if (params.name) headers.set('Mcp-Name', params.name);
      }
      const call = { jsonrpc: '2.0', method, params };
      if (!notification) call.id = ++id;
      let response;
      try {
        response = await fetch(url, {
          method: 'POST', headers, body: JSON.stringify(call), redirect: 'error', signal: AbortSignal.timeout(6000),
        });
      } catch {
        throw transportError('连接', '无法访问配置的 HTTP 服务。');
      }
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw transportError('凭据', '服务要求可用凭据（HTTP ' + response.status + '）。请在宿主中授权。');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw transportError('HTTP', '服务器返回 HTTP ' + response.status + '。');
      }
      if (notification) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      session = response.headers.get('mcp-session-id') || session;
      const result = await readRpc(response.body, call.id).catch(() => {
        throw transportError('协议', '无法解析 MCP 回复。');
      });
      if (result.error) throw transportError('协议', 'MCP 返回错误 ' + result.error.code + '。');
      protocol = result.result?.protocolVersion || protocol;
      return result.result;
    },
    modern() { protocol = '2026-07-28'; current = true; session = undefined; },
    async close() {
      if (!session) return;
      try {
        const headers = new Headers(object(config.headers) ? config.headers : {});
        headers.set('MCP-Protocol-Version', protocol);
        headers.set('Mcp-Session-Id', session);
        const response = await fetch(url, {
          method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(1200),
        });
        await response.body?.cancel();
      } catch { /* the server may not implement explicit session termination */ }
    },
  };
}

export async function inspectMcp(key, workspaceUris, mode = 'health') {
  const { entries } = await mcpInventory(workspaceUris);
  const target = entries.find((entry) => entry.key === key);
  if (!target || target.config.disabled) throw new Error('请先选择已启用的 MCP 配置。');
  let client;
  const start = Date.now();
  try {
    client = target.url ? connectHttp(target) : await connectStdio(target);
    let server;
    try {
      const result = await client.request('initialize', {
        protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'antigravity-ui-tweaks', version: await clientVersion() },
      });
      server = result?.serverInfo;
      await client.request('notifications/initialized', {}, true);
    } catch (error) {
      const legacyUnsupported = target.url ? ['HTTP', '协议'].includes(error.stage) : error.rpcCode === -32601;
      if (!legacyUnsupported) throw error;
      client.modern?.();
    }
    const tools = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const result = await client.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw transportError('工具', '服务器没有返回工具清单。');
      tools.push(...result.tools.map((tool) => tool.name).filter((name) => typeof name === 'string'));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    const rea = {};
    if (mode === 'rea') {
      if (!tools.includes('binary_session')) throw transportError('工具', '选中的服务器没有 REA 会话接口。');
      const requests = [
        ['binary_session', { detail: 'summary' }],
        ['get_evidence_bundle', { detail: 'summary', limit: 20 }],
        ['list_bookmarks', {}],
      ];
      for (const [name, args] of requests) {
        if (!tools.includes(name)) {
          rea[name] = { unavailable: '此连接未提供该工具。' };
          continue;
        }
        try {
          rea[name] = await client.request('tools/call', { name, arguments: args });
        } catch {
          rea[name] = { unavailable: '该接口在本次探测连接中不可读。' };
        }
      }
    }
    return { ok: true, server, tools, partial: Boolean(cursor), pid: client.pid, elapsed: Date.now() - start, rea };
  } catch (error) {
    return { ok: false, stage: error.stage || '连接', error: error.stage ? error.message : '探测无法完成。配置可能含有当前进程未加载的变量或凭据。' };
  } finally {
    await client?.close();
  }
}
