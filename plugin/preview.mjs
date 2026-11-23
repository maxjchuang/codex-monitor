#!/usr/bin/env node
/**
 * Render the plugin's transcript styles to a PNG so layout can be inspected.
 *
 * The real DSH shell is not scriptable from here, so this rebuilds the same DOM the
 * React components produce, using the CSS extracted verbatim from client.js and the
 * light-theme values of the same `--dsw-*` tokens the app defines. It is a layout
 * check, not a substitute for looking at the running app.
 *
 * Usage: node preview.mjs [out.png]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const css = source.match(/const CSS = `([\s\S]*?)`\n/)[1]

// Reuse the renderer from client.js rather than reimplementing it here, so the
// preview cannot drift from what the app actually renders.
const mdLines = source.split('\n')
const mdStart = mdLines.findIndex((l) => l.includes('A small Markdown renderer for Codex transcripts')) - 1
const mdFn = mdLines.findIndex((l) => l.includes('function renderMarkdown(text, h, keyPrefix'))
const mdEnd = mdLines.findIndex((l, i) => i > mdFn && l.trim() === '}')
const mdBlock = mdLines.slice(mdStart, mdEnd + 1).join('\n').replace(/^ {4}/gm, '')
const nodeH = (type, props, ...children) => ({ type, props: props ?? {}, children: children.filter((c) => c != null) })
const renderMarkdown = new Function('h', `${mdBlock}\n;return renderMarkdown;`)(nodeH)

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Render Markdown to an HTML string for the static preview. */
function mdToHtml(text) {
  const toHtml = (node) => {
    if (node == null) return ''
    if (typeof node === 'string') return esc(node)
    if (Array.isArray(node)) return node.map(toHtml).join('')
    const inner = (node.children ?? []).map(toHtml).join('')
    const t = node.type
    const cls = node.props?.className ? ` class="${node.props.className}"` : ''
    if (t === 'a') return `<a${cls} href="${esc(node.props.href)}">${inner}</a>`
    if (t === 'pre') return `<pre${cls}><code>${inner}</code></pre>`
    if (t === 'div') return `<div${cls}>${inner}</div>`
    return `<${t}${cls}>${inner}</${t}>`
  }
  return (renderMarkdown(text, nodeH) ?? []).map(toHtml).join('')
}

// Light-theme values, copied from dsh-client-ui-theme so the preview is faithful.
const light = {
  '--dsw-alias-bg-base': '#ffffff',
  '--dsw-alias-label-primary': '#0f1114',
  '--dsw-alias-label-secondary': '#41464d',
  '--dsw-alias-label-tertiary': '#6b7280',
  '--dsw-alias-label-caption': '#9aa1ab',
  '--dsw-alias-border-l1': '#0000000a',
  '--dsw-alias-border-l2': '#0000001a',
  '--dsw-alias-border-l3': '#0000001f',
  '--dsw-alias-markdown-code-block': '#f7f8fa',
  '--dsw-alias-link': '#2563eb',
  '--dsw-radius-xs': '4px',
  '--dsw-radius-md': '12px',
  '--dsw-alias-markdown-placeholder': '#a6acb5',
  '--dsw-alias-brand-primary': '#1b1c1f',
  '--dsw-specific-bubble': '#eef3ff',
  '--dsw-specific-input-major': '#ffffff',
  '--dsw-alias-button-primary-fill': '#1b1c1f',
  // DSH 发送键用 info 色（DeepSeek 蓝），不是 primary 黑。
  '--dsw-alias-button-info-fill': '#4176e6',
  '--dsw-radius-panel': '28px',
  '--dsw-elevation-soft': '0 0 0 .5px #00000014, 0 4px 16px 0 #00000008, 0 0 24px 0 #00000008',
  '--dsw-alias-button-info-hover': '#7aaaff',
  '--dsw-alias-label-primary-foreground': '#ffffff',
  '--dsw-alias-state-warn-label': '#b45309',
  '--dsw-alias-state-warn-primary': '#f59e0b',
  '--dsw-alias-state-success-primary': '#16a34a',
  '--dsw-alias-state-business-primary': '#2563eb',
  '--dsw-alias-state-idle-primary': '#9ca3af',
  // 抽屉相关的 DSH token，值取自 dsh-client-ui-layout / theme 包。
  '--dsw-alias-bg-mask-1': '#0000003d',
  '--dsw-mask-blur': 'none',
  '--ds-transition-duration-slow': '.3s',
  '--ds-ease-in-out': 'cubic-bezier(.4, 0, .2, 1)',
  '--dsw-specific-sidebar-fill': '#f7f8fa',
  '--dsw-alias-bg-layer-1': '#ffffff',
  '--dsw-alias-bg-layer-2': '#f2f3f5',
  '--dsw-alias-bg-skeleton': '#0000000a',
  '--dsw-alias-interactive-bg-hover': '#2631480f',
  '--dsw-alias-button-primary-hover': '#33353a',
  '--dsw-radius-sm': '8px',
  '--dsw-radius-md': '12px',
  '--dsw-radius-lg': '16px',
  '--dsw-radius-xl': '20px',
  '--dsw-focus-ring-color': '#4176e6',
  '--dsw-focus-ring-width': '2px',
  '--dsh-frame-top-clearance': '0px',
  '--dsh-content-font-size': '14px',
  '--dsw-font-markdown-code-block-small':
    '11px / 16px ui-monospace, SFMono-Regular, Menlo, monospace',
}

