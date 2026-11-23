# codex-monitor UI 插件设计方案（待 review）

> 目标：把现有的 CLI 工具升级成 DSH 插件——在 DSH 界面里直接看到本机 Codex 各会话状态，
> 并能直接派活，不用切窗口、不用敲命令。

---

## 1. 结论先行

**能做成真正的 DSH 插件，但有一个关键取舍需要你拍板：数据通道怎么走。**

DSH 的 Client 拿 Host 数据，官方路径是 Typert Remote（`ctx.remote.*`）。这条路要求
**代码生成**（`@Remote` 装饰器 → 生成 `typert.host.js` 产物），而我手上只有发行版的
编译产物，没有源码构建链。所以我在方案里选了绕开代码生成的做法，见 §3。

---

## 2. UI 位置：左侧栏入口（已定）

按你的选择，采用 **`sidebar.panellist` + `main` 组合**——这正是 DSH 自带的 Plugins 页、
Automation tasks 页用的模式，是"左侧栏一个入口 + 主区一整页"的标准做法。

| 注册点 | 作用 |
|---|---|
| `sidebar.panellist` | 左侧栏一行图标 + 文字，可折叠成 rail 图标 + tooltip |
| `main`（keyed slot，key = `codex-monitor`） | 点开后占据主内容区的整页 |

这两个注册点的真实写法已从 `dsh-client-ui-schedule` 的 `lib/client.js:19355-19395` 抄到，
不是猜的。

**注意一个行为**：`ctx.layout.selectPanel(id)` 在选择未注册的 `main` 条目时会抛错。
所以图标行和整页必须同时注册，不能只注册入口。

相比之前的 A 方案（输入框细条），左侧栏入口的好处是：整页空间充裕，可以放下完整的
会话列表、详情、派活输入框，不必挤在一条细条里。代价是"扫一眼"要多一次点击。

**折中**：图标行在"有会话等你回答"时显示一个角标（`sidebar.toggle.badge` 是给折叠按钮的，
panellist 行没有角标槽位，我会在图标自绘一个红点）。这样不点开也知道有事。

---

## 3. 数据通道（核心取舍）

### 方案 A：自定义 HTTP 路由（推荐）

Host 侧用 `ctx.webServer.register({ kind: 'exact', path: '/codex-monitor/state', handler })`
注册路由，Client 用同源 `fetch` 拉 JSON。已确认 `ctx.webServer.register` 存在且被
`dsh-client-hmr` 这样使用。

- ✅ 不需要代码生成，纯手写即可
- ✅ 已确认 web server 在 `127.0.0.1:62155` 上以 HTTP 提供服务（页面本身就从这里加载，cookie 同源）
- ⚠️ **风险**：如果页面是从 `file://` 加载的（Electron 桌面壳的另一种模式），自定义路由不可达。
  当前你的 URL 是 `http://127.0.0.1:62155`，所以应该没问题，但**我会在第一步就验证**，
  不通过就立刻退回方案 B。

### 方案 B：不碰数据通道，Host 侧直接产出

放弃"Client 拉数据"，改成 Host 把状态写进 session 事件/投影，UI 只渲染投影。
这是 DSH 最正统的做法，但需要 `ctx.sessionProjections` 与 `wire.view` 配合，
**且投影只能描述当前会话**，无法表达"别的 Codex 会话"这种外部世界状态。**不适用。**

### 方案 C：走 Typert 代码生成

最正统，但需要 dsh 源码构建链，本机只有发行版产物。**当前不可行**，除非你愿意搭源码环境。

**结论：走方案 A，并把"路由可达性"作为第一道验证关卡。**

---

## 4. Host 侧设计

**核心原则：不重写业务逻辑。** Host 插件是薄适配层，直接调用已验证的 `codex_ctl.py`：

```
Client ──fetch──> Host route ──spawn──> python3 codex_ctl.py --json
                                              │
                                              ├─ codex app-server (JSON-RPC)  ← 派活
                                              └─ ~/.codex/*.sqlite            ← 实时状态
```

好处：单一实现，不会出现"UI 说在跑、CLI 说停了"的分裂。之前已经踩过一次两份副本漂移的坑
（`cp` 覆盖掉心跳逻辑），这次结构上避免。

### 接口

| 路由 | 方法 | 作用 |
|---|---|---|
| `/codex-monitor/state` | GET | 会话列表 + 状态 + 最近动作，轮询用 |
| `/codex-monitor/send` | POST | `{threadId, message}` 派活 |
| `/codex-monitor/status` | POST | `{threadId}` 单会话详情 |

`codex_ctl.py` 需要补一个 `--json` 的聚合输出（`list` 目前是纯文本）。
工作量小，且能顺手让 CLI 也支持脚本化。

### 环境依赖处理

Host 进程的 PATH 未必有 `python3`。策略：`CODEX_MONITOR_PYTHON` 环境变量 > `python3` > `/usr/bin/python3`，
启动时探测一次并缓存，失败时 UI 显示明确错误而不是白屏。

---

## 5. Client 侧设计

### 左侧栏入口行

```
┌──────────────────────┐
│  ◇  Codex 监控   ●   │   ← 有等待项时图标右上角一个警示点
└──────────────────────┘
```

折叠成 rail 时只显示图标，`label` 自动变成 tooltip。

### 主区整页

