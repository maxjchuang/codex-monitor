/**
 * Host half of codex-monitor.
 *
 * Owns ONE long-lived `codex_ctl.py serve` child and proxies the Web client's requests
 * to it.
 *
 * Why a resident child instead of one process per request: an app-server dies with the
 * process that spawned it, and Codex marks the in-flight turn `interrupted` on the way
 * out. Spawning per request therefore killed every dispatched turn within ~100ms, so the
 * work never ran. The resident child keeps one app-server alive across requests.
 *
 * All Codex logic lives in codex_ctl.py, so the CLI and the UI cannot disagree.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'codex_ctl.py')

const STATE_ROUTE = '/codex-monitor/state'
const STATUS_ROUTE = '/codex-monitor/status'
const SEND_ROUTE = '/codex-monitor/send'
const PING_ROUTE = '/codex-monitor/ping'

const CALL_TIMEOUT_MS = 120_000
const READY_TIMEOUT_MS = 30_000

/** Candidate interpreters, in preference order; the first that answers --version wins. */
function probe(bin) {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, ['--version'], { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

async function detectPython() {
  if (process.env.CODEX_MONITOR_PYTHON) return process.env.CODEX_MONITOR_PYTHON
  for (const bin of ['python3', '/opt/homebrew/bin/python3', '/usr/bin/python3']) {
    if (await probe(bin)) return bin
  }
  return null
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('malformed JSON body')
  }
}

export function apply(ctx) {
  /** The resident serve child, started on first use and restarted after a crash. */
  let child = null
  let port = null
  let starting = null
  let lastError = null

  const stop = () => {
    if (child !== null) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    child = null
    port = null
    starting = null
  }

  /** Start the resident server (idempotent) and resolve with its port. */
  const ensureServer = () => {
    if (port !== null && child !== null && child.exitCode === null) return Promise.resolve(port)
    if (starting !== null) return starting
    starting = (async () => {
      const bin = await detectPython()
      if (!bin) throw Object.assign(new Error('python3 not found'), { missingPython: true })

      const proc = spawn(bin, [SCRIPT, 'serve'], {
        cwd: HERE,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
      child = proc
      port = null
      lastError = null

      const ready = await new Promise((resolve, reject) => {
        let out = ''
        const timer = setTimeout(() => {
          reject(new Error('codex_ctl.py serve did not become ready'))
        }, READY_TIMEOUT_MS)
        const settle = (fn, value) => {
          clearTimeout(timer)
          fn(value)
        }
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (chunk) => {
          out += chunk
          const line = out.split('\n').find((l) => l.trim().startsWith('{'))
          if (!line) return
          try {
            const parsed = JSON.parse(line)
            if (parsed.ready === true) settle(resolve, parsed.port)
          } catch {
            /* keep buffering */
          }
        })
        proc.stderr.setEncoding('utf8')
        proc.stderr.on('data', (chunk) => {
          lastError = String(chunk).trim().slice(0, 500) || lastError
        })
        proc.on('error', (error) => settle(reject, error))
        proc.on('exit', (code) => {
          // A resident child exiting is fatal for every in-flight request.
          if (port === null) {
            settle(reject, new Error(lastError ?? `codex_ctl.py serve exited with ${code}`))
          }
        })
      })

      port = ready
      proc.on('exit', () => {
        if (child === proc) stop()
      })
      starting = null
      return ready
    })().catch((error) => {
      stop()
      throw error
    })
    return starting
  }

  /** POST to the resident server and return its parsed JSON. */
  const call = async (path, body) => {
    const target = await ensureServer()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
    try {
      // Plain loopback fetch: this runs in the host, not the browser shell, so the
      // client transport carrier does not apply here.
      const response = await fetch(`http://127.0.0.1:${target}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      })
      const payload = await response.json()
      if (!payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload.data
    } finally {
      clearTimeout(timer)
    }
  }

  ctx.effect(() => stop, 'codex-monitor: server')

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: PING_ROUTE,
      handler: async (req, res) => {
        try {
          const target = await ensureServer()
          sendJson(res, 200, { ok: true, python: await detectPython(), port: target })
        } catch (error) {
          sendJson(res, error?.missingPython ? 503 : 500, {
            ok: false,
            error: String(error?.message ?? error),
          })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const limit = Number(url.searchParams.get('limit') ?? 12) || 12
          const data = await call('/codex-monitor/state', { limit })
          sendJson(res, 200, { ok: true, data })
        } catch (error) {
          sendJson(res, error?.missingPython ? 503 : 500, {
            ok: false,
            error: String(error?.message ?? error),
          })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          if (!body.threadId) {
            sendJson(res, 400, { ok: false, error: 'threadId required' })
            return
          }
          const data = await call('/codex-monitor/status', {
            threadId: body.threadId,
            items: Number(body.items ?? 8),
          })
          sendJson(res, 200, { ok: true, data })
        } catch (error) {
          sendJson(res, error?.missingPython ? 503 : 500, {
            ok: false,
            error: String(error?.message ?? error),
          })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: SEND_ROUTE,
      handler: async (req, res) => {
        try {
          const body = await readBody(req)
          const message = String(body.message ?? '').trim()
          if (!body.threadId || !message) {
            sendJson(res, 400, { ok: false, error: 'threadId and message required' })
            return
          }
          await call('/codex-monitor/send', { threadId: body.threadId, message })
          sendJson(res, 200, { ok: true, delivered: true })
        } catch (error) {
          sendJson(res, error?.missingPython ? 503 : 500, {
            ok: false,
            error: String(error?.message ?? error),
          })
        }
      },
    }),
  )
}

export const inject = ['webServer']
