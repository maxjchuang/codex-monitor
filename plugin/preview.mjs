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
  '--dsw-alias-label-primary-foreground': '#ffffff',
  '--dsw-alias-state-warn-label': '#b45309',
  '--dsw-alias-state-warn-primary': '#f59e0b',
  '--dsw-alias-state-success-primary': '#16a34a',
  '--dsw-alias-state-business-primary': '#2563eb',
  '--dsw-alias-state-idle-primary': '#9ca3af',
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

const groups = [
  ['bitable-sdk', [
    ['GridView 表格组件', '18:53', 'waiting', '是否按东八区重新解析？'],
    ['修复底部栏未渲染', '18:40', 'running', null],
    ['定位双向关联字段显示为空', '17:22', 'stopped', null],
  ]],
  ['Bitable 组件库', [
    ['接入 MCP', '18:51', 'running', null],
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
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
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

const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;font-family:-apple-system,"PingFang SC",system-ui,sans-serif}
:root{${Object.entries(light).map(([k, v]) => `${k}:${v}`).join(';')}}
${css}
body{background:var(--dsw-alias-bg-base)}
.cxm-page{height:100vh}
</style>
<div class="cxm-page">
  <div class="cxm-list-pane">
    <div class="cxm-list-head">
      <h1 class="cxm-list-title"><span>会话</span><button class="cxm-btn">刷新</button></h1>
      <div class="cxm-list-counts">6 个会话 · 2 正在跑 · 1 等你回复</div>
    </div>
    <div class="cxm-list-body">${rows}</div>
  </div>
  <div class="cxm-chat-pane">
    <div class="cxm-chat-head">
      <div class="cxm-chat-titles">
        <h2 class="cxm-chat-name">修 GridView 空行</h2>
        <div class="cxm-chat-meta">base-ui · gpt-5-codex · 01a1f73c</div>
      </div>
      <div class="cxm-chat-side">
        <span class="cxm-chip" data-tone="warn">等你回答</span>
        <button class="cxm-btn">刷新</button>
      </div>
    </div>
    <div class="cxm-transcript">
      <div class="cxm-flow">
        <div class="cxm-msg" data-role="user">
          <div class="cxm-bubble">帮我看看截图里箭头指向的「添加本地文件」在暗色下的默认态和悬停态。</div>
          <div class="cxm-stamp">18:50</div>
        </div>
        <div class="cxm-msg" data-role="agent">
          <div class="cxm-bubble">我会对照 4001 和 Demo，重点看截图箭头指向的「添加本地文件」在暗色下的默认态和悬停态，同时检查整行悬停是否影响到相邻元素。</div>
        </div>
        <div class="cxm-action"><b>执行命令</b><span class="cxm-cmd">/bin/zsh -lc 'rg -n "GridView" src'</span></div>
        <div class="cxm-action"><b>执行命令</b><span class="cxm-cmd">npm test</span><span class="cxm-run">共 63 步</span></div>
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
        <button class="cxm-opt">删除这条临时记录</button>
        <button class="cxm-opt">保留测试记录</button>
      </div>
      <div class="cxm-input-row">
        <textarea class="cxm-textarea" placeholder="给这个 Codex 会话发消息…"></textarea>
        <button class="cxm-btn" data-primary="true">发送</button>
      </div>
      <div class="cxm-note">追加为新的一轮，不打断正在跑的任务。⌘↵ 发送。</div>
    </div>
  </div>
</div>`

const out = process.argv[2] ?? '/tmp/cxm-preview.png'
const htmlPath = '/tmp/cxm-preview.html'
writeFileSync(htmlPath, html)
execFileSync(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless', '--disable-gpu', `--screenshot=${out}`, '--window-size=1200,760',
   '--hide-scrollbars', '--force-device-scale-factor=2', `file://${htmlPath}`],
  { stdio: 'ignore' },
)
console.log(out)