const pinned = [
  ['GridView 表格组件', '18:53', 'waiting', '是否按东八区重新解析？'],
  ['接入 MCP', '18:51', 'running', null],
]

const pin = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M5.6 1.9h4.8l-.9 3.4 2.2 2.2v1.2H4.3V7.5l2.2-2.2-.9-3.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 8.7v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`

const pinnedTitles = new Set(pinned.map((r) => r[0]))
const MODE = process.argv[3] === 'recent' ? 'recent' : 'project'

const groups = [
  ['bitable-sdk', [
    ['修复底部栏未渲染', '18:40', 'running', null],
    ['定位双向关联字段显示为空', '17:22', 'stopped', null],
  ]],
  ['Bitable 组件库', [
    ['拉取 develop 启动 Storybook', '16:03', 'done', null],
  ]],
  ['faster', [
    ['Faster Agent', '15:12', 'done', null],
  ]],
]

const folder = (open) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="${
    open
      ? 'M2 5.5A1.5 1.5 0 0 1 3.5 4h2.6l1.2 1.4h4.2A1.5 1.5 0 0 1 13 6.9v3.6a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 10.5z'
      : 'M2 5A1.5 1.5 0 0 1 3.5 3.5h2.4l1.3 1.5h4.3A1.5 1.5 0 0 1 13 6.5V11a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 11z'
  }" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`

const toneOf = (state) =>
  state === 'waiting' ? 'warn'
  : state === 'running' ? 'business'
  : state === 'done' ? 'success'
  : 'idle'

// 和项目内的会话行同一套结构，只是没有缩进。
const sessionRow = ([title, time, state, ask]) => `
        <button class="cxm-row" data-waiting="${state === 'waiting' && ask ? 'true' : 'false'}">
          <span class="cxm-slot">
            <span class="cxm-dot" style="background:var(--dsw-alias-state-${toneOf(state)}-primary)"></span>
          </span>
          <span class="cxm-row-name">${title}</span>
          ${
            state === 'waiting' && ask
              ? `<span class="cxm-row-ask">${ask}</span>`
              : `<span class="cxm-row-time">${time}</span>`
          }
        </button>`

const recentRows = [...pinned.map(r => r)].slice(0,0).concat([['回复两个字：可用','18:47','stopped',null],['确认额度不足接入 AgentPlan','17:58','done',null],['复现并定位甘特图日期错位','16:31','done',null]]).map(sessionRow).join('')

const pinnedBlock = `
        <button class="cxm-group-head" title="置顶">
          <span class="cxm-group-slot">
            <span class="cxm-group-folder">${pin}</span>
            <span class="cxm-group-chevron">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="transform:rotate(90deg)"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </span>
          <span class="cxm-group-name">置顶</span>
          <span class="cxm-group-count">${pinned.length}</span>
        </button>${pinned.map(sessionRow).join('')}`

const rows = groups
  .map(([project, items]) => {
    const waiting = items.filter((i) => i[2] === 'waiting').length
    const running = items.filter((i) => i[2] === 'running').length
    const badge =
      waiting > 0
        ? `<span class="cxm-chip" data-tone="warn">${waiting} 个等你回答</span>`
        : running > 0
          ? `<span class="cxm-chip" data-tone="business">${running} 个正在跑</span>`
          : ''
    const head = `
        <button class="cxm-group-head" title="${project}">
          <span class="cxm-group-slot">
            <span class="cxm-group-folder">${folder(true)}</span>
            <span class="cxm-group-chevron">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="transform:rotate(90deg)"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </span>
          <span class="cxm-group-name">${project}</span>
          ${badge}
          <span class="cxm-group-count">${items.length}</span>
        </button>`
    const CAP = 2
    const shown = items.slice(0, CAP)
    const more =
      items.length > CAP
        ? `<button class="cxm-group-more">展开显示 ${items.length - CAP} 个</button>`
        : ''
    const list = shown
      .map(([title, time, state, ask]) => {
        const tone =
          state === 'waiting' ? 'warn'
          : state === 'running' ? 'business'
          : state === 'done' ? 'success'
          : 'idle'
        const isWaiting = state === 'waiting' && ask
        return `
        <button class="cxm-row" data-waiting="${isWaiting ? 'true' : 'false'}">
          <span class="cxm-slot">
            <span class="cxm-dot" style="background:var(--dsw-alias-state-${tone}-primary)"></span>
          </span>
          <span class="cxm-row-name">${title}</span>
          ${
            isWaiting
              ? `<span class="cxm-row-ask">${ask}</span>`
              : `<span class="cxm-row-time">${time}</span>`
          }
        </button>`
      })
      .join('')
    return head + list + more
  })
  .join('')

