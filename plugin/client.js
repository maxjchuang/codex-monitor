/**
 * Client half of codex-monitor.
 *
 * One sidebar entry (`sidebar.panellist`) plus one full page (`main`). Both read a
 * single shared snapshot so the sidebar badge and the page can never disagree.
 */
window.__ModuleLoader__.load({
  id: '@local/codex-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useSyncExternalStore, useCallback } = React

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
      'state.running': '正在跑',
      'state.waiting': '等你回答',
      'state.done': '已完成',
      'state.failed': '失败',
      'state.stopped': '已停下',
      'state.idle': '空闲',
      'row.details': '详情',
      'row.hide': '收起',
      'row.reply': '回复',
      'row.lastAction': '最新动作',
      'row.noActions': '暂无动作记录',
      'row.model': '模型',
      'row.directory': '目录',
      'row.id': '会话',
      'row.started': '开始 {time}',
      'row.duration': '用时 {seconds}s',
      'row.timing': '计时中',
      'reply.placeholder': '要发进这个 Codex 会话的消息…',
      'reply.send': '发送',
      'reply.sending': '发送中…',
      'reply.cancel': '取消',
      'reply.sent': '已提交给 Codex，稍后会处理。',
      'reply.failed': '投递失败：{error}',
      'reply.note': '这会作为新的一轮追加进去，不会打断正在跑的任务。',
      'reply.options': 'Codex 给出的选项（点击填入，需你自己发送）：',
      'age.justNow': '刚刚',
      'age.seconds': '{n}s 前',
      'age.minutes': '{n} 分钟前',
      'age.hours': '{n} 小时前',
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
      'state.running': 'Running',
      'state.waiting': 'Waiting for you',
      'state.done': 'Done',
      'state.failed': 'Failed',
      'state.stopped': 'Stopped',
      'state.idle': 'Idle',
      'row.details': 'Details',
      'row.hide': 'Hide',
      'row.reply': 'Reply',
      'row.lastAction': 'Latest',
      'row.noActions': 'No recorded actions yet',
      'row.model': 'Model',
      'row.directory': 'Directory',
      'row.id': 'Session',
      'row.started': 'Started {time}',
      'row.duration': 'Took {seconds}s',
      'row.timing': 'Timing',
      'reply.placeholder': 'Message to send into this Codex session…',
      'reply.send': 'Send',
      'reply.sending': 'Sending…',
      'reply.cancel': 'Cancel',
      'reply.sent': 'Submitted to Codex; it will pick this up shortly.',
      'reply.failed': 'Could not deliver: {error}',
      'reply.note': 'Codex appends this as a new turn; it does not interrupt work already running.',
      'reply.options': 'Options Codex offered (click to fill in, you still send):',
      'age.justNow': 'just now',
      'age.seconds': '{n}s ago',
      'age.minutes': '{n}m ago',
      'age.hours': '{n}h ago',
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
    const ageText = (t, seconds) => {
      if (seconds === null || seconds === undefined) return ''
      if (seconds < 10) return t('age.justNow')
      if (seconds < 60) return t('age.seconds', { n: seconds })
      if (seconds < 3600) return t('age.minutes', { n: Math.floor(seconds / 60) })
      return t('age.hours', { n: Math.floor(seconds / 3600) })
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
.cxm-page{height:100%;overflow:auto;box-sizing:border-box;
  padding:0 clamp(24px,4vw,48px) 48px;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-size:var(--dsh-content-font-size,14px)}
.cxm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));margin-bottom:6px}
.cxm-title{font-size:20px;font-weight:500;margin:0;line-height:1.4}
.cxm-sub{color:var(--dsw-alias-label-tertiary);font-size:13px;margin-top:4px}
.cxm-refresh{border:1px solid var(--dsw-alias-border-l4);background:transparent;
  color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);
  padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.cxm-refresh:disabled{opacity:.55;cursor:default}
