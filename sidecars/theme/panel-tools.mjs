export const $ = (id) => document.getElementById(id);

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function status(message, tone = '') {
  $('status').textContent = message;
  $('status').dataset.tone = tone;
}

export async function api(name, body = {}) {
  if (!window.sidecar?.fetch) throw new Error('需要从 Antigravity Sidecar 打开调校台。');
  const response = await window.sidecar.fetch('/api/' + name, {
    method: 'POST', body: JSON.stringify(body),
  });
  const reply = await response.json();
  if (!response.ok) throw new Error(reply.error || '读取失败（HTTP ' + response.status + '）。');
  return reply;
}

export function onClick(id, callback) {
  const button = typeof id === 'string' ? $(id) : id;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await callback(); }
    catch (error) { status(error.message || String(error), 'error'); }
    finally { button.disabled = false; }
  });
  return button;
}

export function confirmAction(message) {
  const dialog = $('confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('confirm-message').textContent = message;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
  });
}

export function options(id, rows, placeholder = '请选择') {
  const select = $(id);
  const value = select.value;
  select.replaceChildren(new Option(placeholder, ''), ...rows.map(([key, label]) => new Option(label, key)));
  if (rows.some(([key]) => String(key) === value)) select.value = value;
}

export function chosen(id) {
  const field = $(id);
  const value = field.value.trim();
  if (!value) {
    const label = field.labels?.[0]?.textContent.trim().split('选择')[0];
    throw new Error((label || '此项') + '需要选择或填写。');
  }
  return value;
}

export function table(id, title, headers, rows, empty = '暂无记录。') {
  const target = $(id);
  if (!rows.length) { target.replaceChildren(element('p', empty, 'muted')); return; }
  const scroll = element('div', undefined, 'table-wrap');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', title);
  const grid = element('table');
  grid.append(element('caption', title, 'visually-hidden'));
  const head = grid.createTHead().insertRow();
  for (const label of headers) {
    const cell = element('th', label);
    cell.scope = 'col';
    head.append(cell);
  }
  const body = grid.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const value of cells) {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? '—';
    }
  }
  scroll.append(grid);
  target.replaceChildren(scroll);
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = element('a');
  link.href = url;
  link.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function readJsonFile(id, limit, callback) {
  $(id).addEventListener('change', async () => {
    const file = $(id).files[0];
    $(id).value = '';
    if (!file) return;
    try {
      if (file.size > limit) throw new Error('文件超过允许的大小。');
      await callback(JSON.parse(await file.text()));
    } catch (error) { status(error.message, 'error'); }
  });
}

function hostMethod(method) {
  if (typeof method !== 'function' || window.parent === window) throw new Error('此功能需要宿主窗口。');
  return method;
}

function print(id, value) {
  $(id).hidden = false;
  $(id).textContent = value;
}

function date(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toLocaleString('zh-CN', { hour12: false });
}

function heading(row) {
  return [row.type, row.status, row.time && date(row.time)].filter(Boolean).join(' · ');
}

function noteItem(title, text) {
  const item = element('div', undefined, 'list-item');
  item.append(element('strong', title));
  if (text) item.append(element('p', text, 'muted'));
  return item;
}

function fileUri() {
  let uri;
  try { uri = new URL(chosen('file-uri')); }
  catch { throw new Error('请输入有效文件 URI，例如 file:///D:/work/report.md。'); }
  if (uri.protocol !== 'file:') throw new Error('请选择 file:// 文件链接。');
  return uri.href;
}