// Real shapes Codex emits: inline code, bold, links, a list, and a table.
const agent1 = [
  '找到了：暗色下默认态的边框用的是 `border-l2` 这个边框色，在深色背景上几乎看不见；悬停态则错误地复用了默认态。',
  '',
  '改动如下：',
  '',
  '- `--gridview-border`: `border-l2` → `border-l3`',
  '- 悬停态单独用 **`border-l4`**，不再复用默认态',
  '- 顺带修掉 `hover` 影响相邻元素的问题',
  '',
  '| 场景 | 旧值 | 新值 |',
  '| --- | --- | --- |',
  '| 默认态 | border-l2 | border-l3 |',
  '| 悬停态 | border-l2 | border-l4 |',
  '',
  '改完可以看 [Storybook 对照页](http://127.0.0.1:6211/grid-review/sheet-1.html)。',
].join('\n')

const out = process.argv[2] ?? '/tmp/cxm-preview.png'
// 变体：collapsed 看收起态，mobile 看窄屏覆盖式抽屉。默认是桌面展开态。
const variant = process.argv[3] ?? 'default'
// locked 可以单独用，也可以和 mobile 组合（locked-mobile），验证窄屏下的换行。
const locked = variant.startsWith('locked')
// locked-busy / locked-idle 分别对应「正在跑只能等」和「只是开着可以去关掉」。
const lockReason = variant === 'locked-busy' ? 'busy' : variant === 'locked-idle' ? 'idle' : 'unknown'
const LOCK_TEXT = {
  busy: 'Codex 正在跑这个会话，这会儿插不进去。等这一轮结束就能发，这里会自动恢复。',
  idle: 'Codex 桌面端开着这个会话，一直占着不放。关掉 Codex 桌面端（或在里面结束这个会话）就能发。',
  unknown: '这个会话被另一个进程占着，暂时不能投递。关掉占用它的程序后这里会自动恢复。',
}[lockReason]
const listOpen = variant === 'collapsed' || variant.startsWith('mobile') || variant === 'drawer-closed' ? 'false' : 'true'
const drawer = variant.startsWith('mobile') || variant === 'drawer' || variant === 'drawer-closed' ? 'true' : 'false'
// Chrome headless 的 viewport 最小就是 500px，窗口设更小只会裁掉右边，
// 截出来的图看着像溢出，其实页面本身没问题。
const size = variant.startsWith('mobile') || variant.startsWith('drawer') || variant === 'locked-mobile' ? '500,900' : '1200,760'
// 用真实截图当样例，免得预览里是个占位方块。
// 预览用的样例图放在 docs/ 里，别引用本机临时目录（别人跑不起来）。
const SHOT = (() => {
  try {
    return `data:image/png;base64,${readFileSync('docs/sample-shot.png').toString('base64')}`
  } catch {
    return 'data:image/gif;base64,R0lGODlhAQABAAAAACw='
  }
})()

const htmlPath = `/tmp/cxm-preview-${variant}.html`

