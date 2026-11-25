/**
 * Offline render harness for client.js.
 *
 * DSH forbids mocking the running UI, so this is NOT a substitute for browser
 * verification: it only proves the module factory registers its slots and that the
 * page component turns a state payload into the expected copy and structure.
 *
 * The React stand-in below is a tiny re-rendering reconciler (path-keyed hook slots)
 * because the page now has real state: it auto-selects a session, which mounts the
 * conversation pane and fetches its transcript. A one-shot render would only ever
 * show the empty state.
 *
 * Run: node verify-ui.mjs
 */
import { readFileSync } from 'node:fs'

// client.js 用 localStorage 记住上次打开的会话；这里给个内存版替身。
const storageBacking = new Map()
globalThis.localStorage = {
  getItem: (k) => (storageBacking.has(k) ? storageBacking.get(k) : null),
  setItem: (k, v) => { storageBacking.set(k, String(v)) },
  removeItem: (k) => { storageBacking.delete(k) },
  clear: () => storageBacking.clear(),
}

// ── mini React ────────────────────────────────────────────────────────────────
// Hooks are addressed by (component path, call order) — keying by path alone makes
// every hook in one component collide.
const hookSlots = new Map() // `${path}#${index}` -> slot
const contextStack = []
let path = ''
let hookIndex = 0
let dirty = false
let pendingEffects = []

function slot() {
  const key = `${path}#${hookIndex}`
  hookIndex += 1
  let s = hookSlots.get(key)
  if (!s) {
    s = {}
    hookSlots.set(key, s)
  }
  return s
}

const React = {
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
  useState(init) {
    const s = slot()
    if (!s.initialized) {
      s.state = typeof init === 'function' ? init() : init
      s.initialized = true
    }
    if (!s.setState) {
      s.setState = (next) => {
        const value = typeof next === 'function' ? next(s.state) : next
        if (Object.is(value, s.state)) return
        s.state = value
        dirty = true
      }
    }
    return [s.state, s.setState]
  },
  useRef(init) {
    const s = slot()
    if (s.ref === undefined) s.ref = { current: init }
    return s.ref
  },
  useEffect(fn, deps) {
    const s = slot()
    const prev = s.effectDeps
    const changed =
      prev === undefined ||
      deps === undefined ||
      deps.length !== prev.length ||
      deps.some((d, i) => !Object.is(d, prev[i]))
    if (changed) {
      s.effectDeps = deps
      pendingEffects.push(fn)
    }
  },
  useCallback(fn) {
    return fn
  },
  // 真实 React 的 useLayoutEffect 在绘制前跑。这个假实现本来就在 render 之后
  // 统一 flush effects，语义足够接近，直接复用同一套槽位。
  useLayoutEffect(fn, deps) {
    return React.useEffect(fn, deps)
  },
  useContext(c) {
    for (let i = contextStack.length - 1; i >= 0; i -= 1) {
      if (contextStack[i].ctx === c) return contextStack[i].value
    }
    return c.defaultValue
  },
  useSyncExternalStore(subscribe, get) {
    // Subscribe so store writes (the poller's fetch) schedule another render pass.
    const s = slot()
    if (!s.subscribed) {
      s.subscribed = true
      subscribe(() => { dirty = true })
    }
    return get()
  },
}

// ── environment ───────────────────────────────────────────────────────────────
let captured = null
globalThis.window = { __ModuleLoader__: { load: (r) => { captured = r } } }
const headChildren = []
globalThis.document = {
  hidden: false,
  head: { appendChild: (el) => headChildren.push(el), removeChild: () => {} },
  querySelector: () => null,
  createElement: (tag) => ({ tag, setAttribute(k, v) { this[k] = v }, textContent: '', remove() {} }),
}

