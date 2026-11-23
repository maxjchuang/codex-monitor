/**
 * Offline render harness for client.js.
 *
 * DSH forbids mocking the running UI, so this is NOT a substitute for browser
 * verification: it only proves the module factory registers its slots and that the
 * page component turns a state payload into the expected copy. Run: node verify-ui.mjs
 */
import { readFileSync } from 'node:fs'

// React stand-in that threads context through Provider/useContext.
const contextStack = []
function makeReact() {
  return {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
      return { type, props: props ?? {}, children: flat }
    },
    createContext(defaultValue) {
      const ctx = { _ctx: true, defaultValue }
      ctx.Provider = function Provider(p) {
        return { _provider: ctx, value: p.value, children: p.children }
      }
      return ctx
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useContext(c) {
      for (let i = contextStack.length - 1; i >= 0; i -= 1) {
        if (contextStack[i].ctx === c) return contextStack[i].value
      }
      return c.defaultValue
    },
    useSyncExternalStore: (sub, get) => get(),
  }
}
const React = makeReact()

let captured = null
globalThis.window = { __ModuleLoader__: { load: (r) => { captured = r } } }
// Minimal head so the plugin's style-injection effect can run.
const headChildren = []
globalThis.document = {
  hidden: false,
  head: { appendChild: (el) => headChildren.push(el), removeChild: () => {} },
  querySelector: () => null,
  createElement: (tag) => ({ tag, setAttribute(k, v) { this[k] = v }, textContent: '', remove() {} }),
}

const payload = {
  ok: true,
  data: {
    generatedAt: 1795431243564,
    counts: { total: 2, running: 1, waiting: 1 },
    sessions: [
      { id: 'aaa', cwd: '/p/base-ui', project: 'base-ui', title: '修 GridView', model: 'm',
        updatedAt: 1795431200, state: 'waiting', activityAgeSec: 12,
        question: '是否删除空白子记录？', questions: [{ title: '是否删除空白子记录？', options: ['删除这条临时记录', '保留测试记录'] }],
        lastAction: { label: '提问', detail: '等待确认' } },
      { id: 'bbb', cwd: '/p/faster', project: 'faster', title: '讨论设计', model: 'm',
        updatedAt: 1795431100, state: 'running', activityAgeSec: 3, question: null, questions: [],
        lastAction: { label: '思考', detail: '推理中' } },
    ],
  },
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload })

const dict = {
  'panel.label': 'Codex 监控', 'page.title': 'Codex 监控', 'page.refresh': '刷新',
  'page.counts': '{total} 个会话 · {running} 正在跑 · {waiting} 等你回复',
  'page.updated': '更新于 {time}', 'state.waiting': '等你回答', 'state.running': '正在跑',
  'row.reply': '回复', 'row.id': '会话', 'row.directory': '目录', 'row.model': '模型',
  'reply.send': '发送', 'reply.note': '追加一轮', 'reply.options': 'Codex 给出的选项：',
  'row.noActions': '暂无动作记录', 'page.empty': '没读到会话',
}
const translate = (key, params) => {
  let s = dict[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
  return s
}

const source = readFileSync('./client.js', 'utf8')
new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'AbortController', source)(
  globalThis.window, globalThis.document, globalThis.fetch, () => 1, () => {}, AbortController,
)

const regs = []
const ctx = {
  locale: { register: () => () => {}, bind: () => translate },
  effect: (fn) => fn(),
  slots: { inject: (s, fn) => fn(), register: (o, c) => { regs.push({ o, c }); return () => {} } },
}
captured.factory((s) => { if (s === 'react') return React; throw new Error(s) }).apply(ctx)

// Let the poller's fetch settle so the page renders data instead of skeletons.
await new Promise((r) => setTimeout(r, 50))

const texts = []
function walk(node) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node === 'string' || typeof node === 'number') {
    const s = String(node).trim()
    if (s && !s.includes('{') === false || s.includes('.cxm-')) return
    if (s && !s.startsWith('.cxm-') && !s.includes('var(--dsw')) texts.push(s)
    return
  }
  if (node._provider) { contextStack.push({ ctx: node._provider, value: node.value }); walk(node.children); contextStack.pop(); return }
  if (typeof node.type === 'function') {
    const saved = contextStack.length
    let out
    try { out = node.type({ ...node.props, children: node.children }) }
    catch (e) { texts.push('[RENDER ERROR ' + (node.type.name || '?') + ': ' + e.message + ']'); return }
    walk(out); contextStack.length = saved; return
  }
  walk(node.children)
}

const page = regs.find((r) => r.o.name === 'main')
walk(React.createElement(page.c))

console.log('--- visible text ---')
texts.forEach((t) => console.log(' ', t))
console.log('\n--- checks ---')
const cssInjected = headChildren.some((el) => el['data-plugin-css'] === 'codex-monitor' && el.textContent.includes('.cxm-page'))
console.log((cssInjected ? 'PASS ' : 'FAIL ') + 'styles injected into document.head (badge works while page unmounted)')
if (!cssInjected) process.exitCode = 1
const joined = texts.join(' | ')
const checks = [
  ['title translated', joined.includes('Codex 监控')],
  ['counts interpolated', joined.includes('2 个会话 · 1 正在跑 · 1 等你回复')],
  ['waiting state label', joined.includes('等你回答')],
  ['running state label', joined.includes('正在跑')],
  ['question surfaced', joined.includes('是否删除空白子记录')],
  ['project shown', joined.includes('base-ui')],
  ['no raw keys leaked', !/(^|\| )page\.|(^|\| )state\.|(^|\| )row\./.test(joined)],
]
let bad = 0
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) bad += 1 }

const icon = regs.find((r) => r.o.name === 'sidebar.panellist')
const iconTree = icon.c({ size: 16, active: false })
console.log('\nsidebar glyph type:', iconTree.type?.name ?? iconTree.type)
process.exit(bad === 0 ? 0 : 1)