```
┌──────────────────────────────────────────────────────────┐
│ Codex 监控                                    ⟳ 刷新     │
│ 本机 5 个会话 · 2 正在跑 · 1 等你回复                     │
├──────────────────────────────────────────────────────────┤
│ ❓ 等你答   18:24  base-ui-component-lib                  │
│    是否允许删除本次采集误建的空白子记录 reczz28d4iCyXOMF… │
│    [ 查看详情 ]  [ 回复… ]                                │
├──────────────────────────────────────────────────────────┤
│ ▶ 正在跑   18:26  base-ui-component-lib                   │
│    思考: （推理中）                                       │
├──────────────────────────────────────────────────────────┤
│ ✓ 已完成   18:18  faster                                  │
│    与我讨论一下，faster 当前的设计…                        │
└──────────────────────────────────────────────────────────┘
```

- 「等你答」永远排最前，带警示色
- 点击行展开详情（复用 `status --json`：当前轮次、最近 8 条动作、完整提问 + 选项）
- 「回复…」就地出输入框 → POST `/send`，发送后该行变「投递中」
- 空状态、加载失败、python 缺失各有明确文案

- 每行：状态点 + 时间 + 项目名 + 最近动作摘要
- 「等你答」行永远排最前，带警示色
- 点击行展开详情（复用 `status --json`：当前轮次、最近 8 条动作、完整提问）
- 「回复…」就地出输入框 → POST `/send`，发送后该行变「投递中」
- 空状态、加载失败、python 缺失各有明确文案

### 视觉一致性（DSH 硬性要求）

- 只用 `--dsw-alias-*` 主题令牌，不写死颜色，自动跟随明暗
- 文案走 `ctx.locale`，中英文都提供
- 自绘控件（不复用 `dsh-client-ui-primitives`，那是禁止的）
- 所有注册在 `apply` 内用 `ctx.effect` 包裹并返回清理函数

### 轮询策略

左侧栏图标会常驻，**不能高频轮询拖慢界面**：

- 主区页可见时 5s 轮询；图标角标用 30s 低频轮询（只为算红点）
- 页面不可见（`document.hidden`）时暂停
- 组件卸载/插件卸载立即清定时器
- 每次请求带 AbortSignal，避免卸载后仍写 state

---

## 6. 文件结构

复用现有仓库 `maxjchuang/codex-monitor`，加一个 `plugin/` 子目录：

```
codex-monitor/
├── codex_ctl.py              # 现有 CLI（唯一业务实现）
├── tests/                    # 现有 16 个测试
└── plugin/
    ├── package.json          # dsh.bundle + dsh.client
    ├── cordis.patch.yml
    ├── index.js              # Host：注册路由 + spawn python
    ├── client.js             # Client：React UI
    ├── codex_ctl.py          # 打包副本（由 sync 脚本从根目录复制）
    ├── locale/{en,zh}.json
    ├── icon.svg
    └── docs/DETAIL.md        # 插件详情页
```

---

## 7. 实施步骤（分阶段，每步可停）

1. **可行性验证（30 分钟）**：装一个最小插件，注册左侧栏图标 + 一个只显示 `ping` 结果的主区页，
   页面内 fetch `/codex-monitor/ping` 确认路由可达、图标可见可点。
   **这一步不过，方案作废，回来重新商量。**
2. Host 半：路由 + `codex_ctl.py --json` + 错误处理
3. Client 半：左侧栏图标 + 主区列表页（只读，不带派活）
4. 加派活：输入框 + POST /send
5. 图标、详情页、中英文案，跑用户体验 review
6. 推送 GitHub，更新 README 和 SKILL.md

---

## 8. 我明确不做的

- ❌ 不替你回答 Codex 的提问（只呈现选项）——这条已有约定，UI 也遵守
- ❌ 不做"停止 Codex 任务"——CLI 都没有，UI 也不该先有
- ❌ 不做 Codex Cloud / ChatGPT 网页版
- ❌ 不写预览 HTML 假装成品（DSH 明确禁止），直接用装好的插件验收

---

## 9. 还需要你确认的两件事

1. ~~位置~~ → **已定：左侧栏入口**（`sidebar.panellist` + `main` 整页）
2. **派活要不要在 v1 就上**？还是先只读监控，确认好用再加？
3. **仓库形态**：放同一个仓库的 `plugin/` 子目录，还是单独开一个 `codex-monitor-plugin` 仓库？

---

## 10. 已核实的事实（避免我后面说"应该可以"）

| 事实 | 怎么核实的 |
|---|---|
| `ctx.webServer.register({kind:'exact',path,handler})` 可用 | 读 `dsh-client-hmr/lib/index.js:141` |
| `sidebar.panellist` + `main` 是左栏入口+整页的标准组合 | 读 `dsh-client-ui-sidebar/README.md` 与 `dsh-client-ui-schedule/lib/client.js:19355` |
| `ctx.layout.selectPanel` 选未注册 main 会抛错 | 读 `dsh-client-ui-layout/lib/client.js:523` |
| 主题令牌 `--dsw-alias-state-warn-primary` 等存在 | 从 `dsh-client-ui-theme` 提取 |
| Web server 以 HTTP 在 62155 提供服务 | `lsof` + `curl` 返回 401（需鉴权但端口在） |
| 自定义 Remote 命名空间需要代码生成 | 读 `dsh-api-remotes` 的 `$mount` 与 typert 产物 |
| Electron 可能以 `file://` 加载 dist | 读 `dsh-host-webserver/README.md` |

**未核实（实施第一步就要验）**：插件注册的自定义路由能否被页面同源 fetch 到。