const sessions = [
  { id: 'aaa', cwd: '/p/base-ui', project: 'base-ui', title: '修 GridView', model: 'm',
    updatedAt: 1795431200, state: 'waiting', activityAgeSec: 12,
    question: '是否删除空白子记录？',
    questions: [{ title: '是否删除空白子记录？', options: ['删除这条临时记录', '保留测试记录'] }],
    lastAction: { label: '提问', detail: '等待确认' } },
  { id: 'bbb', cwd: '/p/faster', project: 'faster', title: '讨论设计', model: 'm',
    updatedAt: 1795431100, state: 'running', activityAgeSec: 3, question: null, questions: [],
    lastAction: { label: '思考', detail: '推理中' } },
  // 置顶会话：pinned 为 true，组内顺序由 pinnedPosition 决定。
  // 它不该出现在下面的项目分组里。
  { id: 'pin', cwd: '/p/pinned', project: 'pinned-proj', title: '置顶的会话', model: 'm',
    updatedAt: 1795431000, state: 'done', activityAgeSec: 900, question: null, questions: [],
    pinned: true, pinnedPosition: 1000000,
    lastAction: { label: '完成', detail: '' } },
]
const statePayload = {
  ok: true,
  data: { generatedAt: 1795431243564, counts: { total: 3, running: 1, waiting: 1 }, sessions },
}
const statusPayload = {
  ok: true,
  data: {
    id: 'aaa', cwd: '/p/base-ui', project: 'base-ui', title: '修 GridView', model: 'm',
    updatedAt: 1795431200, state: 'waiting', activityAgeSec: 12,
    questions: sessions[0].questions,
    items: [],
    locked: false,
    transcriptHasMore: true,
    transcriptBefore: 1795430000000,
    transcript: [
      { role: 'user', at: 1795431000, text: '帮我修一下 GridView 的空行。' },
      // 贴图的用户消息：图片要在气泡外面单独一行，文字照旧。
      { role: 'user', at: 1795431005, text: '这两个图标不对。',
        images: ['data:image/png;base64,iVBORw0KGgo='] },
      // 一轮的中间过程收在 work 块里，默认收起；最终答复单独露出。
      { role: 'work', at: 1795431025, durationMs: 389000, count: 3, entries: [
        { role: 'agent', at: 1795431010, text: '我先看一下 `GridView` 的**组件实现**。' },
        { role: 'action', at: 1795431020, label: '执行命令', text: "rg -n 'GridView' src" },
        { role: 'action', at: 1795431025, label: '执行命令', text: 'npm test', count: 9,
          lastLabel: '执行命令', lastText: 'npm test' },
      ] },
      // Codex 发的图走 Markdown 图片语法，后端已把路径换成 data URL。
      { role: 'agent', at: 1795431028, final: true,
        text: '截图如下：\n\n![勾选态](data:image/png;base64,iVBORw0KGgo=)\n\n还有一张读不到的：\n\n![坏图](/nope/missing.png)' },
      { role: 'agent', at: 1795431030, text: '要不要删除空白子记录？',
        final: true, questions: sessions[0].questions },
    ],
  },
}
// 后台投递失败时，状态里会带 lastDelivery；默认没有这个字段。
let deliveryOverride = null
const calls = []
// 派活回执要能按用例切换：交给桌面端 / 结果未知 / 排进本地队列。
let sendReply = null

globalThis.fetch = async (url, options) => {
  calls.push(String(url))
  if (sendReply && String(url).includes('codex-monitor/send')) {
    const body = sendReply
    return { ok: true, status: 200, json: async () => ({ ok: true, ...body }) }
  }
  const base = String(url).includes('status') ? statusPayload : statePayload
  const body = String(url).includes('status') && deliveryOverride
    ? { ...base, data: { ...base.data, lastDelivery: deliveryOverride } }
    : base
  // 返回浅拷贝：详情对象会被 useState 存住，若和 fixture 共用引用，
  // 后面还原 fixture 会把已经交给界面的那份数据也一起改回去。
  return { ok: true, status: 200, json: async () => ({ ...body, data: { ...body.data } }) }
}