.cxm-list{display:flex;flex-direction:column;gap:8px;margin-top:16px}
.cxm-row{border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.cxm-row[data-state='waiting']{border-color:var(--dsw-alias-state-warn-primary)}
.cxm-rowhead{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;
  background:none;border:0;width:100%;text-align:left;font-family:inherit;color:inherit}
.cxm-dot{width:7px;height:7px;border-radius:50%;flex:none}
.cxm-chip{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap;flex:none;
  line-height:1.6;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.cxm-chip[data-tone='warn']{background:var(--dsw-alias-state-warn-tertiary);
  color:var(--dsw-alias-state-warn-label)}
.cxm-chip[data-tone='business']{background:var(--dsw-alias-state-business-tertiary);
  color:var(--dsw-alias-state-business-primary)}
.cxm-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);
  font-size:12px;flex:none}
.cxm-proj{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;max-width:200px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cxm-name{flex:1;min-width:0;color:var(--dsw-alias-label-primary);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  line-height:1.5;overflow-wrap:anywhere}
.cxm-q{padding:0 14px 12px 31px;color:var(--dsw-alias-label-primary);font-size:13px;
  border-left:3px solid var(--dsw-alias-state-warn-primary);margin-left:14px;
  padding-left:10px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;
  overflow:hidden;line-height:1.55}
.cxm-body{border-top:1px solid var(--dsw-alias-border-l4);padding:12px 14px;display:flex;
  flex-direction:column;gap:10px;font-size:12px}
.cxm-meta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;
  color:var(--dsw-alias-label-tertiary)}
.cxm-meta b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.cxm-meta span{overflow-wrap:anywhere}
.cxm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cxm-btn{border:1px solid var(--dsw-alias-border-l4);background:transparent;
  color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);
  padding:4px 11px;font-size:12px;cursor:pointer;font-family:inherit}
.cxm-btn[data-primary='true']{background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.cxm-btn:disabled{opacity:.5;cursor:default}
.cxm-items{display:flex;flex-direction:column;gap:3px;max-height:230px;overflow:auto}
.cxm-item{display:flex;gap:9px;color:var(--dsw-alias-label-secondary)}
.cxm-item i{font-style:normal;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;flex:none}
.cxm-item span{overflow-wrap:anywhere}
.cxm-reply{display:flex;flex-direction:column;gap:7px;margin-top:2px}
.cxm-textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;
  border:1px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);
  padding:8px 10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:13px;line-height:1.5}
.cxm-note{color:var(--dsw-alias-label-tertiary);font-size:11px}
.cxm-ok{color:var(--dsw-alias-label-primary);font-size:12px;display:flex;gap:6px;
  align-items:center}
.cxm-ok::before{content:'';width:6px;height:6px;border-radius:50%;flex:none;
  background:var(--dsw-alias-state-success-primary)}
.cxm-bad{color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere}
.cxm-opts{display:flex;flex-direction:column;gap:5px}
.cxm-opt{text-align:left;border:1px dashed var(--dsw-alias-border-l3);background:none;
  color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);
  padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit}
.cxm-opt[data-picked='true']{border-style:solid;border-color:var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-primary)}
.cxm-blank{margin-top:32px;color:var(--dsw-alias-label-tertiary);font-size:13px;
  text-align:center;line-height:1.7}
.cxm-skel{height:56px;border-radius:var(--dsw-radius-md);margin-top:8px;
  background:var(--dsw-alias-bg-skeleton)}
.cxm-badge{position:absolute;top:-2px;right:-3px;width:8px;height:8px;border-radius:50%;
  background:var(--dsw-alias-state-warn-primary);
  box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base)}
