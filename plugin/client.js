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
    const { useEffect, useRef, useState, useSyncExternalStore, useCallback } = React

    const NS = 'codex-monitor'
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
      'list.empty': '还没有会话',
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
      'chat.actionRun': '共 {n} 步',
      'reply.placeholder': '给这个 Codex 会话发消息…',
      'reply.send': '发送',
      'reply.sending': '发送中…',
      'reply.cancel': '取消',
      'reply.sent': '已提交给 Codex，稍后会处理。',
      'reply.failed': '投递失败：{error}',
      'reply.note': '追加为新的一轮，不打断正在跑的任务。⌘↵ 发送。',
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
      'list.empty': 'No sessions yet',
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
      'chat.actionRun': '{n} steps',
      'reply.placeholder': 'Message this Codex session…',
      'reply.send': 'Send',
      'reply.sending': 'Sending…',
      'reply.cancel': 'Cancel',
      'reply.sent': 'Submitted to Codex; it will pick this up shortly.',
      'reply.failed': 'Could not deliver: {error}',
      'reply.note': 'Appends a new turn; does not interrupt work already running. ⌘↵ sends.',
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

/* left: session list */
.cxm-list-pane{flex:none;width:clamp(212px,24%,300px);display:flex;flex-direction:column;
  min-height:0;border-right:1px solid var(--dsw-alias-border-l3)}
.cxm-list-head{padding:calc(20px + var(--dsh-frame-top-clearance,0px)) 14px 10px}
.cxm-list-title{margin:0;font-size:14px;font-weight:500;display:flex;align-items:center;
  gap:8px;justify-content:space-between}
.cxm-list-counts{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:5px;
  line-height:1.5}
.cxm-list-body{flex:1;min-height:0;overflow:auto;padding:0 8px 16px;display:flex;
  flex-direction:column;gap:2px}
.cxm-row{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;
  border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;
  padding:9px 10px;cursor:pointer;font-family:inherit;position:relative}
.cxm-row[data-selected='true']{background:var(--dsw-alias-bg-layer-2)}
.cxm-row-top{display:flex;align-items:center;gap:6px;min-width:0}
.cxm-dot{width:6px;height:6px;border-radius:50%;flex:none}
.cxm-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:13px;line-height:1.45}
.cxm-row-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);
  font-size:11px;flex:none}
.cxm-row-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;padding-left:12px}
.cxm-row-ask{color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:1.45;
  padding-left:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
  overflow:hidden}
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
  display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.cxm-chat-titles{min-width:0;flex:1}
.cxm-chat-name{margin:0;font-size:15px;font-weight:500;line-height:22px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxm-chat-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;
  margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxm-chat-side{display:flex;align-items:center;gap:8px;flex:none}

/* Transcript follows the native conversation rhythm: one centred column, a 16px
   flow gap, and no bubble around assistant text. */
.cxm-transcript{flex:1;min-height:0;overflow:auto;padding:16px 24px 8px;display:flex;
  flex-direction:column;scroll-behavior:smooth}
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

.cxm-stamp{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;
  font-variant-numeric:tabular-nums}

/* action: a quiet disclosure-style row, like a tool line in the native flow */
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
.cxm-composer{flex:none;display:flex;flex-direction:column;gap:6px;
  width:100%;max-width:min(100%,920px);margin:0 auto;padding:8px 24px 20px}
.cxm-opts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.cxm-opts-label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:none}
.cxm-input-row{display:flex;gap:8px;align-items:flex-end;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);
  background:var(--dsw-specific-input-major);padding:8px 8px 8px 14px;
  transition:border-color .1s}
.cxm-input-row:focus-within{border-color:var(--dsw-alias-border-l3)}
.cxm-textarea{flex:1;box-sizing:border-box;min-height:24px;max-height:336px;resize:none;
  border:0;background:none;padding:5px 0;color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:var(--dsh-content-font-size,14px);
  line-height:calc(22px + var(--dsh-content-font-delta,0px));outline:none}
.cxm-textarea::placeholder{color:var(--dsw-alias-markdown-placeholder)}
.cxm-btn{border:.5px solid var(--dsw-alias-border-l2);background:transparent;
  color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);
  padding:5px 12px;font-size:13px;line-height:20px;cursor:pointer;font-family:inherit;flex:none}