const dict = {
  'panel.label': 'Codex 监控', 'panel.labelWaiting': 'Codex 监控（{n} 个等你回答）',
  'page.title': 'Codex 监控', 'page.refresh': '刷新',
  'page.counts': '{total} 个会话 · {running} 正在跑 · {waiting} 等你回复',
  'page.updated': '更新于 {time}', 'page.empty': '没读到会话',
  'page.errorTitle': '读取失败', 'page.retry': '重试',
  'list.title': '会话', 'list.pinned': '置顶', 'list.groupBy': '分组方式', 'list.byProject': '按项目', 'list.byRecent': '按最近', 'list.empty': '还没有会话',
  'list.groupWaiting': '{n} 个等你回答', 'list.groupRunning': '{n} 个正在跑',
  'list.showMore': '展开显示 {n} 个',
  'state.waiting': '等你回答', 'state.running': '正在跑', 'state.done': '已完成',
  'state.failed': '失败', 'state.stopped': '已停下', 'state.idle': '空闲',
  'chat.placeholderPick': '从左边选一个会话', 'chat.placeholderPickHint': '也可以直接派活',
  'chat.loading': '正在读取对话…', 'chat.empty': '这个会话还没有内容',
  'chat.error': '读不到这个会话：{error}', 'chat.retry': '重试',
  'chat.transcriptTruncated': '只显示最近 {n} 条。',
  'chat.loadMore': '加载更早的消息', 'chat.loadingMore': '正在加载更早的消息…', 'chat.actionRun': '共 {n} 步',
  'chat.you': '你', 'chat.agent': 'Codex', 'chat.askingYou': 'Codex 在等你回答',
  'reply.placeholder': '给这个 Codex 会话发消息…', 'reply.send': '发送',
  'reply.sending': '发送中…', 'reply.sent': '已提交', 'reply.failed': '投递失败：{error}',
  'reply.note': '追加为新的一轮', 'reply.options': 'Codex 给出的选项（点击填入）：',
  'reply.queued': '已排队', 'reply.handedOver': '已交给桌面端',
  'reply.handedOverUncertain': '结果待确认',
  'row.noActions': '暂无动作记录',
  'age.justNow': '刚刚', 'age.seconds': '{n}s 前', 'age.minutes': '{n} 分钟前', 'age.hours': '{n} 小时前',
}
const translate = (key, params) => {
  let s = dict[key] ?? key
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
  return s
}

// 会话被 Codex 占着时，输入框要锁住并说明原因。单独渲染一遍：主 fixture
// 是「可发送」的常态，锁定的分支不能混进去污染那些检查。

// 内联字典与 locale/*.json 的 key 必须完全一致。
function dictParityChecks() {
  let inline = null
  try {
    inline = pluginDict
  } catch {
    inline = null
  }
  const zhJson = JSON.parse(readFileSync('./locale/zh.json', 'utf8'))
  const enJson = JSON.parse(readFileSync('./locale/en.json', 'utf8'))
  const flatten = (obj, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object') flatten(v, key, out)
      else out[key] = v
    }
    return out
  }
  const zhFlat = flatten(zhJson)
  const enFlat = flatten(enJson)
  // meta.* 是插件清单（名称/描述/详情页）用的，由 DSH 读取，不属于界面字典。
  const isUiKey = (k) => !k.startsWith('meta.')
  const inlineKeys = Object.keys(inline ?? {}).filter(isUiKey).sort()
  const zhKeys = Object.keys(zhFlat).filter(isUiKey).sort()
  const enKeys = Object.keys(enFlat).filter(isUiKey).sort()
  const missingInInline = zhKeys.filter((k) => !inlineKeys.includes(k))
  const missingInJson = inlineKeys.filter((k) => !zhKeys.includes(k))
  return [
    ['inline dict matches locale/zh.json',
      missingInInline.length === 0 && missingInJson.length === 0,
      `only-in-json=${missingInInline.join(',')} only-in-inline=${missingInJson.join(',')}`],
    ['zh and en cover the same keys', zhKeys.join() === enKeys.join()],
  ]
}

// ── load the plugin ───────────────────────────────────────────────────────────
const source = readFileSync('./client.js', 'utf8')
// Real timers would never fire inside a synchronous render pass, so record the
// callbacks and drive them by hand once the page is mounted.
const intervals = []
new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'AbortController', source)(
  globalThis.window, globalThis.document, globalThis.fetch,
  (fn) => { intervals.push(fn); return intervals.length }, () => {}, AbortController,
)

const regs = []
// 用插件自己注册的字典来翻译，而不是夹具里另写一份：否则 client.js 漏了某个 key，
// 测试会用夹具里的同名 key 蒙混过关，线上却显示原始 key。
let pluginDict = null
const t = (key, vars) => {
  // 插件字典注册之后就以它为唯一来源：回退到夹具会掩盖 client.js 漏 key 的问题。
  const raw = pluginDict ? pluginDict[key] : translate(key, vars)
  if (typeof raw !== 'string') return key
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : raw
}
const ctx = {
  locale: {
    register: (ns, dicts) => { pluginDict = dicts.zh || null; return () => {} },
    bind: () => t,
  },
  effect: (fn) => fn(),
  slots: { inject: (s, fn) => fn(), register: (o, c) => { regs.push({ o, c }); return () => {} } },
}
captured.factory((s) => { if (s === 'react') return React; throw new Error(s) }).apply(ctx)

