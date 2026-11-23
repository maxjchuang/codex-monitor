/**
 * Offline checks for the Markdown renderer embedded in client.js.
 *
 * The renderer lives inside the client bundle, so the test extracts that block and
 * evaluates it with a tiny createElement stand-in. That keeps the assertions on the
 * real code rather than on a copy that could drift.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'client.js'), 'utf8')
const lines = source.split('\n')

// Slice out the renderer: from its doc comment to the end of renderMarkdown.
const start = lines.findIndex((l) => l.includes('A small Markdown renderer for Codex transcripts')) - 1
const endMark = lines.findIndex((l) => l.includes('function renderMarkdown(text, h, keyPrefix'))
const end = lines.findIndex((l, i) => i > endMark && l.trim() === '}')
const block = lines.slice(start, end + 1).join('\n').replace(/^ {4}/gm, '')

const h = (type, props, ...children) =>
  props || children.length ? { type, props: props ?? {}, children: children.filter((c) => c != null) } : type
const renderMarkdown = new Function('h', `${block}\n;return renderMarkdown;`)(h)

/** Flatten a React-ish tree into readable text for assertions. */
function flat(node) {
  if (node == null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flat).join('')
  const kids = (node.children ?? []).map(flat).join('')
  const t = node.type
  if (t === 'code') return `[code:${kids}]`
  if (t === 'strong') return `**${kids}**`
  if (t === 'em') return `_${kids}_`
  if (t === 'del') return `~~${kids}~~`
  if (t === 'a') return `[${kids}](${node.props.href})`
  if (t === 'pre') return `\n[pre]${kids}[/pre]\n`
  if (t === 'th' || t === 'td') return `${kids} | `
  if (t === 'tr') return `\n| ${kids}`
  if (t === 'li') return `- ${kids}\n`
  return kids
}

const checks = []
const check = (name, ok) => checks.push([name, ok])

const inline = (s) => flat(renderMarkdown(s, h))

// ── inline ───────────────────────────────────────────────────────────────────
check('inline code', inline('已更新 `GridView` 组件。') === '已更新 [code:GridView] 组件。')
check('bold', inline('这里是**重点**内容。') === '这里是**重点**内容。')
check('italic', inline('这是*斜体*。') === '这是_斜体_。')
check('strikethrough', inline('~~废弃~~') === '~~废弃~~')
check('link keeps href', inline('看[打开 Demo](http://127.0.0.1:6211/x)。') === '看[打开 Demo](http://127.0.0.1:6211/x)。')
check('https link allowed', inline('[a](https://example.com)') === '[a](https://example.com)')

// Backticks must win over other markers.
check('code beats bold', inline('`**not bold**`') === '[code:**not bold**]')

// ── security ─────────────────────────────────────────────────────────────────
check('javascript: link is not clickable', !inline('[点我](javascript:alert(1))').includes('javascript:'))
check('data: link is not clickable', !inline('[x](data:text/html,<b>)').includes('data:'))
// Text is handed to React as text, so angle brackets must survive as characters.
const xss = inline('看 <script>alert(1)</script> 这里')
check('script tag stays literal text', xss.includes('<script>') && xss.includes('</script>'))

// ── blocks ───────────────────────────────────────────────────────────────────
check('unordered list', inline('- 第一项\n- 第二项') === '- 第一项\n- 第二项\n')
check('ordered list', inline('1. 甲\n2. 乙') === '- 甲\n- 乙\n')
check('heading', inline('## 结论\n正文').includes('结论') && inline('## 结论\n正文').includes('正文'))
check('fenced code keeps body', inline('```js\nconst a = 1 < 2;\n```').includes('const a = 1 < 2;'))
check('blockquote', inline('> 引用一句').includes('引用一句'))
check('hr', flat(renderMarkdown('---', h)) === '')
check('table cells', (() => {
  const out = inline('| 字段 | 值 |\n|---|---|\n| a | 1 |')
  return out.includes('字段') && out.includes('值') && out.includes(' a ') && out.includes(' 1 ')
})())

// ── plain text must pass through unchanged ───────────────────────────────────
const plain = '这是一段普通的话，没有标记。'
check('plain text unchanged', inline(plain) === plain)
check('multiline soft wrap', inline('第一行\n第二行') === '第一行 第二行')
check('empty input', inline('') === '')

// A stray marker must not swallow the rest of the message.
check('stray asterisk survives', inline('2 * 3 = 6').includes('2 * 3 = 6'))

// ── report ───────────────────────────────────────────────────────────────────
let bad = 0
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name)
  if (!ok) bad += 1
}
console.log(`\n${checks.length - bad}/${checks.length} markdown checks passed`)
process.exit(bad === 0 ? 0 : 1)