const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;font-family:-apple-system,"PingFang SC",system-ui,sans-serif}
:root{${Object.entries(light).map(([k, v]) => `${k}:${v}`).join(';')}}
${css}
body{margin:0;background:var(--dsw-alias-bg-base)}
.cxm-page{height:100vh}
</style>
<div class="cxm-page" data-drawer="${drawer}">
  <div class="cxm-list-pane" data-open="${listOpen}">
    <div class="cxm-list-head">
      <h1 class="cxm-list-title"><span>会话</span><span class="cxm-seg" role="tablist" aria-label="分组方式">${MODE === 'project' ? '<button class="cxm-seg-btn" data-active="true" role="tab" aria-selected="true">按项目</button><button class="cxm-seg-btn" data-active="false" role="tab" aria-selected="false">按最近</button>' : '<button class="cxm-seg-btn" data-active="false" role="tab" aria-selected="false">按项目</button><button class="cxm-seg-btn" data-active="true" role="tab" aria-selected="true">按最近</button>'}</span><button class="cxm-icon-btn" data-size="sm" aria-label="刷新" title="刷新"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M14 8a6 6 0 0 1-10.2 4.3L2 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 14v-3.5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 8a6 6 0 0 1 10.2-4.3L14 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v3.5h-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button></h1>
      <div class="cxm-list-counts">6 个会话 · 2 正在跑 · 1 等你回复</div>
    </div>
    <div class="cxm-list-body">${pinnedBlock}${MODE === 'recent' ? recentRows : rows}</div>
  </div>
  <button class="cxm-drawer-mask" aria-hidden="true"></button>
  <div class="cxm-chat-pane">
    <div class="cxm-chat-head">
      <button class="cxm-list-toggle" aria-label="收起会话列表">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" stroke-width="1.3"/>
          <path d="M6.25 2.75v10.5" stroke="currentColor" stroke-width="1.3"/>
          <rect x="3.1" y="4.1" width="2.1" height="7.8" rx="0.9" fill="currentColor"/>
        </svg>
      </button>
      <div class="cxm-chat-titles">
        <h2 class="cxm-chat-name">修 GridView 空行</h2>
        <div class="cxm-chat-meta">base-ui · gpt-5-codex · 01a1f73c</div>
      </div>
      <div class="cxm-chat-side">
        <span class="cxm-chip" data-tone="warn">等你回答</span>
        <button class="cxm-icon-btn" aria-label="刷新" title="刷新"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M14 8a6 6 0 0 1-10.2 4.3L2 10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 14v-3.5h3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 8a6 6 0 0 1 10.2-4.3L14 5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v3.5h-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
    <div class="cxm-transcript">
      <div class="cxm-more"><button class="cxm-more-btn">加载更早的消息</button></div>
      <div class="cxm-flow">
        <div class="cxm-msg" data-role="user">
          <div class="cxm-shots"><img class="cxm-shot" src="${SHOT}" alt="用户附的图 1"></div>
          <div class="cxm-bubble">附件的这两个图标不符合预期，是什么原因？</div>
          <div class="cxm-stamp">18:50</div>
        </div>
        <div class="cxm-work" data-open="false">
          <button class="cxm-work-head" aria-expanded="false">
            <span class="cxm-work-time">用时 6 分钟 29 秒</span>
            <span class="cxm-work-chevron"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          </button>
        </div>
        <div class="cxm-msg" data-role="agent">
          <div class="cxm-bubble">${mdToHtml(agent1)}</div>
        </div>
        <div class="cxm-msg" data-role="user">
          <div class="cxm-bubble">删掉吧，保留正式记录就行。</div>
          <div class="cxm-stamp">18:53</div>
        </div>
        <div class="cxm-msg" data-role="agent">
          <div class="cxm-bubble">好，我删掉临时记录。</div>
          <div class="cxm-ask-block">
            <div class="cxm-ask-title">Codex 在等你回答</div>
            <div class="cxm-ask-q">是否删除空白子记录？</div>
          </div>
        </div>
      </div>
    </div>
    <div class="cxm-composer">
      <div class="cxm-opts">
        <span class="cxm-opts-label">Codex 给出的选项（点击填入）：</span>
        <button class="cxm-opt" disabled>删除这条临时记录</button>
        <button class="cxm-opt" disabled>保留测试记录</button>
      </div>
        <div class="cxm-card"${locked ? ' data-locked="true"' : ''}>
        ${locked && variant !== 'locked-draft'
          ? `<div class="cxm-locked" role="status" data-reason="${lockReason}"><span class="cxm-locked-dot" aria-hidden="true"></span>${LOCK_TEXT}</div>`
          : `<textarea class="cxm-textarea"${locked ? ' disabled' : ''} rows="1" placeholder="给这个 Codex 会话发消息…">${variant === 'locked-draft' ? '我已经打了一半的字，别弄丢' : ''}</textarea>`}
        <div class="cxm-dock">
          <button class="cxm-send" disabled aria-label="发送消息" title="发送消息"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor"/></svg></button>
        </div>
      </div>
      <div class="cxm-note">追加为新的一轮，不打断正在跑的任务。⌘↵ 发送。</div>
    </div>
  </div>
</div>`

writeFileSync(htmlPath, html.replaceAll('${listOpen}', listOpen).replaceAll('${drawer}', drawer))
execFileSync(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless', '--disable-gpu', `--screenshot=${out}`, `--window-size=${size}`,
   '--hide-scrollbars', '--force-device-scale-factor=2', `file://${htmlPath}`],
  { stdio: 'ignore' },
)
console.log(out)