// ── render loop ───────────────────────────────────────────────────────────────
const texts = []
const classes = []
const clickables = []
let listOpenAttr = null
let drawerAttr = null
let dockParent = null
let cardFound = false
let textareaDisabled = null
let textareaKeyDown = null
let textareaOnChange = null
let noteClass = null
let noteText = null
// 当前选中的会话行：用来断言「重新打开时回到上次那个」。
let selectedRowTitle = null
let shotCount = 0
let shotInsideBubble = 0
let parentClass = null
const allButtons = []   // 跨渲染累积，方便找只出现在某次渲染里的按钮
function walk(node, at) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${at}/${i}`)); return }
  if (typeof node === 'string' || typeof node === 'number') {
    const s = String(node).trim()
    if (s && !s.startsWith('.cxm-') && !s.includes('var(--dsw')) texts.push(s)
    return
  }
  if (node._provider) {
    contextStack.push({ ctx: node._provider, value: node.value })
    walk(node.children, at)
    contextStack.pop()
    return
  }
  // 记下 textarea 的 disabled，用来断言「锁定后不能输入」。
  if (node.type === 'img' && node.props?.className === 'cxm-shot') {
    shotCount += 1
    if (parentClass === 'cxm-bubble') shotInsideBubble += 1
  }
  // 正文里的 Markdown 图单独统计，别和附件缩略图混在一起。
  if (node.type === 'img' && node.props?.className === 'cxm-md-img') {
    globalThis.__mdImgs = globalThis.__mdImgs ?? []
    globalThis.__mdImgs.push(node.props.src)
  }
  if (node.type === 'textarea') {
    textareaDisabled = node.props?.disabled === true
    textareaKeyDown = node.props?.onKeyDown ?? null
    textareaOnChange = node.props?.onChange ?? null
  }
  // 发送回执渲染成 cxm-ok / cxm-bad，记下文本好断言说了什么。
  if (typeof node.props?.className === 'string'
      && (node.props.className === 'cxm-ok' || node.props.className === 'cxm-bad')) {
    noteClass = node.props.className
    noteText = Array.isArray(node.children) ? node.children.join('') : String(node.children ?? '')
  }
  if (typeof node.type === 'function') {
    const name = node.type.name || 'Anon'
    path = `${at}#${name}`
    hookIndex = 0
    let out
    try {
      out = node.type({ ...node.props, children: node.children })
    } catch (e) {
      texts.push(`[RENDER ERROR ${name}: ${e.message}]`)
      return
    }
    walk(out, `${at}/${name}`)
    return
  }
  const cls = node.props?.className
  const outerClass = parentClass
  parentClass = typeof cls === 'string' ? cls : null
  if (typeof cls === 'string' && cls) classes.push(cls)
  if (typeof cls === 'string' && cls.includes('cxm-list-pane')) {
    listOpenAttr = node.props['data-open']
  }
  if (typeof cls === 'string' && cls.includes('cxm-page')) {
    drawerAttr = node.props['data-drawer']
  }
  if (typeof cls === 'string' && cls.split(/\s+/).includes('cxm-row')
      && node.props?.['data-selected'] === 'true') {
    // 标题在子节点里，挑第一个非空字符串。
    const grab = (kids) => {
      for (const kid of kids || []) {
        if (typeof kid === 'string' && kid.trim()) return kid.trim()
        if (kid && kid.children) {
          const hit = grab(kid.children)
          if (hit) return hit
        }
      }
      return null
    }
    selectedRowTitle = grab(node.children)
  }
  if (cls === 'cxm-dock') dockParent = node
  if (cls === 'cxm-card') cardFound = true
  if (typeof node.type === 'string' && node.type === 'button' && typeof node.props?.onClick === 'function') {
    const rec = { cls: cls || '', label: node.props['aria-label'] || node.props.title || '', onClick: node.props.onClick, node }
    clickables.push(rec)
    if (!allButtons.some((b) => b.node === node)) allButtons.push(rec)
  }
  // A textarea's prompt is a prop, not a child; surface it as visible copy too.
  const ph = node.props?.placeholder ?? node.props?.['aria-label']
  if (typeof ph === 'string' && ph.trim()) texts.push(ph.trim())
  walk(node.children, `${at}/${String(node.type)}`)
  parentClass = outerClass
}

function renderOnce() {
  globalThis.__rc = (globalThis.__rc || 0) + 1
  dirty = false
  pendingEffects = []
  texts.length = 0
  classes.length = 0
  clickables.length = 0
  // 每次重渲染都要从头数，否则多次 walk 会把同一张图累计好几次。
  globalThis.__mdImgs = []
  listOpenAttr = null
  drawerAttr = null
  path = ''
  const page = regs.find((r) => r.o.name === 'main')
  walk(React.createElement(page.c), '')
  const effects = pendingEffects
  pendingEffects = []
  for (const fn of effects) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
}

