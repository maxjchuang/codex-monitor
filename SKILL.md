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

用 `codex_ctl.py` 读写本机 Codex 的真实状态。它走两条通道：

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
```

## 使用要点

- **先 `list` 再动手**：拿到 `id=` 才能 `send`；不要凭标题猜 ID。
- **`list` 里的 `❓ 等你答`** 是 Codex 停下来等人拍板的会话，优先汇报给用户，附上选项。
- **`send` 默认只投递**（`--wait 0`）。用户要结果时才加 `--wait`，避免长时间阻塞。
- **`send` 会续接原会话上下文**，相当于用户自己在那个窗口里接着说话。
- **派活前确认目标会话**：写错 `--thread` 会把任务塞进无关项目。若用户没说清楚是哪个会话，先用 `list` 展示候选让用户选。
- **状态判断以 app-server 为准**。`thread_history_1.sqlite` 的 `inProgress` 会滞后几分钟，别用它判断“是否在跑”。
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