export function configureTools(getWorkspaces, contextId) {
  let sessionRows = [];
  let mcpRows = [];
  let ruleRows = [];
  let jobs = [];

  function renderSessions() {
    const project = $('session-project').value;
    const filter = $('session-search').value.trim().toLowerCase();
    const rows = sessionRows.filter((row) => (!project || row.project === project)
      && [row.title, row.workspaces].some((value) => String(value || '').toLowerCase().includes(filter)));
    options('sessions', rows.map((row) => [row.id, (row.title || '未命名会话') + ' · ' + date(row.modified)]), '选择会话');
  }

  async function loadSessions() {
    sessionRows = (await api('conversations')).conversations;
    const projects = new Map();
    for (const { project, workspaces } of sessionRows) {
      if (!project || projects.has(project)) continue;
      let workspace = '';
      try { workspace = JSON.parse(workspaces)?.[0] || ''; } catch { /* summary schema may differ */ }
      const name = String(workspace).replace(/[/\\]+$/, '').split(/[/\\]/).at(-1);
      let decoded = name;
      try { decoded = decodeURIComponent(name); } catch { /* use raw title */ }
      projects.set(project, decoded || project.slice(0, 12));
    }
    options('session-project', [...projects], '全部项目');
    renderSessions();
    if (!$('sessions').value && sessionRows.some((row) => row.id === contextId)) $('sessions').value = contextId;
    status('已读取 ' + sessionRows.length + ' 个本机会话。', 'ok');
  }

  async function readSession() {
    return api('conversation', { id: chosen('sessions') });
  }

  function sessionSummary(data) {
    const metrics = data.totals;
    const material = metrics ? ' · 输入 ' + metrics.input.toLocaleString() + ' / 缓存读取 '
      + metrics.cache.toLocaleString() + ' / 输出 ' + metrics.output.toLocaleString() + ' Token' : ' · 暂无统计字段';
    return data.source + ' · ' + data.entries.length + ' 条记录' + material + (data.truncated ? ' · 结果为片段' : '');
  }

  $('session-search').addEventListener('input', renderSessions);
  $('session-project').addEventListener('change', renderSessions);
  onClick('load-sessions', loadSessions);
  onClick('jump-session', () => hostMethod(window.sidecar?.ui?.toggleConversation)(chosen('sessions')));
  onClick('view-session', async () => {
    const data = await readSession();
    $('session-summary').textContent = sessionSummary(data);
    const timeline = $('session-timeline');
    const visible = data.entries.filter((row) => row.content || row.tools.length || row.type).slice(-100);
    timeline.replaceChildren(...visible.map((row) => {
      const item = noteItem(heading(row), row.tools.length ? '工具 ' + row.tools.join('、') : '');
      if (row.content) {
        const content = element('details');
        content.append(element('summary', '查看内容'), element('pre', row.content));
        item.append(content);
      }
      return item;
    }));
    if (!visible.length) timeline.append(element('p', '该会话暂无可读的本地日志。', 'muted'));
    if (data.entries.length > 100) timeline.prepend(element('p', '界面显示最近 100 条，导出包含已读取的记录。', 'muted'));
  });
  onClick('export-session', async () => {
    const data = await readSession();
    if (!data.entries.length) throw new Error('没有可导出的会话正文或工具记录。');
    const output = ['# ' + data.title.replace(/[\r\n]+/g, ' '), '', sessionSummary(data)];
    for (const row of data.entries) {
      output.push('', '## ' + heading(row).replace(/[\r\n]+/g, ' '), '');
      if (row.tools.length) output.push('工具：' + row.tools.join('、'), '');
      if (row.content) output.push(row.content);
    }
    download(data.title.slice(0, 70) + '.md', output.join('\n'), 'text/markdown;charset=utf-8');
    status('已生成 Markdown。', 'ok');
  });
  onClick('open-file', () => hostMethod(window.sidecar?.ui?.toggleAuxPane)({ tabType: 'fileView', uri: fileUri() }));
  onClick('add-comment', () => {
    hostMethod(window.sidecar?.ui?.addArtifactComment)({ uri: fileUri(), comment: chosen('artifact-comment') });
    status('已请求将评论附到下一条消息。', 'ok');
  });

  async function loadMcp() {
    const { servers, errors } = await api('mcp', { workspaceUris: getWorkspaces() });
    mcpRows = servers;
    options('mcp-select', servers.filter((row) => !row.disabled).map((row) => [row.key, row.name + ' · ' + row.scope]), '选择服务器');
    options('rea-select', servers.filter((row) => /rea|reverse.eng/i.test(row.name) && !row.disabled)
      .map((row) => [row.key, row.name + ' · ' + row.scope]), '选择 REA 连接');
    table('mcp-table', 'MCP 配置', ['服务器', '来源', '命令或端点', '凭据配置'], servers.map((row) => [
      row.name + (row.disabled ? '（配置停用）' : ''), row.scope,
      row.transport === 'HTTP' ? row.endpoint + ' · ' + row.port
        : row.transport === 'stdio' ? row.command + (row.found ? ' · 可找到' : ' · 未找到') : '未知',
      row.credentials,
    ]));
    status(errors.length ? errors.join(' ') : '已读取 ' + servers.length + ' 个 MCP 配置。', errors.length ? 'error' : 'ok');
  }

  onClick('load-mcp', loadMcp);
  onClick('probe-mcp', async () => {
    const key = chosen('mcp-select');
    const server = mcpRows.find((row) => row.key === key);
    if (!await confirmAction('测试 ' + server.name + ' 会按配置启动独立探测进程或连接远端服务。是否继续？')) return;
    print('mcp-result', '正在探测…');
    const result = await api('mcp-probe', { key, workspaceUris: getWorkspaces() });
    if (!result.ok) { print('mcp-result', result.stage + ' · ' + result.error); status('MCP 探测失败。', 'error'); return; }
    print('mcp-result', [
      (result.server?.name || server.name) + ' · ' + result.elapsed + ' ms',
      result.pid && '独立探测进程 PID ' + result.pid + '，探测后退出',
      result.tools.length + ' 个工具' + (result.partial ? '（其余分页未加载）' : ''),
      ...result.tools,
    ].filter(Boolean).join('\n'));
    status('MCP 协议与工具清单可用。', 'ok');
  });
  onClick('refresh-credential', () => {
    hostMethod(window.sidecar?.auth?.requestCredentialRefresh)();
    status('已请求宿主刷新凭据。部分宿主不会弹出授权界面。');
  });
  onClick('get-health', async () => {
    const data = await api('health');
    const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(data.bytes / 1024 ** 2);
    $('health-details').replaceChildren(
      element('dt', '运行时'), element('dd', data.platform + ' · Node ' + data.node + ' · ' + data.cores + ' 逻辑核心'),
      element('dt', 'Sidecar 数据'), element('dd', amount + ' MiB' + (data.partial ? '（部分文件）' : '')),
    );
  });
  onClick('check-port', async () => {
    const port = Number(chosen('local-port'));
    const response = await api('port', { port });
    $('port-result').textContent = port + ' · ' + response.state;
  });

  function renderRules() {
    const filter = $('filter-rules').value.toLowerCase().trim();
    const rows = ruleRows.filter((row) => [row.name, row.scope, row.type].join(' ').toLowerCase().includes(filter));
    const destination = $('rules-list');
    destination.replaceChildren(...rows.map((row) => {
      const state = row.managed === 'host' ? '宿主开关控制' : row.disabled ? '离线停用' : '文件可加载';
      const item = noteItem(row.name, row.type + ' · ' + row.scope + ' · ' + state);
      if (row.managed === 'file') {
        const button = element('button', row.disabled ? '恢复加载' : '离线停用');
        button.setAttribute('aria-label', (row.disabled ? '恢复 ' : '离线停用 ') + row.name);
        onClick(button, async () => {
          if (!await confirmAction((row.disabled ? '恢复 ' : '离线停用 ') + row.name
            + '：会改文件名，宿主面板可能仍显示为已启用。')) return;
          const result = await api('customization-toggle', {
            key: row.key, workspaceUris: getWorkspaces(), enabled: row.disabled, mode: 'file' });
          status(result.note || '已更新。', 'ok');
          await loadRules();
        });
        item.append(button);
      }
      return item;
    }));
    if (!rows.length) destination.append(element('p', '没有匹配的独立技能、规则或已安装插件组件。', 'muted'));
  }

  async function loadRules() {
    const workspaceUris = getWorkspaces();
    ruleRows = (await api('customizations', { workspaceUris })).rows;
    options('rule-workspace', workspaceUris.filter((uri) => uri.startsWith('file:')).map((uri) => [uri, uri]), '选择工作区');
    if (workspaceUris.length === 1 && workspaceUris[0].startsWith('file:')) $('rule-workspace').value = workspaceUris[0];
    renderRules();
  }

  function selectedWorkspace() { return chosen('rule-workspace'); }
  onClick('load-rules', loadRules);
  $('filter-rules').addEventListener('input', renderRules);
  $('rule-workspace').addEventListener('change', () => { $('agents-content').value = ''; });
  onClick('load-fragment', async () => {
    const response = await api('agents-fragment', { uri: selectedWorkspace() });
    $('agents-content').value = response.content;
  });
  onClick('save-fragment', async () => {
    const uri = selectedWorkspace();
    const content = chosen('agents-content');
    if (!await confirmAction('保存此工作区的 AGENTS.md 片段？已有文件会先备份。')) return;
    await api('agents-fragment', { uri, content });
    status('规则片段已保存。', 'ok');
  });
  onClick('remove-fragment', async () => {
    const uri = selectedWorkspace();
    if (!await confirmAction('移除调校台写入的 AGENTS.md 片段？')) return;
    await api('agents-fragment', { uri, content: '' });
    $('agents-content').value = '';
    status('已移除调校台片段。', 'ok');
  });

  async function loadJobs() {
    jobs = (await api('automations')).rows;
    options('job-select', jobs.map((row) => [row.id, row.title]), '选择任务');
    table('jobs-table', '计划任务', ['任务', '状态', '计划', '下次预计', '手动运行'], jobs.map((row) => [
      row.title, row.enabled ? '已配置启用' : '未启用', row.cron, row.scheduleError || date(row.next),
      row.runnable ? '可以' : row.reason || '需要宿主运行',
    ]));
  }

  onClick('load-jobs', loadJobs);
  onClick('job-log', async () => {
    const result = await api('automation-log', { id: chosen('job-select') });
    print('job-result', result.text ? date(result.modified) + (result.truncated ? '（日志尾部）' : '') + '\n' + result.text : '暂无本地日志。');
  });
  onClick('run-job', async () => {
    const id = chosen('job-select');
    const job = jobs.find((row) => row.id === id);
    if (!job?.runnable) throw new Error('这个任务不能在这里运行：' + (job?.reason || '需要宿主 Automations 运行') + '。');
    if (!await confirmAction('现在运行「' + job.title + '」并创建新的 Agent 会话？')) return;
    await api('automation-run', { id });
    status('已向宿主提交本次运行。', 'ok');
  });

  function renderHooks(data) {
    $('audit-enabled').checked = data.enabled;
    $('hook-groups').replaceChildren(...data.sources.map((group) => noteItem(group.name,
      [group.scope, group.enabled ? '已配置' : '已停用', group.events.join('、')].join(' · '))));
    table('hook-table', 'Hooks 事件流', ['时间', '阶段', '工具', '结果'], data.events.map((row) => [
      date(row.time), row.phase === 'PreToolUse' ? '调用前' : '调用后', row.tool, row.status || '未知',
    ]), '尚无审计事件。');
  }
  async function loadHooks() { renderHooks(await api('hooks', { workspaceUris: getWorkspaces() })); }
  onClick('load-hooks', loadHooks);
  onClick('save-audit', async () => {
    renderHooks(await api('hooks-option', { enabled: $('audit-enabled').checked, workspaceUris: getWorkspaces() }));
    status('Hooks 审计设置已保存。', 'ok');
  });

  function evidence(title, result) {
    const node = element('details');
    node.append(element('summary', title));
    const data = result?.structuredContent || result?.result || result;
    node.append(element('pre', JSON.stringify(data ?? {}, null, 2).slice(0, 120_000)));
    return node;
  }

  async function loadRea() {
    await loadMcp();
    const { notes } = await api('rea-notes');
    renderNotes(notes);
  }

  onClick('load-rea', loadRea);
  onClick('read-rea', async () => {
    const key = chosen('rea-select');
    if (!await confirmAction('连接所选 REA 服务，读取会话状态、留存证据和书签？')) return;
    const result = await api('rea', { key, workspaceUris: getWorkspaces() });
    if (!result.ok) throw new Error(result.stage + ' · ' + result.error);
    const labels = { binary_session: '会话状态', get_evidence_bundle: '证据与待核实问题', list_bookmarks: '函数书签' };
    $('rea-results').replaceChildren(...Object.entries(result.rea).map(([key, value]) => evidence(labels[key] || key, value)));
    status('已读取本次 REA 探测连接返回的结果。', 'ok');
  });
  onClick('import-evidence', () => $('evidence-file').click());
  readJsonFile('evidence-file', 8_000_000, (value) => {
    if (value === null || typeof value !== 'object') throw new Error('Evidence 文件应为 JSON 对象或数组。');
    const view = evidence('已导入的 Evidence JSON', value);
    view.open = true;
    $('rea-results').replaceChildren(view);
    status('Evidence 已在面板内打开。', 'ok');
  });

  function renderNotes(notes) {
    $('rea-notes').replaceChildren(...notes.map((note) => {
      const item = noteItem(note.type, note.text);
      const remove = element('button', '移除');
      remove.setAttribute('aria-label', '移除 ' + note.text);
      onClick(remove, async () => renderNotes((await api('rea-notes', { remove: note.id })).notes));
      item.append(remove);
      return item;
    }));
  }
  onClick('save-rea-note', async () => {
    const { notes } = await api('rea-notes', { note: { text: chosen('rea-note'), type: chosen('rea-note-type') } });
    $('rea-note').value = '';
    renderNotes(notes);
  });

  return { sessions: loadSessions, mcp: loadMcp, rules: loadRules, jobs: async () => {
    const results = await Promise.allSettled([loadJobs(), loadHooks()]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }, rea: loadRea };
}