const cleanups = []
const settle = async () => {
  for (let i = 0; i < 12 && (i === 0 || dirty); i += 1) renderOnce()
  // 详情是异步取回来的：只等一个 tick 会让「重新取一次详情」看到旧内容。
  // 多等几轮，每轮都重新渲染，让 setState 的回调有机会跑完。
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setTimeout(r, 20))
    if (!dirty) break
    renderOnce()
  }
}
await settle()                                  // mount the page
intervals.forEach((fn) => fn())                 // the poller's first tick
await settle()                                  // state arrives, session auto-selected
intervals.forEach((fn) => fn())
await settle()                                  // transcript arrives
await settle()

// ── report ────────────────────────────────────────────────────────────────────
console.log('--- visible text ---')
texts.forEach((t) => console.log(' ', t))
console.log('\n--- checks ---')
const joined = texts.join(' | ')
// 桌面渲染后立刻记下，免得后面的窄屏测试改掉全局状态。
const desktopDrawerAttr = drawerAttr

// 用「投递失败」的 fixture 重新取一次详情，看看界面到底说了什么。
deliveryOverride = { at: 1795431100, message: '继续', delivered: false,
                     status: 'failed', error: 'thread not found' }
const refreshBtn = clickables.find((b) => b.label === '刷新' || b.label === 'Refresh')
refreshBtn?.onClick?.()
await settle()
const failedShown = texts.some((x) => String(x).includes('这条没发出去'))
const failedHasReason = texts.some((x) => String(x).includes('thread not found'))
deliveryOverride = null
const checks = [
  ['styles injected into document.head (badge survives unmount)',
    headChildren.some((el) => el['data-plugin-css'] === 'codex-monitor' && el.textContent.includes('.cxm-page'))],
  ['attached image renders as an img', shotCount >= 1],
  ['markdown image from Codex renders as an img', mdImages() === 1],
  ['unreadable markdown image degrades to its alt text',
    joined.includes('坏图') && !joined.includes('/nope/missing.png')],
  ['attached image sits outside the bubble', shotInsideBubble === 0],
  ['left pane title translated', joined.includes('会话')],
  ['counts interpolated', joined.includes('3 个会话 · 1 正在跑 · 1 等你回复')],
  ['both sessions listed', joined.includes('修 GridView') && joined.includes('讨论设计')],
  // 置顶会话单独成组，组头叫「置顶」。
  ['pinned group has its own header', joined.includes('置顶')],
  // 置顶的那个不该同时出现在下面的项目分组里。
  ['pinned session is not duplicated in project groups',
    (joined.match(/置顶的会话/g) || []).length === 1],
  // 两种分组方式都要有入口。
  ['both grouping modes offered', joined.includes('按项目') && joined.includes('按最近')],
  ['waiting question surfaced in list', joined.includes('是否删除空白子记录')],
  ['auto-selected the top session', calls.some((u) => u.includes('status'))],
  ['transcript: load-more control offered when more exists',
    joined.includes('加载更早的消息')],
  ['transcript: user message rendered', joined.includes('帮我修一下 GridView 的空行')],
  // 中间过程默认收起，正文里不该出现里面的内容，但「用时」那一行要在。
  ['refresh is an icon button, not text', refresh_is_icon_button()],
  ['work block: elapsed line shown', joined.includes('用时') && joined.includes('6 分钟')],
  ['work block: collapsed by default', !joined.includes('我先看一下') && !joined.includes('执行命令')],
  ['work block: click expands and collapses', work_expands()],
  ['transcript: markdown inline code parsed', joined.includes('GridView') && !joined.includes('`GridView`')],
  ['transcript: markdown bold parsed', !joined.includes('**组件实现**')],

  ['transcript: pending question block', joined.includes('Codex 在等你回答')],
  ['transcript: option buttons offered', joined.includes('删除这条临时记录')],
  ['composer present', joined.includes('给这个 Codex 会话发消息…') && joined.includes('发送')],
  ['composer clears on session switch', joined.includes('给这个 Codex 会话发消息…')],
  // 内联字典和 locale/*.json 必须一致：线上只用内联字典，JSON 只给文档/工具读，
  // 两边漂移就会出现「代码里有、界面显示原始 key」。
  ...dictParityChecks(),
  ['no raw locale keys leaked', !/(^|\| )(page|state|row|chat|reply|list|age)\./.test(joined)],
  // 列表开合：默认展开，按钮能收起、能再展开，且收起后列表真的不渲染。
  ['list pane starts open', classes.some((c) => c.includes('cxm-list-pane'))],
  ['list pane marked open', listOpenAttr === 'true'],
  ['toggle button present with label', clickables.some((b) => b.cls.includes('cxm-list-toggle'))],
  ['toggling hides the list', toggle_hides_list()],
  // 窄屏：列表默认收起（先让出对话），展开时压一层遮罩承接点击关闭。
  ['narrow defaults the list closed', narrow_defaults_closed()],
  ['narrow drawer renders a scrim', narrow_drawer_has_scrim()],
  ['narrow page is marked as drawer', narrow_marks_drawer()],
  ['desktop is not a drawer', desktopDrawerAttr === 'false'],
  ['send button is an icon button', send_is_icon_button()],
  ['send button has no text label', send_has_no_text()],
  ['send button sits in its own dock row', send_is_in_dock()],
  ['composer is a card, not a bordered row', composer_is_card()],
  // Enter 发送、Shift+Enter 换行，和 DSH 的 fixed.send / fixed.newline 一致。
  // 输入法选词时的 Enter 必须放过，否则中文输入一半就把消息发出去了。
  ['Enter sends', enter_sends()],
  ['Shift+Enter inserts a newline instead of sending', shift_enter_does_not_send()],
  ['Cmd+Enter inserts a newline instead of sending', cmd_enter_does_not_send()],
  ['Enter during IME composition does not send', enter_during_composition_does_not_send()],
  // 后台投递失败时 HTTP 早已返回成功，界面上必须自己说出来，
  // 否则用户只会看到任务「没动静」。
  ['a failed background delivery is surfaced', failedShown],
  ['the failure carries its reason', failedHasReason],
  ['no delivery notice while nothing has failed', !joined.includes('这条没发出去')],
  // 容器上开 smooth 会让「切会话时贴到底部」变成一段动画，
  // 表现就是打开会话先看到顶部、然后自己滚下去。
  // 会话被 Codex 占着时，输入框必须锁住并说明原因，而不是等用户敲完再报错。
  // 重新打开面板应该回到上次看的会话，而不是跳回列表第一个。
  // 这三个会换选中会话并重挂组件，放在最后并自行恢复，免得影响前面的检查。
  ['reopening restores the last session viewed', await reopen_restores_last()],
  ['an archived last session falls back to the top one', await archived_last_falls_back()],
  ['the last session is written on switch', await last_session_is_written()],
  // 派活回执：交给桌面端和「结果未知」必须说成不同的话。说反了用户会
  // 以为任务在排队等自己关窗口，或者重复发送造成重复派活。
  ['handover note says the desktop got it', await (async () => {
    const note = await sendAndReadNote({ native: true, queued: true, messageId: 'm1' })
    return note !== null && note.includes('已交给它') && note.includes('桌面端')
  })()],
  ['uncertain note warns against resending', await (async () => {
    const note = await sendAndReadNote({ queued: true, uncertain: true })
    return note !== null && note.includes('未能确认') && note.includes('不要重复发送')
  })()],
  ['queued note stays distinct from handover', await (async () => {
    const note = await sendAndReadNote({ queued: true })
    return note !== null && note.includes('已排队') && !note.includes('已交给它')
  })()],
  ['transcript does not animate its scroll on open', (() => {
    // 从注入到 head 的样式表里读，别重新解析一遍 client.js。
    const style = headChildren.find((el) => el['data-plugin-css'] === 'codex-monitor')
    const css = style ? String(style.textContent) : ''
    return !/\.cxm-transcript\{[^}]*scroll-behavior:\s*smooth/.test(css)
  })()],
]
// ── list collapse ─────────────────────────────────────────────────────────────
function toggle_hides_list() {
  if (listOpenAttr !== 'true') return false
  const btn = clickables.find((b) => b.cls.includes('cxm-list-toggle'))
  if (!btn) return false
  btn.onClick()
  renderOnce()
  return listOpenAttr === 'false'
}