.cxm-btn[data-primary='true']{background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.cxm-btn:disabled{opacity:.4;cursor:default}
.cxm-note{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.cxm-ok{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;
  display:flex;gap:6px;align-items:center}
.cxm-ok::before{content:'';width:5px;height:5px;border-radius:50%;flex:none;
  background:var(--dsw-alias-state-success-primary)}
.cxm-bad{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;
  overflow-wrap:anywhere}

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
@media (pointer: coarse){.cxm-textarea{font-size:16px}}
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

    /** One row in the left list. Selecting it drives the conversation pane. */
    function SessionRow({ t, session, selected, onSelect }) {
      const waiting = session.state === 'waiting'
      return h(
        'button',
        {
          type: 'button',
          className: 'cxm-row',
          'data-selected': selected ? 'true' : 'false',
          'aria-current': selected ? 'true' : undefined,
          onClick: () => onSelect(session.id),
        },
        h(
          'span',
          { className: 'cxm-row-top' },
          h('span', {
            className: 'cxm-dot',
            style: {
              background: `var(--dsw-alias-state-${STATE_TOKEN[session.state] ?? 'idle'}-primary)`,
            },
          }),
          h('span', { className: 'cxm-row-name' }, session.title),
          h('span', { className: 'cxm-row-time' }, clock(session.updatedAt)),
        ),
        h(
          'span',
          { className: 'cxm-row-meta' },
          session.state === 'running'
            ? `${session.project} · ${t('state.running')}`
            : session.project,
        ),
        waiting && session.question
          ? h('span', { className: 'cxm-row-ask' }, session.question)
          : null,
      )
    }

    /** The composer: appends a turn; never answers on the user's behalf. */
    function Composer({ t, threadId, questions, onSent }) {
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
          await call('POST', 'codex-monitor/send', { threadId, message })
          setNote({ ok: true, text: t('reply.sent') })
          setDraft('')
          setPicked(null)
          onSent?.()
        } catch (error) {
          // Keep the draft: losing the typed message is worse than the failed send.
          setNote({ ok: false, text: t('reply.failed', { error: error.message }) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'cxm-composer' },
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
          { className: 'cxm-input-row' },
          h('textarea', {
            className: 'cxm-textarea',
            value: draft,
            placeholder: t('reply.placeholder'),
            'aria-label': t('reply.placeholder'),
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'cxm-btn',
              'data-primary': 'true',
              disabled: busy || draft.trim().length === 0,
              onClick: submit,
            },
            busy ? t('reply.sending') : t('reply.send'),
          ),
        ),
        note
          ? h('div', { className: note.ok ? 'cxm-ok' : 'cxm-bad' }, note.text)
          : h('div', { className: 'cxm-note' }, t('reply.note')),
      )
    }

    /** One transcript entry: a message bubble, or a collapsed action line. */
    function Entry({ t, entry }) {
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
      return h(
        'div',
        {
          className: 'cxm-msg',
          'data-role': mine ? 'user' : 'agent',
          'data-final': entry.final ? 'true' : 'false',
        },
        h('div', { className: 'cxm-bubble' }, entry.text),
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
    }

    /** The right pane: header, scrolling transcript, composer. */
    function Conversation({ t, session, detail, error, onRetry, onSent }) {
      const scroller = useRef(null)
      const stick = useRef(true)
      const entries = detail?.transcript ?? []
      const count = entries.length
      const truncated = detail?.transcriptTruncated === true

      // Follow the tail only while the reader is already at the bottom, so a poll
      // cannot yank the view away from something they scrolled back to read.
      useEffect(() => {
        const node = scroller.current
        if (!node || !stick.current) return
        node.scrollTop = node.scrollHeight
      }, [count, session.id])

      const onScroll = () => {
        const node = scroller.current
        if (!node) return
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
      }

      const questions = detail?.questions ?? session.questions ?? []

      return h(
        'div',
        { className: 'cxm-chat-pane' },
        h(
          'div',
          { className: 'cxm-chat-head' },
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
              { type: 'button', className: 'cxm-btn', onClick: onRetry },
              t('page.refresh'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'cxm-transcript', ref: scroller, onScroll },
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
        h(Composer, { t, threadId: session.id, questions, onSent }),
      )
    }

    // ── page ────────────────────────────────────────────────────────────────
    function MonitorPage() {
      const t = React.useContext(TranslationContext)
      const snapshot = useSnapshot()
      const [selectedId, setSelectedId] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState(null)

      useEffect(() => monitor.mountPage(), [])

      const data = snapshot.data
      const sessions = data?.sessions ?? []
      const selected = sessions.find((s) => s.id === selectedId) ?? null

      // Default to the session that most needs attention, so opening the panel lands
      // on something useful instead of an empty pane.
      useEffect(() => {
        if (selectedId !== null || sessions.length === 0) return
        setSelectedId(sessions[0].id)
      }, [selectedId, sessions])

      const loadDetail = useCallback(async (id) => {
        if (!id) return
        try {
          const payload = await call('POST', 'codex-monitor/status', { threadId: id, items: 8 })
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
        return sessions.map((session) =>
          h(SessionRow, {
            key: session.id,
            t,
            session,
            selected: session.id === selectedId,
            onSelect: (id) => {
              setSelectedId(id)
              setDetail(null)
              setDetailError(null)
            },
          }),
        )
      }

      return h(
        'div',
        { className: 'cxm-page' },
        h(
          'div',
          { className: 'cxm-list-pane' },
          h(
            'div',
            { className: 'cxm-list-head' },
            h(
              'h1',
              { className: 'cxm-list-title' },
              h('span', null, t('list.title')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cxm-btn',
                  onClick: refresh,
                  disabled: snapshot.phase === 'loading',
                },
                t('page.refresh'),
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
        selected
          ? h(Conversation, {
              t,
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
