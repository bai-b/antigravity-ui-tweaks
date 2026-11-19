# Antigravity 界面调校台

在 Antigravity 辅助侧栏调主题、浏览会话和检查本机插件。打开入口是 `[界面调校台](sidecar://antigravity-ui-tweaks/theme/)`。

| 面板 | 功能 |
| --- | --- |
| 主题 | 自动配板、普通文本 WCAG AA 对比度、预览、JSON 配方、自定义字体和密度、目标窗口令牌探测、临时应用、恢复历史、单次渲染截图和像素差异 |
| 会话 | 本机会话按项目筛选、跳转、Markdown 导出、日志时间线、工具名称和日志可用的 Token 字段、打开文件和附加评论 |
| MCP | 读取全局、活动工作区和插件配置，检查程序、端口、独立 MCP 握手、工具清单和服务报错，向宿主请求凭据刷新 |
| 规则 | 盘点全局、活动工作区和插件中的 Skills 与规则，启停独立文件，保存与移除工作区的 AGENTS.md 片段 |
| 任务与 Hooks | 已有 schedule 任务与下次运行估算、最近日志、受支持的手动运行、只读的工具阶段审计 |
| REA | 查询配置的 REA MCP 服务，读会话摘要、Evidence 和书签，导入 Evidence JSON、登记待核实项与本地函数书签 |

## 安装与入口

需要 Windows 上的 Antigravity App 和 PATH 里的 Node.js 22.13 或更新版本（会话库用 `node:sqlite`）。`install.py` 会在部署前读取 `node --version`，版本不够直接停下并给出提示。由安装者在 Antigravity 的任务结束后安排安装和重启。

```powershell
python -B install.py
```

不必先退出 Antigravity：安装只复制文件并原子改写 `config.json`，宿主既不监听插件目录，也不会在运行中回写配置文件。但 sidecar 由 App 的 `language_server` 在启动时枚举，App 侧没有热加载入口，所以装完要重启一次 App 才会出现在 Customizations 和侧栏里。装完用 `python -B install.py --verify` 回读磁盘确认插件目录、版本、sidecar 条目是否就位；它只读不写，没有装好时以非零状态退出。

安装会把源码包中的插件副本部署到 `%USERPROFILE%\.gemini\config\plugins\antigravity-ui-tweaks`，并为 `antigravity-ui-tweaks/theme` 启用 Sidecar。之后可在宿主的插件面板打开，或点击对话里的 Sidecar 链接。重装时上一版会整目录改名到 `~/.gemini/config/.ui-tweaks-backups/install-<时间戳>`，既是回滚点也保住自己改过的配方；部署失败会自动把备份改回原位。运行 `python -B install.py --uninstall` 会移除插件、Sidecar 配置项和本插件的全局审计 Hook。配方、书签和已有备份留在用户数据目录。

## 主题应用

- **面板预览**可直接生成配色、检查对比度和导出 JSON。统计的是指定普通文本色对，透明色的对比根据预览背景计算。
- **临时应用**需要宿主暴露调试端口。端口按顺序取自环境变量 `AGY_UI_TWEAKS_CDP_PORT`、`DevToolsActivePort` 和 `daemon/hub_*.json` 里的 `devToolsPort`/`cdpPort`，`DevToolsActivePort` 缺失也能找到窗口。先检测并选择窗口，再探测令牌或应用。调校台用宿主本地服务和页面标记核对目标。探测会把窗口里存在、但内置清单没有的令牌（`--shell`、`--onyx-*`、`--chart-*`、`--cta` 等）并入调色板，最多 80 个，避免只改半套皮肤。侧栏宽度、隐藏区块和密度取决于所选版本的 CSS 令牌与选择器命中情况。
- **切换主题**时宿主会把新令牌写成内联变量，注入的 `!important` 会盖住它们，所以面板收到 `theme-change` 后会撤掉自己注入的临时样式，并提示重新应用。
- **截图对比**每次点击取选定渲染窗口的一帧。两帧尺寸相同时可以生成像素差异图，截图和差异图保留在当前面板内。
- **主题配方**持久保存到 `~/.gemini/config/.ui-tweaks-data/options.json`，工作区绑定使用工作区 URI 集合。系统或时段切换在面板打开时更新预览。打开自动应用开关后，同一个会话必须匹配到唯一渲染窗口才会应用。临时样式历史按窗口保留最近 30 条，Sidecar 重启后重新开始记录。
- **写入宿主配置**保存浅色或深色的底色、前景和主色种子，也可以切换主题模式。写入前会备份 `config.json` 到 `~/.gemini/config/.ui-tweaks-backups/`。新配置在宿主下次启动时读取。

## 诊断口径

- 会话使用本地 SQLite 索引和会话日志，缺日志时尝试读搜索索引片段。导出会标记来源和截断。Token 使用日志已经记录的字段，缓存读取是单列。
- MCP 探测使用配置启动独立 stdio 进程或连接 HTTP 端点。已有进程的会话状态可能和探测进程不同。宿主管理的 OAuth 凭据由宿主刷新。界面显示经过整理的连接和状态字段，探测不输出配置中的密钥。
- 插件与内置组件只在面板里列出，启停一律交给宿主的 Customizations 开关，调校台不改它们的文件。独立规则与 Skill 默认同样跟随宿主；确认「离线停用」才把文件改名成 `*.ui-tweaks-disabled`，此时宿主面板可能仍显示为已启用，面板与返回值都会标注。注入 AGENTS.md 时只更新带有调校台标记的片段，并备份原文。
- 自动化的下次时间是从五字段 cron 推算。手动运行只要求命令含 `new-conversation`、消息不含模板变量、程序能在 PATH 上找到；参数顺序不限，`--model x` 与 `--model=x` 都认。不满足时任务表直接给出原因（已停用、缺少项目、找不到程序等）。权限授予仍由宿主 Automations 管理。
- 启用 Hooks 审计后，调校台在全局 `hooks.json` 添加自己的事件订阅，只订阅 `SessionStart` 与 `PostToolUse`。它不订阅 `PreToolUse`：那个事件的 `decision` 会直接接管权限流程（`allow` 等于自动放行），审计不该有投票权。日志只记录时间、工具名、阶段和可用的结果字段。
- REA 查询读取所选服务连接上的会话与已保留证据。隔离的 stdio 连接可能没有宿主当前分析状态，可从原会话导出 Evidence 后导入面板。

## 测试

```powershell
node --test "tests/*.test.mjs"
```

覆盖配色推导与校验边界、对比度、cron 推算（含 `CRON_TZ`）、自动化参数解析与可运行判定、启停的宿主与离线两种模式、配置写入的串行化、备份与乐观并发。测试只碰临时目录，不读写真实宿主配置。

Sidecar 与 Web UI 可使用工作区的 SDK 参考版本以及隔离的配置、数据库和浏览器做验证。真实桌面端的窗口匹配、Agent 消息、文件导航、凭据刷新和 Hooks 接收以实际安装版本的验收结果为准。