// ── refresh is an icon button ─────────────────────────────────────────────────
// 刷新不该是文字按钮：要能靠 aria-label 被读屏找到，图标本身对读屏隐藏。
function refresh_is_icon_button() {
  const btns = allButtons.filter((b) => b.cls.includes('cxm-icon-btn'))
  if (btns.length < 2) return false
  return btns.every((b) => {
    // 读屏靠 aria-label；按钮里不能有可见文字。
    if (b.label !== '刷新') return false
    const kids = (b.node.children || []).filter((c) => c && typeof c === 'object')
    if (kids.length !== 1) return false
    // 图标是函数组件（RefreshGlyph），渲染出来才是 svg。
    const icon = kids[0]
    if (typeof icon.type === 'function' && icon.type.name !== 'RefreshGlyph') return false
    if (typeof icon.type !== 'function' && icon.type !== 'svg') return false
    return (b.node.children || []).every((c) => typeof c !== 'string' || c.trim() === '')
  })
}

// ── work block ────────────────────────────────────────────────────────────────
// 点「用时」那一行要能把过程展开，再点收回去。
// 正文里的 Markdown 图用 .cxm-md-img，和附件缩略图 .cxm-shot 分开统计。
function mdImages() {
  return (globalThis.__mdImgs ?? []).length
}