.cxm-btn:focus-visible,.cxm-opt:focus-visible,.cxm-refresh:focus-visible,
.cxm-rowhead:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:-2px}
.cxm-textarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset:1px}
@media (hover: hover){
  .cxm-refresh:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);
    color:var(--dsw-alias-label-primary)}
  .cxm-rowhead:hover{background:var(--dsw-alias-interactive-bg-hover)}
  .cxm-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);
    color:var(--dsw-alias-label-primary)}
  .cxm-btn[data-primary='true']:hover:not(:disabled){
    background:var(--dsw-alias-button-primary-hover)}
  .cxm-opt:hover{border-style:solid;border-color:var(--dsw-alias-brand-primary);
    color:var(--dsw-alias-label-primary)}
}
@media (pointer: coarse){.cxm-textarea{font-size:16px}}
`

    // ── glyphs ──────────────────────────────────────────────────────────────
    // A terminal prompt with a status dot: the row owns the accessible label.
    function CodexGlyph({ size = 16, active = false, waiting = false }) {
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', lineHeight: 0 } },
        h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: size,
            height: size,
            'aria-hidden': 'true',
            style: { display: 'block' },
          },
          h('path', {
            d: 'M2.4 3.2 6.6 8l-4.2 4.8',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 1.9 : 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            opacity: active ? 1 : 0.85,
          }),
          h('path', {
            d: 'M8.6 12.4h5',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 1.9 : 1.6,
            strokeLinecap: 'round',
            opacity: active ? 1 : 0.85,
          }),
        ),
        waiting ? h('span', { className: 'cxm-badge' }) : null,
      )
    }

    // ── page ────────────────────────────────────────────────────────────────
    function StateChip({ t, state }) {
      const token = STATE_TOKEN[state] ?? 'idle'
      return h(
        'span',
        {
          className: 'cxm-chip',
          style: { color: `var(--dsw-alias-state-${token}-primary)` },
        },
        t(`state.${state in STATE_TOKEN ? state : 'idle'}`),
      )
    }

    function ReplyBox({ t, session, onSent }) {
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [picked, setPicked] = React.useState(null)

      const options = (session.questions ?? []).flatMap((q) => q.options ?? [])

      const submit = async () => {
        const message = draft.trim()
        if (!message) return
        setBusy(true)
        setNote(null)
        try {
          await call('POST', 'codex-monitor/send', { threadId: session.id, message })
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
        { className: 'cxm-reply' },
        options.length > 0
          ? h(
              'div',
              { className: 'cxm-opts' },
              h('div', { className: 'cxm-note' }, t('reply.options')),
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
        h('textarea', {
          className: 'cxm-textarea',
          value: draft,
          placeholder: t('reply.placeholder'),
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          },
        }),
        h('div', { className: 'cxm-actions' },
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
          h('span', { className: 'cxm-note' }, t('reply.note')),
        ),
        note
          ? h('div', { className: note.ok ? 'cxm-ok' : 'cxm-bad' }, note.text)
          : null,
      )
    }

    function SessionRow({ t, session, onSent }) {
      const [open, setOpen] = React.useState(false)
      const [detail, setDetail] = React.useState(null)
      const [detailError, setDetailError] = React.useState(null)
      const [replyOpen, setReplyOpen] = React.useState(false)

      const loadDetail = useCallback(async () => {
        setDetailError(null)
        try {
          const payload = await call('POST', 'codex-monitor/status', { threadId: session.id, items: 8 })
          setDetail(payload.data)
        } catch (error) {
          setDetailError(error.message)
        }
      }, [session.id])

      useEffect(() => {
        if (open && detail === null && detailError === null) loadDetail()
      }, [open, detail, detailError, loadDetail])

      const toggle = () => {
        setOpen((was) => {
          const next = !was
          if (next) {
            setDetail(null)
            setDetailError(null)
          }
          return next
        })
      }

      const shown = detail ?? session
      const waiting = session.state === 'waiting'

      return h(
        'div',
        { className: 'cxm-row', 'data-state': session.state },
        h(
          'button',
          { type: 'button', className: 'cxm-rowhead', onClick: toggle, 'aria-expanded': open },
          h('span', {
            className: 'cxm-dot',
            style: {
              background: `var(--dsw-alias-state-${STATE_TOKEN[session.state] ?? 'idle'}-primary)`,
            },
          }),
          h(StateChip, { t, state: session.state }),
          h('span', { className: 'cxm-time' }, clock(session.updatedAt)),
          h('span', { className: 'cxm-proj' }, session.project),
          h(
            'span',
            { className: 'cxm-name' },
            session.title,
            session.lastAction
              ? h(
                  'span',
                  { style: { color: 'var(--dsw-alias-label-tertiary)' } },
                  ` · ${session.lastAction.label}: ${session.lastAction.detail}`,
                )
              : null,
          ),
        ),
        waiting && session.question
          ? h('div', { className: 'cxm-q' }, session.question)
          : null,
        open
          ? h(
              'div',
              { className: 'cxm-body' },
              h(
                'div',
                { className: 'cxm-meta' },
                h('b', null, t('row.id')),
                h('span', null, session.id),
                h('b', null, t('row.directory')),
                h('span', null, session.cwd ?? '-'),
                h('b', null, t('row.model')),
                h('span', null, session.model ?? '-'),
                shown.turn?.startedAt
                  ? [
                      h('b', { key: 'k' }, t('row.started', { time: clock(shown.turn.startedAt) })),
                      h(
                        'span',
                        { key: 'v' },
                        shown.turn.durationMs
                          ? t('row.duration', { seconds: Math.round(shown.turn.durationMs / 1000) })
                          : t('row.timing'),
                      ),
                    ]
                  : null,
              ),
              h(
                'div',
                { className: 'cxm-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cxm-btn',
                    'data-primary': waiting ? 'true' : 'false',
                    onClick: () => setReplyOpen((was) => !was),
                  },
                  replyOpen ? t('row.hide') : t('row.reply'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'cxm-btn', onClick: loadDetail },
                  t('page.refresh'),
                ),
              ),
              replyOpen
                ? h(ReplyBox, { t, session: shown, onSent })
                : null,
              detailError
                ? h('div', { className: 'cxm-bad' }, detailError)
                : null,
              shown.items && shown.items.length > 0
                ? h(
                    'div',
                    { className: 'cxm-items' },
                    shown.items.map((item, index) =>
                      h(
                        'div',
                        { className: 'cxm-item', key: index },
                        h('i', null, clock(item.at)),
                        h('span', null, `${item.label}: ${item.detail}`),
                      ),
                    ),
                  )
                : h('div', { className: 'cxm-note' }, t('row.noActions')),
            )
          : null,
      )
    }

    function MonitorPage() {
      const t = React.useContext(TranslationContext)
      const snapshot = useSnapshot()

      useEffect(() => monitor.mountPage(), [])

      const refresh = () => refreshNow()

      const body = () => {
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
              { type: 'button', className: 'cxm-btn', style: { marginTop: 12 }, onClick: refresh },
              t('page.retry'),
            ),
          )
        }
        const data = snapshot.data
        if (!data || data.sessions.length === 0) {
          return h('div', { className: 'cxm-blank' }, t('page.empty'))
        }
        return h(
          'div',
          { className: 'cxm-list' },
          data.sessions.map((session) =>
            h(SessionRow, { key: session.id, t, session, onSent: refresh }),
          ),
        )
      }

      const data = snapshot.data
      return h(
        'div',
        { className: 'cxm-page' },
        h(
          'div',
          { className: 'cxm-head' },
          h(
            'div',
            null,
            h('h1', { className: 'cxm-title' }, t('page.title')),
            h(
              'div',
              { className: 'cxm-sub' },
              data
                ? t('page.counts', {
                    total: data.counts.total,
                    running: data.counts.running,
                    waiting: data.counts.waiting,
                  })
                : t('page.title'),
              data?.generatedAt
                ? ` · ${t('page.updated', { time: clock(Math.floor(data.generatedAt / 1000)) })}`
                : '',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cxm-refresh',
              onClick: refresh,
              disabled: snapshot.phase === 'loading',
            },
            t('page.refresh'),
          ),
        ),
        body(),
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

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
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
          () => ctx.locale.register(NS, { zh, en }),
          'codex-monitor: dictionaries',
        )

        // The sidebar glyph always needs a count; the page needs fresh data while open.
        ctx.effect(() => {
          let timer = null
          const tick = () => {
            if (document.hidden) return
            void refreshNow()
          }
          const schedule = () => {
            if (timer !== null) clearInterval(timer)
            timer = setInterval(tick, monitor.busy() ? 5_000 : 30_000)
          }
          const unsubscribe = monitor.subscribe(schedule)
          void refreshNow()
          schedule()
          return () => {
            unsubscribe()
            if (timer !== null) clearInterval(timer)
            abortCurrent?.abort()
            abortCurrent = null
          }
        }, 'codex-monitor: poller')

        ctx.slots.inject('sidebar.panellist', () =>
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
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
            },
            () => h(TranslationContext.Provider, { value: t }, h(MonitorPage)),
          ),
        )
      },
    }
  },
})
