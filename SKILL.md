---
name: codex-monitor
version: 1.0.0
description: "监控并驱动本机 Codex 桌面版（ChatGPT.app 内置的 Codex）：查看每个会话是否正在跑、卡在哪一步、是否在等你拍板，并可以代替用户给指定会话派活或开新会话。当用户问『Codex 在干什么 / 进度如何 / 帮我看看它卡住没』，或要『让 Codex 去做某事 / 给它发消息 / 接管它的任务』时使用。不负责：Codex Cloud 远程任务、ChatGPT 网页版对话。"
metadata:
  requires:
    bins: ["codex", "python3"]
  cliHelp: "python3 codex_ctl.py --help"
---

# codex-monitor

用 `codex_ctl.py` 读写本机 Codex 的真实状态。用户也可以在 DSH 左侧栏的「Codex 监控」里直接看和派活：左侧是会话列表，右侧是这个会话的聊天窗口（排版与 DSH 对话一致：你说的话靠右带气泡，Codex 的话是流式正文 + 底部输入框），两条入口共用同一份实现。

它走两条通道：

- **状态**：`codex app-server` JSON-RPC（权威，能反映正在跑/已停下/等你回答）
- **明细**：`~/.codex/thread_history_1.sqlite`（正在执行的命令、改的文件、子 agent 活动）

两条通道共用桌面版同一份 `~/.codex`，所以看到的就是用户在 Codex 窗口里看到的。

## 命令

脚本路径：`~/.agents/skills/codex-monitor/codex_ctl.py`

```bash
# 所有会话 + 是否在跑 + 谁在等你回复
python3 ~/.agents/skills/codex-monitor/codex_ctl.py list [--limit N]

# 某个会话卡在哪、最近动作、待回答的问题
python3 ~/.agents/skills/codex-monitor/codex_ctl.py status [--thread ID] [--items N] [--json]

# 持续监控（有变化才打印）；--once 输出一次快照
python3 ~/.agents/skills/codex-monitor/codex_ctl.py watch [--interval 5] [--once]

# 给已有会话派活；--wait N 会等它跑完并打印回复
python3 ~/.agents/skills/codex-monitor/codex_ctl.py send --thread ID --message "..." [--wait 120]

# 在指定目录开新会话派活
python3 ~/.agents/skills/codex-monitor/codex_ctl.py new --cwd DIR --message "..." [--wait 120]

# 长驻 JSON 服务（DSH 插件用它；一个进程复用同一个 app-server）
python3 ~/.agents/skills/codex-monitor/codex_ctl.py serve [--port N]

# 机器可读输出：list / status / send 都支持 --json
python3 ~/.agents/skills/codex-monitor/codex_ctl.py send --thread ID --message "..." --json
```

`send --json` 失败时输出 `{"ok": false, "error": "..."}` 并以非零退出，便于判断是否真的送达。

## 使用要点

- **先 `list` 再动手**：拿到 `id=` 才能 `send`；不要凭标题猜 ID。
- **`list` 里的 `❓ 等你答`** 是 Codex 停下来等人拍板的会话，优先汇报给用户，附上选项。
- **`send` 默认只投递**（`--wait 0`）。用户要结果时才加 `--wait`，避免长时间阻塞。
- **`send` 会续接原会话上下文**，相当于用户自己在那个窗口里接着说话。
- **派活前确认目标会话**：写错 `--thread` 会把任务塞进无关项目。若用户没说清楚是哪个会话，先用 `list` 展示候选让用户选。
- **状态判断有明确优先级**：有待回答问题 → `waiting`；`turn.status` 是终态（`completed`/`failed`）→ 直接采信；`inProgress` → `running`；只有 `interrupted`/未知才回落到活动心跳（窗口 300s）。`thread_history_1.sqlite` 的 `inProgress` 会滞后几分钟，别单独拿它判断“是否在跑”。
- **`send` 需要长驻 app-server 才跑得完**：app-server 进程一退出，在飞的轮次会被标成 `interrupted`，任务等于没执行。所以要在同一个长驻进程里派活（插件用的是 `serve`）。如果看到轮次只跑了几十毫秒就 `interrupted`，就是这个原因。
- **同一个会话同一时刻只能有一个写入者**：面板开着时，CLI 对同一 thread `send` 会报 `already has an active writer`。改用面板，或先关掉它。
- **`watch` 是长任务**，要后台跑（`run_in_background`），别在前台阻塞；用户想“盯着它”时才用。

## 汇报格式建议

给用户总结时按这个结构，别贴原始输出：

1. 现在有几个会话在跑、几个在等他回复
2. 每个活跃会话：项目名 + 正在做什么（最近一条动作）+ 已跑多久
3. 需要他决策的：问题原文 + 可选项
4. 失败/停下的：一句话原因

## 边界

- 只读 + 派活，**不删会话、不改 Codex 配置**；`archive`/`delete` 一律不做，除非用户明确要求。
- 不要擅自替用户回答 Codex 的提问——把选项呈给用户，由他决定。
- `codex app-server proxy` 在本机因 CLI 与桌面版版本不一致而不通，不要走那条路。