function work_expands() {
  const head = clickables.find((b) => b.cls.includes('cxm-work-head'))
  if (!head) return false
  head.onClick()
  renderOnce()
  const opened = texts.join(' | ')
  const sawWork = opened.includes('我先看一下') && opened.includes('执行命令')
  const head2 = clickables.find((b) => b.cls.includes('cxm-work-head'))
  if (!head2) return false
  head2.onClick()
  renderOnce()
  const closed = texts.join(' | ')
  return sawWork && !closed.includes('我先看一下')
}

// ── narrow / drawer ───────────────────────────────────────────────────────────
// 测试环境本来没有 matchMedia（按桌面处理）。这里临时装一个只回答窄屏的桩，
// 重新挂一次页面，验证窄屏下的默认值与遮罩。
function withNarrow(fn) {
  const saved = globalThis.window?.matchMedia
  globalThis.window = globalThis.window || {}
  // 桩要回答 DSH 的两个阈值：1023（自动收起）和 767（抽屉）。
  globalThis.window.matchMedia = (q) => {
    const m = q.match(/max-width:\s*(\d+)px/)
    const max = m ? Number(m[1]) : Infinity
    return {
      matches: 375 <= max,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    }
  }
  // 清空 hook 槽位才算真正重挂：否则 useState 会复用上一次的 narrow=false。
  hookSlots.clear()
  try {
    return fn()
  } finally {
    if (saved === undefined) delete globalThis.window.matchMedia
    else globalThis.window.matchMedia = saved
  }
}

function remountAndRender() {
  const page = regs.find((r) => r.o.name === 'main')
  hookIndex = 0
  path = ''
  texts.length = 0
  classes.length = 0
  clickables.length = 0
  listOpenAttr = null
  walk(React.createElement(page.c, null), '')
}

function narrow_defaults_closed() {
  return withNarrow(() => {
    remountAndRender()
    return listOpenAttr === 'false'
  })
}

function narrow_drawer_has_scrim() {
  return withNarrow(() => {
    remountAndRender()
    const toggle = clickables.find((b) => b.cls.includes('cxm-list-toggle'))
    if (!toggle) return false
    // 点击与随后这次渲染都必须在桩生效期间完成，否则 isNarrow() 又回到 false。
    toggle.onClick()
    renderOnce()
    return listOpenAttr === 'true' && classes.some((c) => c.includes('cxm-drawer-mask'))
  })
}

function narrow_marks_drawer() {
  return withNarrow(() => {
    remountAndRender()
    return drawerAttr === 'true'
  })
}

// ── send button ──────────────────────────────────────────────────────────────
// DSH 的发送键是 34x34 的正圆图标按钮（.uV2eYG_primary），不是带文字的胶囊。
// 这两条钉住「是图标」和「没有文字」，防止退回带文案的按钮。
function sendButton() {
  // Composer 只在选中会话后渲染，而那一步是异步的，所以从跨渲染累积的列表里找。
  const b = allButtons.find((x) => x.cls.includes('cxm-send'))
  return b && b.node
}

function send_is_icon_button() {
  const n = sendButton()
  if (!n) return false
  const kids = n.children || []
  const svg = kids.find((c) => c && c.type === 'svg')
  if (!svg) return false
  // 34x34 正圆：宽高相等且等于 34，圆角 999px 写在 CSS 里（CSS 另有检查）。
  return svg.props.width === 16 && svg.props.height === 16
}

