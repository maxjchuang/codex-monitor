/**
 * Client half of codex-monitor.
 *
 * One sidebar entry (`sidebar.panellist`) plus one full page (`main`). The page is a
 * two-pane layout: sessions on the left, the selected session's conversation on the
 * right, with a composer that appends a turn to it.
 *
 * Both the sidebar badge and the page read one shared snapshot, so they cannot disagree.
 */
window.__ModuleLoader__.load({
  id: '@local/codex-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useCallback } = React

    const NS = 'codex-monitor'
    // 记住上次打开的会话：关掉面板再打开应该回到原处，而不是跳回列表第一个。
    // 存 id 而不是下标——列表顺序会随活跃度变，下标第二天就指向别的会话了。
    const LAST_KEY = NS + '.lastSession'

    function readLastSession() {
      try {
        const raw = localStorage.getItem(LAST_KEY)
        return raw && raw.trim() ? raw : null
      } catch {
        // 隐私模式或存储被禁用时读不到，按没有处理。
        return null
      }
    }

    function writeLastSession(id) {
      try {
        if (id) localStorage.setItem(LAST_KEY, id)
        else localStorage.removeItem(LAST_KEY)
      } catch {
        // 存不下就算了，只是少个记忆功能，不该影响使用。
      }
    }
    // 每次请求带多少条对话。首屏和「向上滚加载更多」用同一个值：
    // 太小要滚好几次，太大就失去分页的意义（200 条约 500KB）。
    const TRANSCRIPT_PAGE = 40
    const PANEL_ID = 'codex-monitor'

    // ── copy ────────────────────────────────────────────────────────────────
    const zh = {
      'panel.label': 'Codex 监控',
      'panel.labelWaiting': 'Codex 监控（{n} 个等你回答）',
      'page.title': 'Codex 监控',
      'page.refresh': '刷新',
      'page.empty': '没读到 Codex 会话。请确认 ~/.codex 存在，且桌面版至少跑过一次。',
      'page.errorTitle': '读取 Codex 状态失败',
      'page.retry': '重试',
      'page.pythonMissing': '这台机器上找不到 python3。请把路径设到 CODEX_MONITOR_PYTHON 后重新加载插件。',
      'page.counts': '{total} 个会话 · {running} 正在跑 · {waiting} 等你回复',
      'page.updated': '更新于 {time}',
      'list.title': '会话',
      'list.pinned': '置顶',
      'list.groupBy': '分组方式',
      'list.byProject': '按项目',
      'list.byRecent': '按最近',
      'list.empty': '还没有会话',
      'list.show': '展开会话列表',
      'list.hide': '收起会话列表',
      'list.groupWaiting': '{n} 个等你回答',
      'list.groupRunning': '{n} 个正在跑',
      'list.showMore': '展开显示 {n} 个',
      'state.running': '正在跑',
      'state.waiting': '等你回答',
      'state.done': '已完成',
      'state.failed': '失败',
      'state.stopped': '已停下',
      'state.idle': '空闲',
      'row.model': '模型',
      'row.directory': '目录',
      'row.id': '会话',
      'row.started': '开始 {time}',
      'row.duration': '用时 {seconds}s',
      'row.timing': '计时中',
      'chat.placeholderPick': '从左边选一个会话，看它做到哪一步。',
      'chat.placeholderPickHint': '也可以直接在这里给它派活。',
      'chat.loading': '正在读取对话…',
      'chat.empty': '这个会话还没有内容。',
      'chat.error': '读不到这个会话：{error}',
      'chat.retry': '重试',
      'chat.you': '你',
      'chat.agent': 'Codex',
      'chat.askingYou': 'Codex 在等你回答',
      'chat.transcriptTruncated': '只显示最近 {n} 条。',
      'chat.loadMore': '加载更早的消息',
      'chat.loadingMore': '正在加载更早的消息…',
      'chat.actionRun': '共 {n} 步',
      'work.elapsed': '用时 {time}',
      'work.elapsedShort': '用时 {n} 秒',
      'work.steps': '{n} 步过程',
      'work.expand': '展开过程',
      'work.collapse': '收起过程',
      'reply.placeholder': '给这个 Codex 会话发消息…',
      'reply.send': '发送',
      'reply.sending': '发送中…',
      'reply.cancel': '取消',
      'reply.sent': '已提交给 Codex，稍后会处理。',
      'reply.deliveryFailed': '这条没发出去：{error}。内容还在，可以再发一次。',
      'reply.deliveryFailedNoReason': '这条没发出去，原因未知。内容还在，可以再发一次。',
      'reply.failed': '投递失败：{error}',
      'reply.busy': '这个会话正被 Codex 占着（在桌面端里开着）。在 Codex 里切到别的会话，或关掉它，再发送。',
      'reply.queued': '已排队。这个会话正被占着，等它释放后会自动投递，不用你再来点一次。',
      // 交给桌面端自己的队列：执行发生在原会话，节奏由桌面端决定。
      'reply.handedOver': '会话在 Codex 桌面端开着，消息已交给它，由它接收并执行。'
        + '执行时机取决于桌面端，回到原会话就能看到进度。',
      'reply.handedOverUncertain': '消息可能已经交给 Codex 桌面端了，结果未能确认。'
        + '请到原会话确认，不要重复发送。',
      'reply.lockedBusy': 'Codex 正在跑这个会话，这会儿插不进去。你可以先写下来，点发送会排队，这一轮结束自动投递。',
      'reply.lockedIdle': 'Codex 桌面端开着这个会话，一直占着不放。现在发会排队；关掉 Codex 桌面端就立刻投递。',
      'reply.lockedUnknown': '这个会话被另一个进程占着，暂时不能投递。关掉占用它的程序后这里会自动恢复。',
      'chat.imageAlt': '用户附的图 {n}',
      'reply.note': '追加为新的一轮，不打断正在跑的任务。Enter 发送，Shift+Enter 换行。',
      'reply.options': 'Codex 给出的选项（点击填入，需你自己发送）：',
    }
    const en = {
      'panel.label': 'Codex monitor',
      'panel.labelWaiting': 'Codex monitor ({n} waiting)',
      'page.title': 'Codex monitor',
      'page.refresh': 'Refresh',
      'page.empty': 'No Codex sessions found. Check that ~/.codex exists and the desktop app has run at least once.',
      'page.errorTitle': 'Could not read Codex state',
      'page.retry': 'Retry',
      'page.pythonMissing': 'python3 was not found. Set CODEX_MONITOR_PYTHON to its path and reload the plugin.',
      'page.counts': '{total} sessions · {running} running · {waiting} waiting',
      'page.updated': 'Updated {time}',
      'list.title': 'Sessions',
      'list.pinned': 'Pinned',
      'list.groupBy': 'Group by',
      'list.byProject': 'Project',
      'list.byRecent': 'Recent',
      'list.empty': 'No sessions yet',
      'list.show': 'Show session list',
      'list.hide': 'Hide session list',
      'list.groupWaiting': '{n} waiting',
      'list.groupRunning': '{n} running',
      'list.showMore': 'Show {n} more',
      'state.running': 'Running',
      'state.waiting': 'Waiting for you',
      'state.done': 'Done',
      'state.failed': 'Failed',
      'state.stopped': 'Stopped',
      'state.idle': 'Idle',
      'row.model': 'Model',
      'row.directory': 'Directory',
      'row.id': 'Session',
      'row.started': 'Started {time}',
      'row.duration': 'Took {seconds}s',
      'row.timing': 'Timing',
      'chat.placeholderPick': 'Pick a session on the left to see where it got to.',
      'chat.placeholderPickHint': 'You can also dispatch work to it from here.',
      'chat.loading': 'Reading the conversation…',
      'chat.empty': 'This session has no messages yet.',
      'chat.error': 'Could not read this session: {error}',
      'chat.retry': 'Retry',
      'chat.you': 'You',
      'chat.agent': 'Codex',
      'chat.askingYou': 'Codex is waiting for your answer',
      'chat.transcriptTruncated': 'Showing the latest {n} entries only.',
      'chat.loadMore': 'Load earlier messages',
      'chat.loadingMore': 'Loading earlier messages…',
      'chat.actionRun': '{n} steps',
      'work.elapsed': 'Took {time}',
      'work.elapsedShort': 'Took {n}s',
      'work.steps': '{n} steps',
      'work.expand': 'Show work',
      'work.collapse': 'Hide work',
      'reply.placeholder': 'Message this Codex session…',
      'reply.send': 'Send',
      'reply.sending': 'Sending…',
      'reply.cancel': 'Cancel',
      'reply.sent': 'Submitted to Codex; it will pick this up shortly.',
      'reply.deliveryFailed': 'This did not go through: {error}. Your text is still here; send it again.',
      'reply.deliveryFailedNoReason': 'This did not go through, reason unknown. Your text is still here; send it again.',
      'reply.failed': 'Could not deliver: {error}',
      'reply.busy': 'Codex is holding this session open. Switch to another session in Codex, or close it, then send again.',
      'reply.queued': 'Queued. This session is held right now; it will be delivered automatically once released, with no need to send again.',
      'reply.handedOver': 'Codex desktop has this session open, so the message was handed to it.'
        + ' It will pick it up and run it in the original session, at its own pace.',
      'reply.handedOverUncertain': 'The message may already have reached Codex desktop, but this could not be confirmed.'
        + ' Check the original session before sending again.',
      'reply.lockedBusy': 'Codex is running this session right now, so nothing can be inserted. You can still write and send: it will be queued and delivered when this turn ends.',
      'reply.lockedIdle': 'The Codex desktop app holds this session even while idle. Sending now will queue; closing the desktop app delivers it right away.',
      'reply.lockedUnknown': 'Another process holds this session, so it cannot take a message right now. This clears once that program lets go.',
      'chat.imageAlt': 'Attached image {n}',
      'reply.note': 'Appends a new turn; does not interrupt work already running. Enter sends, Shift+Enter for a new line.',
      'reply.options': 'Options Codex offered (click to fill in, you still send):',
    }

    // ── transport ───────────────────────────────────────────────────────────
    // The shell may own a request carrier (desktop IPC); fall back to page fetch.
    const carrier = () => globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis)

    async function call(method, path, body, signal) {
      const init = { method, signal, headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await carrier()(path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload?.ok === false) {
        const error = payload?.error ?? `HTTP ${response.status}`
        const failure = new Error(error)
        failure.missingPython = response.status === 503
        // 会话被别的进程占着（通常是在 Codex 桌面端里开着），不是错误而是状态。
        failure.threadBusy = payload?.busy === true || response.status === 409
        throw failure
      }
      return payload
    }

    // ── shared snapshot ─────────────────────────────────────────────────────
    function createMonitor() {
      let snapshot = { phase: 'loading', data: null, error: null, missingPython: false }
      const listeners = new Set()
      let pageMounted = 0
      return {
        get: () => snapshot,
        set(next) {
          snapshot = next
          listeners.forEach((listener) => listener())
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        mountPage() {
          pageMounted += 1
          return () => {
            pageMounted -= 1
          }
        },
        busy: () => pageMounted > 0,
      }
    }

    const monitor = createMonitor()

    function useSnapshot() {
      return useSyncExternalStore(monitor.subscribe, monitor.get, monitor.get)
    }

    // ── formatting ──────────────────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, '0')
    const clock = (seconds) => {
      if (!seconds) return '--:--'
      const d = new Date(seconds * 1000)
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    /** 时长照 Codex 的写法：「6分钟29秒」。不足一分钟只说秒。 */
    const elapsed = (ms) => {
      if (!ms || ms < 0) return null
      const total = Math.round(ms / 1000)
      if (total < 60) return `${total} 秒`
      const m = Math.floor(total / 60)
      const s = total % 60
      return s === 0 ? `${m} 分钟` : `${m} 分钟 ${s} 秒`
    }
    const STATE_TOKEN = {
      running: 'business',
      waiting: 'warn',
      done: 'success',
      failed: 'error',
      stopped: 'idle',
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = `
.cxm-page{height:100%;display:flex;overflow:hidden;box-sizing:border-box;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:var(--dsh-content-font-size,14px)}

/* left: session list
   Row metrics are taken from DSH's own workspace tree
   (dsh-client-ui-workspace: .sessionRow / .projectRow) rather than invented, so the
   list reads as part of the host UI: 32px session rows, 34px project rows, a 16x20
   icon slot, 12px row padding, 6px icon-to-label gap, and 12px per nesting level. */
.cxm-list-pane{flex:none;width:clamp(240px,30%,360px);display:flex;flex-direction:column;
  min-height:0;border-right:1px solid var(--dsw-alias-border-l3);
  transition:width .18s var(--ds-ease-in-out)}
/* 收起时列表整个让位给对话：不是折叠成窄条，因为窄条在手机上仍然占地方，
   而且没有能表达会话内容的宽度。 */
.cxm-list-pane[data-open='false']{display:none}

/* 列表开合开关：在对话区标题栏左侧，收起后仍然能看见它，否则就找不回来了。 */
.cxm-list-toggle{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.cxm-list-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary)}
.cxm-list-toggle:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:-2px}
/* 空态也要能开列表，所以标题栏独立于是否选中会话存在。 */
.cxm-chat-top{flex:none;display:flex;align-items:center;gap:8px;
  padding:calc(16px + var(--dsh-frame-top-clearance,0px)) 24px 0}
.cxm-list-head{padding:calc(20px + var(--dsh-frame-top-clearance,0px)) 14px 10px}
/* DSH 的侧栏标题行是 flex-start + gap，动作紧跟在标题后面，
   不是撑到最右边（space-between）。标题短的时候那样会空出一大片。 */
.cxm-list-title{margin:0;font-size:14px;font-weight:500;display:flex;align-items:center;
  gap:6px;justify-content:flex-start}
/* 分组切换：两个小段，选中的那个用浅底强调。 */
.cxm-seg{display:inline-flex;align-items:center;gap:2px;margin-left:auto;flex:none;
  padding:2px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-interactive-bg-hover)}
.cxm-seg-btn{border:0;background:none;cursor:pointer;font-family:inherit;
  font-size:11px;line-height:16px;padding:2px 6px;border-radius:var(--dsw-radius-xs);
  color:var(--dsw-alias-label-tertiary);transition:background-color .1s,color .1s}
.cxm-seg-btn[data-active='true']{background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary)}
.cxm-seg-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:1px}
.cxm-list-counts{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:4px;
  line-height:20px}
.cxm-list-body{flex:1;min-height:0;overflow:auto;padding:0 8px 16px;display:flex;
  flex-direction:column}

/* Shared row geometry: one line, icon slot, ellipsised title. */
.cxm-row,.cxm-group-head,.cxm-group-more{display:flex;align-items:center;
  box-sizing:border-box;width:100%;text-align:left;border:0;font-family:inherit;
  background:transparent;cursor:pointer;color:var(--dsw-alias-label-primary);
  border-radius:var(--dsw-radius-md);padding:0 8px;gap:var(--dsh-sidebar-label-gap,6px)}
.cxm-row:hover,.cxm-group-head:hover,.cxm-group-more:hover{
  background:var(--dsw-alias-interactive-bg-hover)}
.cxm-row[data-selected='true']{background:var(--dsw-alias-interactive-bg-hover)}
.cxm-row:focus-visible,.cxm-group-head:focus-visible,.cxm-group-more:focus-visible{
  outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}

/* session row: 32px, indented one level under its project */
.cxm-row{height:32px;padding-inline-start:calc(12px + 12px)}
.cxm-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;
  justify-content:center;color:var(--dsw-alias-label-tertiary)}
.cxm-dot{width:6px;height:6px;border-radius:50%;flex:none}
.cxm-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:14px;line-height:20px}
.cxm-row-time{flex:none;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
/* A session that waits on the user is the one thing worth breaking the one-line
   rhythm for, so it carries the question as a second line. */
.cxm-row[data-waiting='true']{height:auto;min-height:32px;padding-block:6px;
  flex-wrap:wrap;align-items:flex-start}
.cxm-row[data-waiting='true'] .cxm-slot{margin-top:6px}
.cxm-row[data-waiting='true'] .cxm-row-name{white-space:normal;overflow:visible}
.cxm-row-ask{flex:1 0 100%;color:var(--dsw-alias-state-warn-label);font-size:12px;
  line-height:18px;padding-left:calc(16px + var(--dsh-sidebar-label-gap,6px));
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}

/* project row: 34px, folder glyph that turns into a chevron on hover, as in DSH */
.cxm-group-head{height:34px;color:var(--dsw-alias-label-secondary);margin-top:6px}
.cxm-group-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;
  justify-content:center;color:var(--dsw-alias-label-tertiary)}
/* 箭头画的是「指向右」的形状；DSH 用旋转来表达开合：
   收起时指右，展开时转 90° 指下。旋转放在内层 svg 上，避免影响布局。 */
.cxm-group-chevron{display:none;align-items:center;justify-content:center}
.cxm-group-chevron svg{transition:transform .15s var(--ds-ease-in-out)}
.cxm-group-head[data-collapsed='true'] .cxm-group-chevron svg{transform:rotate(0deg)}
.cxm-group-head[data-collapsed='false'] .cxm-group-chevron svg{transform:rotate(90deg)}
.cxm-group-head:hover .cxm-group-folder{display:none}
.cxm-group-head:hover .cxm-group-chevron{display:inline-flex}
.cxm-group-head[data-collapsed='true'] .cxm-group-folder{display:none}
.cxm-group-head[data-collapsed='true'] .cxm-group-chevron{display:inline-flex}
.cxm-group-name{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:14px;line-height:20px;font-weight:400}
/* The name outranks the badge: a truncated project name defeats the grouping, so
   the badge shrinks to nothing when space runs out. */
.cxm-group-head .cxm-chip{flex:0 1 auto;min-width:0;overflow:hidden}
.cxm-group-count{flex:none;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-caption);font-size:12px;line-height:20px}
.cxm-group-more{height:28px;padding-inline-start:calc(12px + 12px + 16px + 6px);
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}

.cxm-chip{font-size:10px;padding:1px 6px;border-radius:999px;white-space:nowrap;flex:none;
  line-height:1.7;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.cxm-chip[data-tone='warn']{background:var(--dsw-alias-state-warn-tertiary);
  color:var(--dsw-alias-state-warn-label)}
.cxm-chip[data-tone='business']{background:var(--dsw-alias-state-business-tertiary);
  color:var(--dsw-alias-state-business-primary)}

/* right: conversation */
.cxm-chat-pane{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;
  background:var(--dsw-alias-bg-base)}
.cxm-chat-head{flex:none;padding:calc(16px + var(--dsh-frame-top-clearance,0px)) 24px 12px;
  display:flex;gap:10px;align-items:center;justify-content:space-between}
/* 开合按钮和标题首行视觉对齐：标题 22px 行高，按钮 28px，用负外边距把它提上来。 */
.cxm-chat-head > .cxm-list-toggle{margin-top:-2px}
.cxm-chat-titles{min-width:0;flex:1}
.cxm-chat-name{margin:0;font-size:15px;font-weight:500;line-height:22px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxm-chat-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;
  margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxm-chat-side{display:flex;align-items:center;gap:8px;flex:none}

/* Transcript follows the native conversation rhythm: one centred column, a 16px
   flow gap, and no bubble around assistant text. */
/* 容器本身不设 smooth。DSH 也是 scroll-behavior:auto，平滑只在需要时由 JS
   显式指定。全局开 smooth 会让「切会话时贴到底部」这个赋值也变成动画，
   看起来就是打开会话先滚一遍。 */
.cxm-transcript{flex:1;min-height:0;overflow:auto;box-sizing:border-box;
  padding:16px 24px 8px;display:flex;flex-direction:column}
.cxm-flow{width:100%;max-width:min(100%,920px);margin:0 auto;display:flex;
  flex-direction:column;gap:12px;min-width:0}

/* user: right-aligned bubble, deepseek-tinted */
.cxm-msg[data-role='user']{display:flex;flex-direction:column;align-items:flex-end;gap:6px;
  min-width:0}
.cxm-msg[data-role='user'] .cxm-bubble{
  max-width:min(calc(min(100%,920px) * .702),82%);border-radius:var(--dsw-radius-xl);
  background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);
  padding:10px 16px;font-size:var(--dsh-content-font-size,14px);
  line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;
  overflow-wrap:anywhere}

/* assistant: plain flowing text, no chrome */
.cxm-msg[data-role='agent']{display:flex;flex-direction:column;gap:10px;min-width:0}
.cxm-msg[data-role='agent']+.cxm-action,.cxm-action+.cxm-action{margin-top:-4px}
.cxm-msg[data-role='agent'] .cxm-bubble{
  max-width:100%;color:var(--dsw-alias-label-primary);
  font-size:var(--dsh-content-font-size,14px);
  line-height:calc(24px + var(--dsh-content-font-delta,0px));
  white-space:pre-wrap;overflow-wrap:anywhere;padding:0;background:none;border:0}

/* markdown inside a reply: compact, and quieter than the prose around it */
.cxm-md-p{margin:0}
/* Any two adjacent blocks get breathing room. Enumerating the combinations missed
   pairs such as a list followed by a table, so the rhythm is set in one place. */
.cxm-bubble>.cxm-md-p+.cxm-md-p,.cxm-bubble>.cxm-md-p+.cxm-md-list,
.cxm-bubble>.cxm-md-p+.cxm-md-pre,.cxm-bubble>.cxm-md-p+.cxm-md-table-wrap,
.cxm-bubble>.cxm-md-p+.cxm-md-h,.cxm-bubble>.cxm-md-list+.cxm-md-p,
.cxm-bubble>.cxm-md-list+.cxm-md-list,.cxm-bubble>.cxm-md-list+.cxm-md-pre,
.cxm-bubble>.cxm-md-list+.cxm-md-table-wrap,.cxm-bubble>.cxm-md-list+.cxm-md-h,
.cxm-bubble>.cxm-md-pre+.cxm-md-p,.cxm-bubble>.cxm-md-pre+.cxm-md-list,
.cxm-bubble>.cxm-md-pre+.cxm-md-table-wrap,.cxm-bubble>.cxm-md-pre+.cxm-md-h,
.cxm-bubble>.cxm-md-table-wrap+.cxm-md-p,.cxm-bubble>.cxm-md-table-wrap+.cxm-md-list,
.cxm-bubble>.cxm-md-table-wrap+.cxm-md-table-wrap,
.cxm-bubble>.cxm-md-table-wrap+.cxm-md-h,.cxm-bubble>.cxm-md-h+.cxm-md-p,
.cxm-bubble>.cxm-md-h+.cxm-md-list,.cxm-bubble>.cxm-md-h+.cxm-md-pre,
.cxm-bubble>.cxm-md-h+.cxm-md-table-wrap,.cxm-bubble>.cxm-md-h+.cxm-md-h{
  margin-top:10px}
.cxm-md-h{margin:14px 0 6px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.cxm-md-h:first-child{margin-top:0}
.cxm-md-code{font:var(--dsw-font-markdown-code-block-small);
  background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-xs,4px);
  padding:1px 5px;overflow-wrap:anywhere}
.cxm-md-pre{box-sizing:border-box;margin:0;padding:10px 12px;overflow:auto;
  background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-md);
  border:.5px solid var(--dsw-alias-border-l1);max-width:100%}
.cxm-md-pre code{font:var(--dsw-font-markdown-code-block-small);white-space:pre;
  color:var(--dsw-alias-label-primary)}
.cxm-md-link{color:var(--dsw-alias-link);text-decoration:none}
.cxm-md-link:hover{text-decoration:underline}
.cxm-md-list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}
.cxm-md-list li{min-width:0}
.cxm-md-quote{margin:0;padding:2px 0 2px 12px;
  border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.cxm-md-hr{border:0;border-top:.5px solid var(--dsw-alias-border-l2);margin:12px 0}
.cxm-md-table-wrap{margin:0;max-width:100%;overflow:auto;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.cxm-md-table{border-collapse:collapse;width:100%;font-size:13px;line-height:20px}
.cxm-md-table th,.cxm-md-table td{padding:6px 10px;text-align:left;
  border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top}
.cxm-md-table th{font-weight:500;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-markdown-code-block);white-space:nowrap}
.cxm-md-table tr:last-child td{border-bottom:0}

.cxm-stamp{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;
  font-variant-numeric:tabular-nums}

/* action: a quiet disclosure-style row, like a tool line in the native flow */
/* 中间过程折叠块：平时只有一行「用时 X ›」，和 Codex 的显示一致。 */
.cxm-work{display:flex;flex-direction:column;gap:6px;min-width:0}
.cxm-work-head{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;
  border:0;background:none;padding:2px 0;cursor:pointer;
  color:var(--dsw-alias-label-tertiary);font-family:inherit;
  font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.cxm-work-head:hover{color:var(--dsw-alias-label-secondary)}
.cxm-work-head:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:2px}
.cxm-work-chevron{display:inline-flex;transition:transform .15s var(--ds-ease-in-out)}
.cxm-work[data-open='true'] .cxm-work-chevron{transform:rotate(90deg)}
.cxm-work-body{display:flex;flex-direction:column;gap:6px;
  padding-left:10px;border-left:1.5px solid var(--dsw-alias-border-l1);min-width:0}
/* 展开后里面的阶段性说明用次要色，和最终答复区分开。 */
.cxm-work-say{color:var(--dsw-alias-label-secondary);
  font-size:var(--dsh-content-font-size,14px);
  line-height:calc(22px + var(--dsh-content-font-delta,0px));
  overflow-wrap:anywhere;min-width:0}
.cxm-action{display:flex;gap:8px;align-items:baseline;min-width:0;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cxm-action b{font-weight:400;color:var(--dsw-alias-label-tertiary);flex:none}
.cxm-action .cxm-cmd{font:var(--dsw-font-markdown-code-block-small);
  color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-markdown-code-block);
  border-radius:var(--dsw-radius-sm);padding:1px 6px}
.cxm-run{flex:none;padding:0 6px;border-radius:999px;font-size:11px;line-height:18px;
  background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary)}

/* question card: native warning surface, not a chat bubble */
.cxm-ask-block{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);
  padding:12px 16px;background:var(--dsw-alias-markdown-code-block);
  min-width:0;max-width:min(calc(min(100%,920px) * .78),92%);align-self:flex-start}
.cxm-ask-title{color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px;
  font-weight:500;margin-bottom:6px}
.cxm-ask-q{font-size:var(--dsh-content-font-size,14px);
  line-height:calc(22px + var(--dsh-content-font-delta,0px));
  color:var(--dsw-alias-label-primary)}
.cxm-ask-opts{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.cxm-opt{text-align:left;border:.5px solid var(--dsw-alias-border-l2);background:none;
  color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);
  padding:6px 12px;font-size:13px;line-height:20px;cursor:pointer;font-family:inherit}
.cxm-opt[data-picked='true']{border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary)}

/* composer: same centred column as the transcript, no full-width bar */
/* box-sizing 必须写：width:100% 再叠左右 padding，不加 border-box 总宽会超出容器，
   右侧被裁掉一截（发送键和卡片右边框都会缺）。 */
.cxm-composer{flex:none;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;
  width:100%;max-width:min(100%,920px);margin:0 auto;padding:8px 24px 20px}
.cxm-opts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.cxm-opts-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:none}
/* 输入卡片照抄 DSH 的 .uV2eYG_card：28px 圆角、input-major 底色、soft elevation，
   内部纵向排「文本区 + 底部按钮行」。之前把按钮和 textarea 并排放在描边盒子里，
   和 DSH 的结构不一样。 */
/* 锁定提示：一条安静的说明，不要做成报错的样子 —— 这不是错误。 */
/* 锁住时的说明：消息可以排队，所以输入框留着，这行只是把情况讲清楚。
   内边距和 .cxm-textarea 一致，说明文字和下面的输入起点对齐。 */
.cxm-locked{display:flex;align-items:flex-start;gap:6px;box-sizing:border-box;
  padding:2px 8px 0 14px;
  font-family:inherit;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-secondary)}
/* 圆点要落在第一行文字的中间，不然会贴着顶边。 */
.cxm-locked-dot{flex:none;width:6px;height:6px;border-radius:999px;margin-top:7px;
  background:var(--dsw-alias-state-warn-primary)}
/* 「只是开着」不是异常，是用户可以去关掉的一个动作，用信息色而不是警告色；
   正在跑才是真的只能等。 */
.cxm-locked[data-reason='idle'] .cxm-locked-dot{background:var(--dsw-alias-state-business-primary)}
.cxm-locked[data-reason='idle']{color:var(--dsw-alias-label-primary)}
.cxm-opt:disabled{opacity:.5;cursor:not-allowed}
/* 用户附的图：和 DSH 的附件缩略图同尺寸（64×64，radius-xl），点开看大图。
   一张 2MB 的截图直接铺满气泡会把整段对话压垮，缩略图更接近桌面端的做法。 */
/* 对话里的图要看得清内容，所以给一个高度上限、宽度自适应，而不是裁成方块：
   object-fit:cover 会把截图上下切掉，用户贴图正是为了看全貌。 */
.cxm-shot{max-width:100%;max-height:220px;width:auto;height:auto;display:block;
  border-radius:var(--dsw-radius-lg);cursor:zoom-in;
  border:.5px solid var(--dsw-alias-border-l2-darkmode-thin);
  background:var(--dsw-alias-interactive-bg-hover)}
.cxm-shots{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;max-width:100%}
.cxm-shot:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:1px}
/* 全屏看图：铺满视口，点任意处或 Esc 关掉。 */
.cxm-md-img{display:block;max-width:100%;height:auto;margin:8px 0;
  border-radius:var(--dsw-radius-lg,16px);cursor:zoom-in;
  border:1px solid var(--dsw-alias-border-l2-darkmode-thin)}
.cxm-md-img-missing{color:var(--dsw-alias-label-tertiary);font-size:13px}
.cxm-zoom{position:fixed;inset:0;z-index:2147483000;display:flex;
  align-items:center;justify-content:center;padding:32px;cursor:zoom-out;
  background:rgba(0,0,0,.72);backdrop-filter:blur(2px)}
.cxm-zoom-img{max-width:100%;max-height:100%;object-fit:contain;display:block;
  border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-soft)}
.cxm-zoom:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:-4px}
.cxm-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;
  width:100%;max-width:var(--dsh-composer-card-max-width,920px);
  border:0;border-radius:var(--dsw-radius-panel,28px);padding:8px 8px 8px;
  background:var(--dsw-specific-input-major);
  box-shadow:var(--dsw-elevation-soft);
  transition:box-shadow .1s}
.cxm-card:focus-within{box-shadow:var(--dsw-elevation-soft), 0 0 0 1px var(--dsw-alias-border-l3)}
.cxm-textarea{box-sizing:border-box;min-height:36px;max-height:336px;resize:none;
  border:0;background:none;padding:4px 8px 0 14px;
  color:var(--dsw-alias-label-primary);
  caret-color:var(--dsw-alias-state-business-primary);
  font-family:inherit;font-size:var(--dsh-content-font-size,14px);
  line-height:calc(24px + var(--dsh-content-font-delta,0px));outline:none}
/* 底部按钮行：DSH 的 .uV2eYG_dock，按钮靠右。 */
/* DSH 的 .uV2eYG_dock 只有 padding-top:4px，左右靠 trailing 的 margin-left:auto
   把按钮推到右边，卡片本身不给 dock 加内边距。这里照抄，不要自己补 padding。 */
.cxm-dock{display:flex;align-items:center;gap:12px;max-width:100%;
  padding-top:4px;justify-content:flex-end}
.cxm-dock-spacer{flex:1}
.cxm-textarea::placeholder{color:var(--dsw-alias-markdown-placeholder)}
.cxm-btn{border:.5px solid var(--dsw-alias-border-l2);background:transparent;
  color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);
  padding:5px 12px;font-size:13px;line-height:20px;cursor:pointer;font-family:inherit;flex:none}
.cxm-btn[data-primary='true']{background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.cxm-btn:disabled{opacity:.4;cursor:default}
/* 图标按钮：照 DSH 的 iconButton。默认 28px（列表头那种），data-size=sm 是 24px
   （列表标题栏那种）。都是无边框、透明底、hover 才出浅底。 */
.cxm-icon-btn{display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;flex:none;
  border:0;background:none;border-radius:var(--dsw-radius-sm);
  color:var(--dsw-alias-label-secondary);cursor:pointer;
  transition:background-color .1s,color .1s}
.cxm-icon-btn[data-size='sm']{width:24px;height:24px;
  border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-tertiary)}
.cxm-icon-btn:disabled{opacity:.4;cursor:default}
.cxm-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:-2px}
@media (hover:hover){
  .cxm-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
  .cxm-icon-btn[data-size='sm']:hover:not(:disabled){
    background:none;color:var(--dsw-alias-label-primary)}
}
/* 发送键：照抄 DSH 的 InputBar 主按钮（.uV2eYG_primary），不是带文字的胶囊。
   它是一个 34x34 的正圆图标按钮，DeepSeek 蓝底、白色上箭头，靠 translateY(-2px)
   和输入区基线对齐。禁用只降透明度，形状不变，避免点击时按钮跳动。 */
.cxm-send{flex:none;display:grid;place-items:center;
  width:34px;height:34px;padding:0;border:0;border-radius:999px;
  corner-shape:round;transform:translateY(-2px);
  background:var(--dsw-alias-button-info-fill);color:#fff;
  cursor:pointer;transition:background-color .1s}
@media (hover:hover){.cxm-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}}
.cxm-send:disabled{opacity:.4;cursor:default}
.cxm-send:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:2px}
.cxm-send svg{display:block}
@keyframes cxm-send-spin{to{transform:rotate(360deg)}}
.cxm-send-spin{animation:.8s linear infinite cxm-send-spin}
@media (prefers-reduced-motion:reduce){.cxm-send-spin{animation-duration:2.4s}}
/* 吸在滚动区顶部：滚动时它留在原地，不会看起来像一条消息内容。 */
.cxm-more{position:sticky;top:0;z-index:1;display:flex;justify-content:center;
  padding:6px 0 10px;flex:none;
  background:linear-gradient(var(--dsw-alias-bg-base) 70%,transparent)}
.cxm-more-btn{border:0;background:none;padding:4px 8px;cursor:pointer;font-family:inherit;
  font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm);
  color:var(--dsw-alias-label-tertiary)}
.cxm-more-btn:hover{color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover)}
.cxm-more-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:2px}
.cxm-more{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cxm-note{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.cxm-ok{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;
  display:flex;gap:6px;align-items:center}
.cxm-ok::before{content:'';width:5px;height:5px;border-radius:50%;flex:none;
  background:var(--dsw-alias-state-success-primary)}
.cxm-bad{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;
  overflow-wrap:anywhere}
/* 投递失败的提示要贴在输入框上方，和它说明的那次发送挨在一起。 */
.cxm-delivery-failed{padding:6px 12px 0;flex:none}

/* 窄屏适配照抄 DSH 左侧栏（dsh-client-ui-layout）的做法，不自己定断点：
   - 视口 < 1024 自动收起侧栏（SIDEBAR_AUTO_COLLAPSE = 1024）
   - 视口 < 768 改成抽屉覆盖（drawer = viewport < 768）
   - 抽屉用 translate(-100%) 滑出，不用 display:none，才能有过渡
   - 宽度 min(280, viewport - 48)，和 DSH 的 sidebarWidth 一致
   - 遮罩用 --dsw-alias-bg-mask-1 + --dsw-mask-blur，不用自造的 rgba
   抽屉态由 JS 打上 data-drawer，跟 DSH 用 data-sidebar-drawer 一样。 */

/* 抽屉态：列表浮在对话之上，收起时整块平移出屏外。 */
.cxm-page[data-drawer='true']{position:relative}
.cxm-page[data-drawer='true'] .cxm-list-pane{position:absolute;inset:0 auto 0 0;z-index:71;
  width:min(280px, calc(100% - 48px));box-sizing:border-box;
  /* DSH 在抽屉态把侧栏底色做成半透明玻璃，但那是「容器」层：它底下还有一层
     不透明的 sidebar-fill 托着，文字不会透出后面的对话。这里列表本身就是容器，
     所以用不透明底色，只把阴影和圆角交给 DSH 的观感。 */
  background:var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base));
  border-right:none;
  box-shadow:0 0 0 .5px var(--dsw-alias-border-l3), 0 8px 32px rgba(0,0,0,.16);
  transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out),
    visibility 0s linear var(--ds-transition-duration-slow);
  transform:translate(0);visibility:visible}
.cxm-page[data-drawer='true'] .cxm-list-pane[data-open='false']{
  transform:translate(-100%);visibility:hidden}
/* 列表已经滑出屏幕，display:none 会让过渡失效，所以抽屉态下不再隐藏它。 */
.cxm-page[data-drawer='true'] .cxm-list-pane[data-open='false']{display:flex}

/* 遮罩：盖住对话，点它关闭列表。 */
.cxm-drawer-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:70;
  border:0;padding:0;background:var(--dsw-alias-bg-mask-1);
  -webkit-backdrop-filter:var(--dsw-mask-blur);backdrop-filter:var(--dsw-mask-blur);
  opacity:0;pointer-events:none;
  transition:opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out)}
.cxm-page[data-drawer='true'] .cxm-list-pane[data-open='true'] ~ .cxm-drawer-mask{opacity:1;pointer-events:auto}
/* 遮罩在 DOM 里必须紧跟列表，用兄弟选择器判断开合，省一份状态。 */

/* 触屏上 DSH 只做一件事：把输入框字号提到 16px，避免 iOS 聚焦时页面被放大。
   行高它没有改，所以这里也不改。 */
@media (pointer:coarse) {
  .cxm-textarea{font-size:16px}
}

@media (max-width: 767px) {
  .cxm-chat-pane{overflow-x:hidden}
  .cxm-transcript{padding-inline:14px}
  .cxm-composer{padding-inline:14px}
  .cxm-chat-head{padding-inline:14px}
  .cxm-chat-top{padding-inline:14px}
  /* 长代码行和表格在窄屏必须自己滚动，不能把整页撑宽。 */
  .cxm-md-pre{max-width:100%}
}

/* shared states */
.cxm-blank{flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:13px;
  text-align:center;line-height:1.7;padding:24px}
.cxm-skel{height:44px;border-radius:var(--dsw-radius-md);margin:6px 2px;
  background:var(--dsw-alias-bg-skeleton)}
.cxm-badge{position:absolute;top:-2px;right:-3px;width:8px;height:8px;border-radius:50%;
  background:var(--dsw-alias-state-warn-primary);
  box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base)}

.cxm-row:focus-visible,.cxm-btn:focus-visible,.cxm-opt:focus-visible{
  outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.cxm-textarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:1px}
@media (hover: hover){
  .cxm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
  .cxm-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);
    color:var(--dsw-alias-label-primary)}
  .cxm-btn[data-primary='true']:hover:not(:disabled){
    background:var(--dsw-alias-button-primary-hover)}
  .cxm-opt:hover{border-style:solid;border-color:var(--dsw-alias-brand-primary);
    color:var(--dsw-alias-label-primary)}
}
`

    // ── pieces ──────────────────────────────────────────────────────────────
    function CodexGlyph({ size = 16, active = false, waiting = false }) {
      return h(
        'span',
        {
          style: {
            position: 'relative',
            display: 'inline-flex',
            width: size,
            height: size,
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          },
        },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('path', {
            d: 'M3 4.2 6.6 8 3 11.8',
            stroke: 'currentColor',
            'stroke-width': 1.8,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }),
          h('path', {
            d: 'M8.4 11.8h4.2',
            stroke: 'currentColor',
            'stroke-width': 1.8,
            'stroke-linecap': 'round',
          }),
        ),
        waiting ? h('span', { className: 'cxm-badge' }) : null,
      )
    }

    function StateChip({ t, state }) {
      const token = STATE_TOKEN[state] ?? 'idle'
      const tone = token === 'warn' ? 'warn' : token === 'business' ? 'business' : 'plain'
      return h('span', { className: 'cxm-chip', 'data-tone': tone }, t(`state.${state}`))
    }

    /**
     * Group sessions by project the way Codex's own sidebar does, but never lose the
     * urgency order: a project holding a session that waits on the user comes first,
     * then one that is running, and only then the rest. Within a project the most
     * recent activity still leads, so the row you most likely want stays on top.
     */
    const STATE_RANK = { waiting: 0, running: 1, failed: 2, stopped: 3, done: 4 }
    // Sessions shown per project before folding the remainder behind a button.
    const GROUP_PREVIEW = 5

    function groupSessions(sessions) {
      const byProject = new Map()
      // 置顶会话由 pinnedSessions 单独成组，这里必须排除，
      // 否则它会在置顶区和自己的项目里各出现一次。
      for (const session of sessions) {
        if (session.pinned) continue
        const key = session.project || session.cwd || '-'
        if (!byProject.has(key)) byProject.set(key, { project: key, cwd: session.cwd, sessions: [] })
        byProject.get(key).sessions.push(session)
      }
      const groups = [...byProject.values()]
      for (const group of groups) {
        group.sessions.sort(
          (a, b) =>
            (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9) ||
            (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
        )
        const states = group.sessions.map((s) => s.state)
        group.waiting = states.filter((x) => x === 'waiting').length
        group.running = states.filter((x) => x === 'running').length
        group.rank = Math.min(...states.map((x) => STATE_RANK[x] ?? 9))
        group.updatedAt = Math.max(...group.sessions.map((s) => s.updatedAt ?? 0))
        // Codex 自己给项目排了序（projects.position），沿用它能保持两边顺序一致。
        group.position = Math.min(
          ...group.sessions.map((s) => (typeof s.projectPosition === 'number' ? s.projectPosition : 1 << 30)),
        )
      }
      // 需要你注意的项目永远优先；同一优先级内跟 Codex 的项目顺序走。
      groups.sort((a, b) => a.rank - b.rank || a.position - b.position || b.updatedAt - a.updatedAt)
      return groups
    }

    /** 置顶会话单独成一组，放在所有项目之上。组内按 Codex 的置顶顺序。 */
    function pinnedSessions(sessions) {
      return sessions
        .filter((s) => s.pinned)
        .sort((a, b) => (a.pinnedPosition ?? 0) - (b.pinnedPosition ?? 0))
    }

    /** 不分项目，只按最近使用排。置顶的仍然单独成组，所以这里只取其余的。 */
    function recentSessions(sessions) {
      return sessions
        .filter((s) => !s.pinned)
        .sort(
          (a, b) =>
            (b.recencyAt ?? (b.updatedAt ?? 0) * 1000) -
            (a.recencyAt ?? (a.updatedAt ?? 0) * 1000),
        )
    }

    /** 图钉：和 DSH 其他图标一样 16×16 描边。斜着放，像真的按在板上。 */
    function PinGlyph() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M5.6 1.9h4.8l-.9 3.4 2.2 2.2v1.2H4.3V7.5l2.2-2.2-.9-3.4Z',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linejoin': 'round',
        }),
        h('path', {
          d: 'M8 8.7v5',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
        }),
      )
    }

    /** Folder and chevron glyphs, sized to the 16x20 slot DSH uses in its tree. */
    function FolderGlyph({ open = false }) {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: open
            ? 'M2 5.5A1.5 1.5 0 0 1 3.5 4h2.6l1.2 1.4h4.2A1.5 1.5 0 0 1 13 6.9v3.6a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 10.5z'
            : 'M2 5A1.5 1.5 0 0 1 3.5 3.5h2.4l1.3 1.5h4.3A1.5 1.5 0 0 1 13 6.5V11a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 11z',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linejoin': 'round',
        }),
      )
    }

    function ChevronGlyph() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M4.5 2.5 8 6l-3.5 3.5',
          stroke: 'currentColor',
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      )
    }

    /**
     * 刷新图标：一个环形箭头。DSH 的图标都是 16×16、strokeWidth 1 的描边风格，
     * 这里保持一致，不要用实心填充。
     */
    function RefreshGlyph() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // Feather 的 refresh-cw：两段弧加两个箭头，方向感最清楚。
        h('path', {
          d: 'M14 8a6 6 0 0 1-10.2 4.3L2 10.5',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
        h('path', {
          d: 'M2 14v-3.5h3.5',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
        h('path', {
          d: 'M2 8a6 6 0 0 1 10.2-4.3L14 5.5',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
        h('path', {
          d: 'M14 2v3.5h-3.5',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      )
    }

    /** A project heading: folder glyph, name, and how many sessions need attention. */
    function ProjectHeader({ t, group, collapsed, onToggle }) {
      const badge = group.waiting > 0 ? 'warn' : group.running > 0 ? 'business' : null
      return h(
        'button',
        {
          type: 'button',
          className: 'cxm-group-head',
          'data-collapsed': collapsed ? 'true' : 'false',
          'aria-expanded': collapsed ? 'false' : 'true',
          onClick: onToggle,
          title: group.cwd || group.project,
        },
        h(
          'span',
          { className: 'cxm-group-slot' },
          h('span', { className: 'cxm-group-folder' }, h(FolderGlyph, { open: !collapsed })),
          h('span', { className: 'cxm-group-chevron' }, h(ChevronGlyph)),
        ),
        h('span', { className: 'cxm-group-name' }, group.project),
        badge === null
          ? null
          : h(
              'span',
              { className: 'cxm-chip', 'data-tone': badge },
              group.waiting > 0
                ? t('list.groupWaiting', { n: group.waiting })
                : t('list.groupRunning', { n: group.running }),
            ),
        h('span', { className: 'cxm-group-count' }, String(group.sessions.length)),
      )
    }

    /** 置顶会话的组头。和项目头同一套结构，只是图标换成图钉、没有徽标。 */
    function PinnedHeader({ t, count, collapsed, onToggle }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'cxm-group-head',
          'data-collapsed': collapsed ? 'true' : 'false',
          'aria-expanded': collapsed ? 'false' : 'true',
          onClick: onToggle,
        },
        h(
          'span',
          { className: 'cxm-group-slot' },
          h('span', { className: 'cxm-group-folder' }, h(PinGlyph)),
          h('span', { className: 'cxm-group-chevron' }, h(ChevronGlyph)),
        ),
        h('span', { className: 'cxm-group-name' }, t('list.pinned')),
        h('span', { className: 'cxm-group-count' }, String(count)),
      )
    }

    /**
     * A small Markdown renderer for Codex transcripts.
     *
     * Codex replies in Markdown, so showing the raw source leaves backticks and `**`
     * on screen. A plugin cannot pull in the host's renderer, and pulling a Markdown
     * library would mean shipping a parser plus a sanitiser, so this covers the
     * constructs Codex actually emits — measured across a live profile: inline code
     * (24 of 52 messages), bold (13), links (13), tables (5), lists (4), headings (3).
     *
     * It builds React elements rather than HTML strings. Text is only ever handed to
     * React as text, so a message containing `<script>` renders as those characters and
     * there is no sanitising step that can be forgotten. The only attribute taken from
     * the message is a link `href`, and that is scheme-checked first.
     */

    const SAFE_SCHEMES = /^(https?:|mailto:)/i

    /** Inline spans: code, bold, italic, strikethrough, links. */
    function renderInline(text, keyPrefix, h, onZoom = null) {
      const out = []
      let rest = text
      let n = 0
      const push = (node) => out.push(node)
      const key = () => `${keyPrefix}:i${n++}`

      while (rest.length > 0) {
        // Inline code wins over every other marker, so `**` inside backticks stays literal.
        let m = /^(`+)([\s\S]*?)\1/.exec(rest)
        if (m) {
          push(h('code', { key: key(), className: 'cxm-md-code' }, m[2]))
          rest = rest.slice(m[0].length)
          continue
        }
        // Markdown images: ![alt](src). Codex sends screenshots this way, with the path
        // already turned into a data URL by the backend. Must be checked before the
        // link rule, otherwise the leading ! is swallowed and the image never shows.
        m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
        if (m) {
          const src = m[2]
          if (/^(data:image\/|https?:)/i.test(src)) {
            push(
              h('img', {
                key: key(),
                className: 'cxm-md-img',
                src,
                alt: m[1],
                loading: 'lazy',
                onClick: onZoom ? () => onZoom(src) : undefined,
              }),
            )
          } else {
            // 路径读不到（图被删了、或者不在本机），别渲染成碎图标，说明白。
            push(
              h('span', { key: key(), className: 'cxm-md-img-missing' }, m[1] || '图片'),
            )
          }
          rest = rest.slice(m[0].length)
          continue
        }
        // Links: [label](href)
        m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
        if (m) {
          const href = m[2]
          if (SAFE_SCHEMES.test(href)) {
            push(
              h(
                'a',
                { key: key(), className: 'cxm-md-link', href, target: '_blank', rel: 'noreferrer noopener' },
                ...renderInline(m[1], key(), h, onZoom),
              ),
            )
          } else {
            // A javascript:/data: link keeps its label but is not made clickable.
            push(h('span', { key: key() }, ...renderInline(m[1], key(), h, onZoom)))
          }
          rest = rest.slice(m[0].length)
          continue
        }
        m = /^\*\*([\s\S]+?)\*\*/.exec(rest)
        if (m) {
          push(h('strong', { key: key() }, ...renderInline(m[1], key(), h, onZoom)))
          rest = rest.slice(m[0].length)
          continue
        }
        m = /^~~([\s\S]+?)~~/.exec(rest)
        if (m) {
          push(h('del', { key: key() }, ...renderInline(m[1], key(), h, onZoom)))
          rest = rest.slice(m[0].length)
          continue
        }
        // Single-char emphasis, but not the `*` of a `**` run that failed above.
        m = /^\*([^*\n]+)\*/.exec(rest)
        if (m) {
          push(h('em', { key: key() }, ...renderInline(m[1], key(), h, onZoom)))
          rest = rest.slice(m[0].length)
          continue
        }
        // Plain run up to the next marker.
        m = /^[^`[*~\n]+/.exec(rest)
        if (m) {
          push(m[0])
          rest = rest.slice(m[0].length)
          continue
        }
        // A stray marker character: keep it as text and move on.
        push(rest[0])
        rest = rest.slice(1)
      }
      return out
    }

    function splitRow(line) {
      return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
    }

    const isTableDivider = (line) => /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')

    /** Parse a block of Markdown into block-level React nodes. */
    function renderBlocks(source, keyPrefix, h, onZoom = null) {
      const lines = source.replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let i = 0
      let n = 0
      const key = () => `${keyPrefix}:b${n++}`

      while (i < lines.length) {
        const line = lines[i]

        if (/^\s*$/.test(line)) {
          i += 1
          continue
        }

        // Fenced code block. Codex puts these around diffs and shell output, where the
        // whitespace is the meaning, so it is rendered verbatim in a pre.
        const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line)
        if (fence) {
          const marker = fence[1]
          const lang = fence[2]
          const body = []
          i += 1
          while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
            body.push(lines[i])
            i += 1
          }
          i += 1 // closing fence (or end of input)
          blocks.push(
            h(
              'pre',
              { key: key(), className: 'cxm-md-pre', 'data-lang': lang || undefined },
              h('code', null, body.join('\n')),
            ),
          )
          continue
        }

        // ATX heading.
        const head = /^\s*(#{1,6})\s+(.*)$/.exec(line)
        if (head) {
          const level = Math.min(head[1].length + 2, 6) // keep headings modest in a chat pane
          blocks.push(h(`h${level}`, { key: key(), className: 'cxm-md-h' }, ...renderInline(head[2].trim(), key(), h, onZoom)))
          i += 1
          continue
        }

        // Horizontal rule.
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: key(), className: 'cxm-md-hr' }))
          i += 1
          continue
        }

        // Blockquote: gather the run, strip the markers, render as one quoted block.
        if (/^\s*>\s?/.test(line)) {
          const body = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          blocks.push(
            h('blockquote', { key: key(), className: 'cxm-md-quote' }, ...renderBlocks(body.join('\n'), key(), h, onZoom)),
          )
          continue
        }

        // Table: header row, divider row, then body rows.
        if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
          const header = splitRow(line)
          i += 2
          const rows = []
          while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
            rows.push(splitRow(lines[i]))
            i += 1
          }
          blocks.push(
            h(
              'div',
              { key: key(), className: 'cxm-md-table-wrap' },
              h(
                'table',
                { className: 'cxm-md-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    header.map((cell, c) => h('th', { key: c }, ...renderInline(cell, `${key()}:h${c}`, h, onZoom))),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  rows.map((row, r) =>
                    h(
                      'tr',
                      { key: r },
                      header.map((_, c) =>
                        h('td', { key: c }, ...renderInline(row[c] ?? '', `${key()}:r${r}c${c}`, h, onZoom)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
          continue
        }

        // Lists. Nesting is tracked by indent so sub-bullets stay sub-bullets.
        const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
        if (listItem) {
          const ordered = /\d/.test(listItem[2])
          const baseIndent = listItem[1].length
          const items = [] // {indent, content[]}
          while (i < lines.length) {
            const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
            if (m) {
              items.push({ indent: m[1].length, text: m[3] })
              i += 1
              continue
            }
            // A plain indented line continues the previous item.
            if (items.length > 0 && /^\s{2,}\S/.test(lines[i])) {
              items[items.length - 1].text += ' ' + lines[i].trim()
              i += 1
              continue
            }
            break
          }
          // Simpler and adequate: one level of nesting by grouping consecutive items.
          const listNodes = []
          let k = 0
          while (k < items.length) {
            const level = items[k].indent
            const group = []
            while (k < items.length && items[k].indent >= level) {
              group.push(items[k])
              k += 1
            }
            listNodes.push(
              h(
                ordered ? 'ol' : 'ul',
                { key: key(), className: 'cxm-md-list' },
                group.map((it, idx) =>
                  h('li', { key: idx }, ...renderInline(it.text, `${key()}:li${idx}`, h, onZoom)),
                ),
              ),
            )
          }
          blocks.push(...listNodes)
          continue
        }

        // Paragraph: consecutive plain lines, joined with a space (Markdown soft wrap).
        const para = []
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,6})\s+/.test(lines[i]) &&
               !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) &&
               !/^\s*(`{3,}|~{3,})/.test(lines[i])) {
          para.push(lines[i].trim())
          i += 1
        }
        if (para.length > 0) {
          blocks.push(h('p', { key: key(), className: 'cxm-md-p' }, ...renderInline(para.join(' '), key(), h, onZoom)))
        } else {
          i += 1 // guard against a line that matched nothing
        }
      }
      return blocks
    }

    /**
     * Render Markdown source to React nodes.
     * @param text - the message body.
     * @param h - React.createElement.
     * @param keyPrefix - stable prefix for keys.
     */
    function renderMarkdown(text, h, keyPrefix = 'md', onZoom = null) {
      return renderBlocks(text, keyPrefix, h, onZoom)
    }

    /** One row in the left list. Selecting it drives the conversation pane. */
    function SessionRow({ t, session, selected, onSelect }) {
      const waiting = session.state === 'waiting'
      const showAsk = waiting && session.question
      return h(
        'button',
        {
          type: 'button',
          className: 'cxm-row',
          'data-selected': selected ? 'true' : 'false',
          'data-waiting': showAsk ? 'true' : 'false',
          'aria-current': selected ? 'true' : undefined,
          onClick: () => onSelect(session.id),
          title: session.title,
        },
        h(
          'span',
          { className: 'cxm-slot' },
          h('span', {
            className: 'cxm-dot',
            style: {
              background: `var(--dsw-alias-state-${STATE_TOKEN[session.state] ?? 'idle'}-primary)`,
            },
          }),
        ),
        h('span', { className: 'cxm-row-name' }, session.title),
        showAsk
          ? h('span', { className: 'cxm-row-ask' }, session.question)
          : h('span', { className: 'cxm-row-time' }, clock(session.updatedAt)),
      )
    }

    /** The composer: appends a turn; never answers on the user's behalf. */
    function Composer({ t, threadId, questions, onSent, locked = false, lockedBy = null }) {
      // 锁住的原因不一样，用户该做的事也不一样：正在跑只能等，只是开着可以去关掉。
      const lockedText =
        lockedBy === 'busy' ? t('reply.lockedBusy')
          : lockedBy === 'idle' ? t('reply.lockedIdle')
            : t('reply.lockedUnknown')
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const [picked, setPicked] = useState(null)

      const options = (questions ?? []).flatMap((q) => q.options ?? [])

      // Switching sessions must not carry a half-typed message into the new one.
      useEffect(() => {
        setDraft('')
        setNote(null)
        setPicked(null)
      }, [threadId])

      const submit = async () => {
        const message = draft.trim()
        if (!message || busy) return
        setBusy(true)
        setNote(null)
        try {
          const result = await call('POST', 'codex-monitor/send', { threadId, message })
          // 锁着时后端会入队而不是拒收，要如实告诉用户「还没发出去」。
          setNote({
            ok: true,
            text: result?.native
              ? t('reply.handedOver')
              : result?.uncertain
                ? t('reply.handedOverUncertain')
                : result?.queued
                  ? t('reply.queued')
                  : t('reply.sent'),
          })
          setDraft('')
          setPicked(null)
          onSent?.()
        } catch (error) {
          // Keep the draft: losing the typed message is worse than the failed send.
          setNote({
            ok: false,
            text: error.threadBusy
              ? t('reply.busy')
              : t('reply.failed', { error: error.message }),
          })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'cxm-composer', 'data-locked': locked ? 'true' : 'false' },
        options.length > 0
          ? h(
              'div',
              { className: 'cxm-opts' },
              h('span', { className: 'cxm-opts-label' }, t('reply.options')),
              options.map((option, index) =>
                h(
                  'button',
                  {
                    key: index,
                    type: 'button',
                    className: 'cxm-opt',
                    'data-picked': picked === index ? 'true' : 'false',
                    'aria-pressed': picked === index,
                    disabled: locked,
                    onClick: () => {
                      setDraft(option)
                      setPicked(index)
                    },
                  },
                  option,
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'cxm-card' },
          // 锁着时不再挡住输入：消息会排队，锁一释放自动投出去。
          // 但得先说清楚「现在发不出去」，否则用户会以为已经送到了。
          locked
            ? h(
                'div',
                { className: 'cxm-locked', role: 'status', 'data-reason': lockedBy || 'unknown' },
                h('span', { className: 'cxm-locked-dot', 'aria-hidden': 'true' }),
                lockedText,
              )
            : null,
          h('textarea', {
            className: 'cxm-textarea',
            rows: 1,   // 空时只占一行，和 DSH 的 min-height:36px 对应；不写会默认 2 行
            value: draft,
            placeholder: t('reply.placeholder'),
            'aria-label': t('reply.placeholder'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              // 输入法选词时的 Enter 是确认候选词，不是发送。
              if (event.nativeEvent?.isComposing || event.isComposing) return
              // Enter 发送；Shift/⌘/Ctrl+Enter 换行，和 DSH 的 fixed.newline 一致。
              if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
              event.preventDefault()
              submit()
            },
          }),
          // 按钮单独一行靠右，和 DSH 的 dock 一致；不跟 textarea 抢同一行。
          h(
            'div',
            { className: 'cxm-dock' },
          h(
            'button',
            {
              type: 'button',
              className: 'cxm-send',
              'aria-label': busy ? t('reply.sending') : t('reply.send'),
              title: busy ? t('reply.sending') : t('reply.send'),
              disabled: busy || draft.trim().length === 0,
              onClick: submit,
            },
            // 图标和 DSH 一致：静止时是上箭头，发送中换成转圈。
            busy
              ? h(
                  'svg',
                  {
                    className: 'cxm-send-spin',
                    viewBox: '0 0 16 16',
                    width: 16,
                    height: 16,
                    'aria-hidden': 'true',
                  },
                  h('circle', {
                    cx: 8, cy: 8, r: 6, fill: 'none',
                    stroke: 'currentColor', strokeOpacity: 0.35, strokeWidth: 2,
                  }),
                  h('path', {
                    d: 'M8 2a6 6 0 0 1 6 6',
                    fill: 'none', stroke: 'currentColor',
                    strokeWidth: 2, strokeLinecap: 'round',
                  }),
                )
              : h(
                  'svg',
                  { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
                  h('path', {
                    d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
                    fill: 'currentColor',
                  }),
                ),
          ),
          ),   // .cxm-dock
        ),     // .cxm-card
        note
          ? h('div', { className: note.ok ? 'cxm-ok' : 'cxm-bad' }, note.text)
          : h('div', { className: 'cxm-note' }, t('reply.note')),
      )
    }

    /** 列表开合开关。图标是两栏示意：左栏实心代表「显示列表」。 */
    function ListToggle({ t, listOpen, onToggle }) {
      const label = listOpen ? t('list.hide') : t('list.show')
      return h(
        'button',
        {
          type: 'button',
          className: 'cxm-list-toggle',
          onClick: onToggle,
          title: label,
          'aria-label': label,
          'aria-expanded': listOpen ? 'true' : 'false',
        },
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('rect', {
            x: 1.75,
            y: 2.75,
            width: 12.5,
            height: 10.5,
            rx: 2,
            stroke: 'currentColor',
            'stroke-width': 1.3,
          }),
          h('path', { d: 'M6.25 2.75v10.5', stroke: 'currentColor', 'stroke-width': 1.3 }),
          // 左栏填实表示列表可见；收起时只留下空栏，图标自己说明状态。
          listOpen
            ? h('rect', { x: 3.1, y: 4.1, width: 2.1, height: 7.8, rx: 0.9, fill: 'currentColor' })
            : null,
        ),
      )
    }

    /** One transcript entry: a message bubble, or a collapsed action line. */
    /**
     * 一轮里的中间过程：默认收起，只露一行「用时 X」，点开才看到命令和阶段说明。
     * Codex 就是这么显示的——正文留给最终答复，过程收进可展开的一行。
     */
    function WorkBlock({ t, entry }) {
      const [open, setOpen] = useState(false)
      // 折叠块里的正文同样可能带图，点开也要能放大。
      const [zoom, setZoom] = useState(null)
      const rows = entry.entries ?? []
      const time = elapsed(entry.durationMs)
      const label = time ? t('work.elapsed', { time }) : t('work.steps', { n: rows.length })
      return h(
        'div',
        { className: 'cxm-work', 'data-open': open ? 'true' : 'false' },
        h(
          'button',
          {
            type: 'button',
            className: 'cxm-work-head',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': open ? t('work.collapse') : t('work.expand'),
            onClick: () => setOpen((v) => !v),
          },
          h('span', { className: 'cxm-work-time' }, label),
          h('span', { className: 'cxm-work-chevron' }, ChevronGlyph()),
        ),
        open
          ? h(
              'div',
              { className: 'cxm-work-body' },
              rows.map((row, index) =>
                row.role === 'action'
                  ? h(
                      'div',
                      { key: index, className: 'cxm-action' },
                      h('b', null, row.label),
                      h('span', { className: 'cxm-cmd', title: row.text }, row.text),
                      (row.count ?? 1) > 1
                        ? h('span', { className: 'cxm-run' }, t('chat.actionRun', { n: row.count }))
                        : null,
                    )
                  : h(
                      'div',
                      { key: index, className: 'cxm-work-say' },
                      renderMarkdown(row.text, h, 'agent', setZoom),
                    ),
              ),
            )
          : null,
        zoom
          ? h(
              'div',
              {
                key: 'zoom',
                className: 'cxm-zoom',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('chat.imageAlt', { n: 1 }),
                tabIndex: 0,
                onClick: () => setZoom(null),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') setZoom(null)
                },
              },
              h('img', { className: 'cxm-zoom-img', src: zoom, alt: '' }),
            )
          : null,
      )
    }

    function Entry({ t, entry }) {
      // 点缩略图放大看。放在这里而不是全局，是因为一次只会展开一张。
      const [zoom, setZoom] = useState(null)
      if (entry.role === 'work') return h(WorkBlock, { t, entry })
      if (entry.role === 'action') {
        const run = entry.count ?? 1
        return h(
          'div',
          { className: 'cxm-action' },
          h('b', null, entry.label),
          h('span', { className: 'cxm-cmd', title: entry.text }, entry.text),
          run > 1
            ? h(
                'span',
                { className: 'cxm-run', title: `${entry.lastLabel ?? ''} ${entry.lastText ?? ''}`.trim() },
                t('chat.actionRun', { n: run }),
              )
            : null,
        )
      }
      const mine = entry.role === 'user'
      const body = h(
        'div',
        {
          className: 'cxm-msg',
          'data-role': mine ? 'user' : 'agent',
          'data-final': entry.final ? 'true' : 'false',
        },
        // 图放在气泡外面，和 DSH 一样单独成一行：气泡有内边距，塞进去会贴边。
        (entry.images ?? []).length > 0
          ? h(
              'div',
              { className: 'cxm-shots' },
              (entry.images ?? []).map((src, index) =>
            h('img', {
              key: index,
              className: 'cxm-shot',
              src,
              alt: t('chat.imageAlt', { n: index + 1 }),
              loading: 'lazy',
              tabIndex: 0,
              role: 'button',
              onClick: () => setZoom(src),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setZoom(src)
                }
              },
            }),
              ),
            )
          : null,
        entry.text || !mine
          ? h(
              'div',
              { className: 'cxm-bubble' },
              // Codex replies in Markdown; the user's own text stays literal, since it is
              // whatever they typed and reinterpreting it as markup would be surprising.
              entry.text ? (mine ? entry.text : renderMarkdown(entry.text, h, 'agent', setZoom)) : null,
            )
          : null,
        entry.questions && entry.questions.length > 0
          ? h(
              'div',
              { className: 'cxm-ask-block' },
              h('div', { className: 'cxm-ask-title' }, t('chat.askingYou')),
              entry.questions.map((q, index) =>
                h('div', { key: index, className: 'cxm-ask-q' }, q.title ?? q.question ?? ''),
              ),
            )
          : null,
        mine ? h('div', { className: 'cxm-stamp' }, clock(entry.at)) : null,
      )
      if (!zoom) return body
      return [
        body,
        h(
          'div',
          {
            key: 'zoom',
            className: 'cxm-zoom',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('chat.imageAlt', { n: 1 }),
            tabIndex: 0,
            onClick: () => setZoom(null),
            onKeyDown: (event) => {
              if (event.key === 'Escape') setZoom(null)
            },
          },
          h('img', { className: 'cxm-zoom-img', src: zoom, alt: '' }),
        ),
      ]
    }

    /** The right pane: header, scrolling transcript, composer. */
    function Conversation({ t, listOpen, onToggleList, session, detail, error, onRetry, onSent }) {
      const scroller = useRef(null)
      const stick = useRef(true)
      // 向上滚加载出来的更早条目。轮询刷新只会换掉 detail 里的最近一页，
      // 这些更早的必须留着，否则每 5 秒就把用户翻上去的内容冲掉。
      const [older, setOlder] = useState([])
      const [before, setBefore] = useState(null)
      const [hasMore, setHasMore] = useState(false)
      const [loadingMore, setLoadingMore] = useState(false)
      const olderKey = useRef(null)

      const fresh = detail?.transcript ?? []
      const entries = older.length ? [...older, ...fresh] : fresh
      // 后台投递是异步的，失败时 HTTP 早就返回成功了。不在这里说一声，
      // 用户只会看到任务「没动静」，然后以为是自己没发出去。
      const delivery = detail?.lastDelivery ?? null
      const deliveryFailed = delivery && delivery.delivered === false ? delivery : null
      const count = entries.length
      const truncated = detail?.transcriptTruncated === true

      // 换会话就把翻上去的内容清掉，否则会串到另一个会话里。
      // stick 也要复位：上一个会话可能被你滚上去过，那不该影响新会话的初始位置。
      useEffect(() => {
        setOlder([])
        setBefore(null)
        setHasMore(false)
        olderKey.current = null
        stick.current = true
      }, [session.id])

      // 详情每次刷新都会带来新的 before/hasMore，用它同步游标。
      useEffect(() => {
        if (olderKey.current === session.id) return
        if (detail?.transcriptBefore) {
          setBefore(detail.transcriptBefore)
          setHasMore(detail.transcriptHasMore === true)
          olderKey.current = session.id
        }
      }, [detail, session.id])

      // Follow the tail only while the reader is already at the bottom, so a poll
      // cannot yank the view away from something they scrolled back to read.
      // 用 layout effect：在浏览器绘制之前就把位置定好，否则会先画出一帧顶部
      // 再跳到底部，看起来就是「打开会话时自己滚了一下」。
      useLayoutEffect(() => {
        const node = scroller.current
        if (!node || !stick.current) return
        node.scrollTop = node.scrollHeight
      }, [count, session.id])

      // 向上滚到顶附近时取更早的一页。加载完要把滚动位置补回去，
      // 否则新插入的内容会把视口顶走，用户会觉得页面「跳」了一下。
      const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore || !before) return
        const node = scroller.current
        const prevHeight = node ? node.scrollHeight : 0
        const prevTop = node ? node.scrollTop : 0
        setLoadingMore(true)
        try {
          const payload = await call('POST', 'codex-monitor/more', {
            threadId: session.id,
            limit: TRANSCRIPT_PAGE,
            before,
          })
          const page = payload.data ?? {}
          const rows = page.entries ?? []
          if (rows.length) setOlder((prev) => [...rows, ...prev])
          setBefore(page.before ?? null)
          setHasMore(page.hasMore === true && rows.length > 0)
          stick.current = false
          // 等 DOM 长出新的高度再补滚动位置。
          // 等 DOM 长出新的高度再补滚动位置，否则新内容会把视口顶走。
          requestAnimationFrame(() => {
            const now = scroller.current
            if (now) now.scrollTop = now.scrollHeight - prevHeight + prevTop
          })
        } catch {
          setHasMore(false)
        } finally {
          setLoadingMore(false)
        }
      }, [loadingMore, hasMore, before, session.id])

      const onScroll = () => {
        const node = scroller.current
        if (!node) return
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
        // 顶部留 80px 余量，快滚到头就提前取，别等真的贴顶。
        if (node.scrollTop < 80) loadMore()
      }

      const questions = detail?.questions ?? session.questions ?? []

      return h(
        'div',
        { className: 'cxm-chat-pane' },
        h(
          'div',
          { className: 'cxm-chat-head' },
          h(ListToggle, { t, listOpen, onToggle: onToggleList }),
          h(
            'div',
            { className: 'cxm-chat-titles' },
            h('h2', { className: 'cxm-chat-name', title: session.title }, session.title),
            h(
              'div',
              { className: 'cxm-chat-meta' },
              [session.project, session.model, session.id].filter(Boolean).join(' · '),
            ),
          ),
          h(
            'div',
            { className: 'cxm-chat-side' },
            h(StateChip, { t, state: session.state }),
            h(
              'button',
              {
                type: 'button',
                className: 'cxm-icon-btn',
                'aria-label': t('page.refresh'),
                title: t('page.refresh'),
                onClick: onRetry,
              },
              h(RefreshGlyph),
            ),
          ),
        ),
        h(
          'div',
          { className: 'cxm-transcript', ref: scroller, onScroll },
          hasMore || loadingMore
            ? h(
                'div',
                { className: 'cxm-more', style: { textAlign: 'center', flex: 'none' } },
                loadingMore
                  ? t('chat.loadingMore')
                  : h(
                      'button',
                      { type: 'button', className: 'cxm-more-btn', onClick: loadMore },
                      t('chat.loadMore'),
                    ),
              )
            : null,
          truncated
            ? h(
                'div',
                { className: 'cxm-note', style: { textAlign: 'center', flex: 'none' } },
                t('chat.transcriptTruncated', { n: count }),
              )
            : null,
          error
            ? h(
                'div',
                { className: 'cxm-blank' },
                h('div', null, t('chat.error', { error })),
                h(
                  'button',
                  { type: 'button', className: 'cxm-btn', onClick: onRetry },
                  t('chat.retry'),
                ),
              )
            : detail === null
              ? h('div', { className: 'cxm-blank' }, t('chat.loading'))
              : count === 0
                ? h('div', { className: 'cxm-blank' }, t('chat.empty'))
                : h(
                    'div',
                    { className: 'cxm-flow' },
                    entries.map((entry, index) => h(Entry, { key: index, t, entry })),
                  ),
        ),
        deliveryFailed
          ? h(
              'div',
              { className: 'cxm-bad cxm-delivery-failed', role: 'status' },
              deliveryFailed.error
                ? t('reply.deliveryFailed', { error: deliveryFailed.error })
                : t('reply.deliveryFailedNoReason'),
            )
          : null,
        h(Composer, {
          t,
          threadId: session.id,
          questions,
          onSent,
          locked: detail?.locked === true,
          lockedBy: detail?.lockedBy ?? null,
        }),
      )
    }

    // ── page ────────────────────────────────────────────────────────────────
    // DSH 左侧栏的两个阈值（dsh-client-ui-layout）：
    // 视口 < 1024 自动收起侧栏，视口 < 768 改成抽屉覆盖。
    const SIDEBAR_AUTO_COLLAPSE = 1024
    const DRAWER_MAX = 768

    /** 视口是否窄到该自动收起侧栏。SSR/测试环境没有 matchMedia 时按桌面处理。 */
    function isNarrow() {
      if (typeof window === 'undefined' || !window.matchMedia) return false
      return window.matchMedia(`(max-width: ${SIDEBAR_AUTO_COLLAPSE - 1}px)`).matches
    }

    /** 视口是否窄到该把侧栏改成抽屉覆盖。 */
    function isDrawer() {
      if (typeof window === 'undefined' || !window.matchMedia) return false
      return window.matchMedia(`(max-width: ${DRAWER_MAX - 1}px)`).matches
    }

    function MonitorPage() {
      const t = React.useContext(TranslationContext)
      const snapshot = useSnapshot()
      // 上次看的是哪个会话，先记在心里，等列表回来再决定要不要用它。
      const [selectedId, setSelectedId] = useState(null)
      // Collapsed projects, keyed by project name. Absent means expanded.
      const [collapsed, setCollapsed] = useState({})
      // 分组方式：按项目（Codex 默认）或按最近使用（一条平铺的列表）。
      // 两种视图里置顶会话都单独成组排在最上面。
      const [mode, setMode] = useState('project')
      // Projects whose full session list was expanded past the default cap.
      const [expanded, setExpanded] = useState({})
      // 宽度判定用 matchMedia 而不是读一次 innerWidth，旋转屏幕或改窗口大小时能跟着变。
      const [narrow, setNarrow] = useState(() => isNarrow())
      const [drawer, setDrawer] = useState(() => isDrawer())
      // 列表是否展开。窄到该自动收起时默认收起，先把对话让出来。
      const [listOpen, setListOpen] = useState(() => !isNarrow())

      useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return undefined
        const mqNarrow = window.matchMedia(`(max-width: ${SIDEBAR_AUTO_COLLAPSE - 1}px)`)
        const mqDrawer = window.matchMedia(`(max-width: ${DRAWER_MAX - 1}px)`)
        const sync = () => {
          setNarrow(mqNarrow.matches)
          setDrawer(mqDrawer.matches)
        }
        sync()
        // Safari 老版本只有 addListener，两个都挂上，缺哪个用另一个。
        const on = (mq) => {
          if (mq.addEventListener) {
            mq.addEventListener('change', sync)
            return () => mq.removeEventListener('change', sync)
          }
          mq.addListener(sync)
          return () => mq.removeListener(sync)
        }
        const offNarrow = on(mqNarrow)
        const offDrawer = on(mqDrawer)
        return () => {
          offNarrow()
          offDrawer()
        }
      }, [])
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState(null)

      useEffect(() => monitor.mountPage(), [])

      const data = snapshot.data
      const sessions = data?.sessions ?? []
      const selected = sessions.find((s) => s.id === selectedId) ?? null

      // 打开面板时回到上次看的那个会话；没有记录、或者那个会话已经不在了
      // （归档、被删），才退回到列表第一个。
      useEffect(() => {
        if (selectedId !== null || sessions.length === 0) return
        const remembered = readLastSession()
        const hit = remembered && sessions.some((s) => s.id === remembered)
        setSelectedId(hit ? remembered : sessions[0].id)
      }, [selectedId, sessions])

      // 换会话就记下来，下次打开直接回到这里。
      useEffect(() => {
        if (selectedId !== null) writeLastSession(selectedId)
      }, [selectedId])

      const loadDetail = useCallback(async (id) => {
        if (!id) return
        try {
          // 首屏只取最近几十条。一个活跃会话 200 条能有近 500KB，
          // 而用户打开时几乎总是先看最后几句。更早的等向上滚动再要。
          const payload = await call('POST', 'codex-monitor/status', {
            threadId: id,
            items: 8,
            transcript: TRANSCRIPT_PAGE,
          })
          setDetail(payload.data)
          setDetailError(null)
        } catch (error) {
          setDetailError(error.message)
        }
      }, [])

      const busy =
        (data?.counts?.running ?? 0) > 0 || (data?.counts?.waiting ?? 0) > 0

      // Poll the open conversation on its own cadence, and only while the tab is visible.
      useEffect(() => {
        if (!selectedId) return undefined
        let alive = true
        const tick = () => {
          if (document.hidden || !alive) return
          loadDetail(selectedId)
        }
        tick()
        const timer = setInterval(tick, busy ? 5000 : 30000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [selectedId, busy, loadDetail])

      const refresh = () => {
        refreshNow()
        if (selectedId) loadDetail(selectedId)
      }

      const listBody = () => {
        if (snapshot.phase === 'loading') {
          return [h('div', { className: 'cxm-skel', key: 'a' }), h('div', { className: 'cxm-skel', key: 'b' })]
        }
        if (snapshot.phase === 'error') {
          return h(
            'div',
            { className: 'cxm-blank' },
            h('div', null, snapshot.missingPython ? t('page.pythonMissing') : t('page.errorTitle')),
            !snapshot.missingPython ? h('div', { className: 'cxm-note' }, snapshot.error) : null,
            h(
              'button',
              { type: 'button', className: 'cxm-btn', style: { marginTop: 10 }, onClick: refresh },
              t('page.retry'),
            ),
          )
        }
        if (sessions.length === 0) {
          return h('div', { className: 'cxm-blank' }, t('page.empty'))
        }
        const pick = (id) => {
          setSelectedId(id)
          setDetail(null)
          setDetailError(null)
          // 窄屏上列表是覆盖层，选完就该让开，否则一直挡住对话。
          if (isNarrow()) setListOpen(false)
        }
        const pinned = pinnedSessions(sessions)
        const groups = groupSessions(sessions)
        const row = (session) =>
          h(SessionRow, {
            key: session.id,
            t,
            session,
            selected: session.id === selectedId,
            onSelect: pick,
          })

        // 置顶的单独一组，永远在最上面，不掺进任何项目里。
        const pinnedBlock = pinned.length
          ? [
              h(PinnedHeader, {
                key: 'h:pinned',
                t,
                count: pinned.length,
                collapsed: collapsed.__pinned === true,
                onToggle: () =>
                  setCollapsed((prev) => ({ ...prev, __pinned: !prev.__pinned })),
              }),
              ...(collapsed.__pinned === true ? [] : pinned.map(row)),
            ]
          : []

        // 按项目分组：单个项目时不必显示标题，分组只在真能省事时才出现。
        const projectBlock =
          groups.length === 1
            ? groups[0].sessions.map(row)
            : groups.flatMap((group) => {
                const isCollapsed = collapsed[group.project] === true
                const head = h(ProjectHeader, {
                  key: `h:${group.project}`,
                  t,
                  group,
                  collapsed: isCollapsed,
                  onToggle: () =>
                    setCollapsed((prev) => ({ ...prev, [group.project]: !isCollapsed })),
                })
                if (isCollapsed) return [head]
                // One busy project can hold dozens of sessions; show the most urgent few and
                // let the reader pull the rest open, the way Codex's own sidebar does.
                const open = expanded[group.project] === true
                const shown = open ? group.sessions : group.sessions.slice(0, GROUP_PREVIEW)
                const hidden = group.sessions.length - shown.length
                return [
                  head,
                  ...shown.map(row),
                  hidden > 0
                    ? h(
                        'button',
                        {
                          key: `m:${group.project}`,
                          type: 'button',
                          className: 'cxm-group-more',
                          onClick: () =>
                            setExpanded((prev) => ({ ...prev, [group.project]: true })),
                        },
                        t('list.showMore', { n: hidden }),
                      )
                    : null,
                ]
              })

        // 按最近使用：不分项目，一条平铺的列表，置顶的仍然在上面。
        const recentBlock = recentSessions(sessions).map(row)

        return [
          ...pinnedBlock,
          ...(mode === 'recent' ? recentBlock : projectBlock),
        ]
      }

      return h(
        'div',
        { className: 'cxm-page', 'data-drawer': drawer ? 'true' : 'false' },
        h(
          'div',
          { className: 'cxm-list-pane', 'data-open': listOpen ? 'true' : 'false' },
          h(
            'div',
            { className: 'cxm-list-head' },
            h(
              'h1',
              { className: 'cxm-list-title' },
              h('span', null, t('list.title')),
              h(
                'span',
                { className: 'cxm-seg', role: 'tablist', 'aria-label': t('list.groupBy') },
                ...['project', 'recent'].map((value) =>
                  h(
                    'button',
                    {
                      key: value,
                      type: 'button',
                      role: 'tab',
                      className: 'cxm-seg-btn',
                      'data-active': mode === value ? 'true' : 'false',
                      'aria-selected': mode === value ? 'true' : 'false',
                      onClick: () => setMode(value),
                    },
                    t(value === 'project' ? 'list.byProject' : 'list.byRecent'),
                  ),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cxm-icon-btn',
                  'data-size': 'sm',
                  'aria-label': t('page.refresh'),
                  title: t('page.refresh'),
                  onClick: refresh,
                  disabled: snapshot.phase === 'loading',
                },
                h(RefreshGlyph),
              ),
            ),
            h(
              'div',
              { className: 'cxm-list-counts' },
              data
                ? t('page.counts', {
                    total: data.counts.total,
                    running: data.counts.running,
                    waiting: data.counts.waiting,
                  })
                : t('page.title'),
            ),
          ),
          h('div', { className: 'cxm-list-body' }, listBody()),
        ),
        // 遮罩紧跟列表，靠 CSS 兄弟选择器跟着列表开合，不用第二份状态。
        // 只有抽屉态才需要它；宽屏下它是 pointer-events:none，点不到。
        h('button', {
          type: 'button',
          className: 'cxm-drawer-mask',
          tabIndex: -1,
          'aria-hidden': 'true',
          onClick: () => setListOpen(false),
        }),
        selected
          ? h(Conversation, {
              t,
              listOpen,
              onToggleList: () => setListOpen((v) => !v),
              session: selected,
              detail: detail !== null && detail.id === selected.id ? detail : null,
              error: detailError,
              onRetry: () => loadDetail(selected.id),
              onSent: refresh,
            })
          : h(
              'div',
              { className: 'cxm-chat-pane' },
              h(
                'div',
                { className: 'cxm-chat-top' },
                h(ListToggle, { t, listOpen, onToggle: () => setListOpen((v) => !v) }),
              ),
              h(
                'div',
                { className: 'cxm-blank' },
                h('div', null, t('chat.placeholderPick')),
                h('div', { className: 'cxm-note' }, t('chat.placeholderPickHint')),
              ),
            ),
      )
    }

    // ── translation plumbing ────────────────────────────────────────────────
    // The page and the sidebar glyph are registered into different slots; a context
    // keeps the bound translator available to both without threading it through props.
    const TranslationContext = React.createContext((key) => key)

    function SidebarEntry({ size = 16, active = false }) {
      const snapshot = useSnapshot()
      const waiting = snapshot.data?.counts?.waiting ?? 0
      return h(CodexGlyph, { size, active, waiting: waiting > 0 })
    }

    // ── polling ─────────────────────────────────────────────────────────────
    let abortCurrent = null

    async function refreshNow() {
      abortCurrent?.abort()
      const controller = new AbortController()
      abortCurrent = controller
      try {
        const payload = await call('GET', 'codex-monitor/state?limit=20', undefined, controller.signal)
        monitor.set({ phase: 'ready', data: payload.data, error: null, missingPython: false })
      } catch (error) {
        if (controller.signal.aborted) return
        monitor.set({
          phase: 'error',
          data: null,
          error: error.message,
          missingPython: error.missingPython === true,
        })
      } finally {
        if (abortCurrent === controller) abortCurrent = null
      }
    }

    // ── registration ────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'codex-monitor: dictionaries',
        )
        const t = ctx.locale.bind(NS)

        // The sidebar glyph outlives the page, so its badge needs styles even when
        // the Codex page is unmounted. Inject once into the document head.
        ctx.effect(() => {
          const previous = document.querySelector('style[data-plugin-css="codex-monitor"]')
          if (previous !== null) return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'codex-monitor')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'codex-monitor: styles')

        ctx.effect(
          () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 12,
                locale: NS,
                label: () =>
                  (monitor.get().data?.counts?.waiting ?? 0) > 0
                    ? t('panel.labelWaiting', { n: monitor.get().data.counts.waiting })
                    : t('panel.label'),
              },
              SidebarEntry,
            ),
          'codex-monitor: sidebar entry',
        )

        ctx.effect(
          () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID, locale: NS },
              () =>
                h(TranslationContext.Provider, { value: t }, h(MonitorPage, null)),
            ),
          'codex-monitor: page',
        )

        ctx.effect(() => {
          let alive = true
          const tick = () => {
            if (!alive || !monitor.busy() || document.hidden) return
            refreshNow()
          }
          tick()
          const timer = setInterval(tick, 5000)
          return () => {
            alive = false
            clearInterval(timer)
            abortCurrent?.abort()
          }
        }, 'codex-monitor: poller')
      },
    }
  },
})