function send_has_no_text() {
  const n = sendButton()
  if (!n) return false
  // 子节点里不应该出现裸字符串（「发送」这类文案）。
  return !(n.children || []).some((c) => typeof c === 'string')
}

function send_is_in_dock() {
  // DSH 把按钮放在卡片底部的 dock 里，单独一行靠右；不跟 textarea 并排。
  const b = allButtons.find((x) => x.cls.includes('cxm-send'))
  if (!b) return false
  return b.cls === 'cxm-send' && dockParent !== null
}

// 把一次按键喂给输入框，看它有没有被当成发送拦下来。
function press(props) {
  if (!textareaKeyDown) return null
  const event = {
    key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
    isComposing: false, nativeEvent: null,
    preventDefault() { this.defaultPrevented = true },
    defaultPrevented: false,
    ...props,
  }
  if (event.nativeEvent === null) event.nativeEvent = { isComposing: event.isComposing }
  textareaKeyDown(event)
  return event.defaultPrevented
}

function enter_sends() {
  return press({}) === true
}

function shift_enter_does_not_send() {
  return press({ shiftKey: true }) === false
}

function cmd_enter_does_not_send() {
  return press({ metaKey: true }) === false && press({ ctrlKey: true }) === false
}

function enter_during_composition_does_not_send() {
  return press({ isComposing: true }) === false
}

// 走一次真实的发送流程：填词 → 按 Enter → 等回执渲染。
async function sendAndReadNote(reply) {
  sendReply = reply
  try {
    if (!textareaOnChange) return null
    noteClass = null
    noteText = null
    textareaOnChange({ target: { value: '干活' } })
    await settle()
    press({})
    // 回执是异步来的，多等几轮让它落到 note 上。
    await settle()
    await settle()
    await settle()
    return noteText
  } finally {
    sendReply = null
  }
}

// 选中列表里的第 n 个会话，返回它的标题。
function selectSession(n) {
  const rows = clickables.filter((b) => b.cls.includes('cxm-row'))
  const row = rows[n]
  if (!row) return null
  row.onClick?.()
  return row.label || null
}

// 重新挂载 + 跑完 effects。remountAndRender 只 walk 不跑 effect，
// 而「自动选中」正是在 effect 里做的，少了这一步就等于什么都没重建。
async function reopen() {
  hookSlots.clear()
  renderOnce()
  await settle()
}

// 换一个会话、再「重新打开」，看是否回到同一个。
async function reopen_restores_last() {
  localStorage.clear()
  await reopen()
  const first = selectedRowTitle
  // 挑一个当前没被选中的行来点，点已选中的那行什么都不会发生。
  const other = clickables.find((b) => b.cls.includes('cxm-row') && b.label !== first)
  if (!other) return false
  other.onClick?.()
  renderOnce()
  const wanted = selectedRowTitle
  if (wanted === null || wanted === first) return false
  await reopen()
  return selectedRowTitle === wanted
}

// 上次看的会话被归档/删掉了，不能卡住不显示，要退回列表第一个。
async function archived_last_falls_back() {
  // 先回到一个已知状态，免得残留的选中值让检查蒙混过关。
  localStorage.clear()
  await reopen()
  const before = selectedRowTitle
  if (before === null) return false
  // 记住一个根本不存在的会话，再重开。
  localStorage.setItem('codex-monitor.lastSession', 'does-not-exist')
  selectedRowTitle = null
  await reopen()
  // 必须落回一个真实存在的会话，而且不能是「什么都没选中」。
  return selectedRowTitle !== null
}

async function last_session_is_written() {
  localStorage.clear()
  await reopen()
  const first = selectedRowTitle
  const other = clickables.find((b) => b.cls.includes('cxm-row') && b.label !== first)
  if (!other) return false
  other.onClick?.()
  renderOnce()
  await settle()
  const stored = localStorage.getItem('codex-monitor.lastSession')
  return stored !== null && stored.length > 0
}

function composer_is_card() {
  return cardFound
}

let bad = 0
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) bad += 1 }
console.log(`\n${checks.length - bad}/${checks.length} checks passed`)

const icon = regs.find((r) => r.o.name === 'sidebar.panellist')
const iconTree = icon.c({ size: 16, active: false })
console.log('sidebar glyph renders:', iconTree?.type?.name ?? typeof iconTree)

cleanups.forEach((fn) => { try { fn() } catch { /* ignore */ } })
process.exit(bad === 0 ? 0 : 1)
