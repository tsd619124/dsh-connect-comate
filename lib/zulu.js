/**
 * Supervision of the `zulu serve` HTTP/SSE endpoint.
 *
 * Comate exposes no OpenAI-compatible chat endpoint anywhere on its public
 * hosts (probed: `/v1/chat/completions`, `/api/v1/chat/completions`,
 * `/api/openai/v1/chat/completions` all 405; `/api/autowork/v1/chat/completions`
 * 403). The one supported programmatic surface is the `zulu serve` subcommand,
 * which streams a turn as Server-Sent Events. This module owns that process:
 * port selection, spawn, health gating, credential wiring, and shutdown.
 *
 * Two behaviours of the real `serve` shape this code and are worth naming:
 *
 * - `applyServeAuthEnv()` deletes `ZULU_SERVE_*` from the environment and then
 *   re-derives them from `--license` / `--ptoken` / `--username`. Session
 *   auth therefore cannot be enabled through the environment; it must be a CLI
 *   argument, and the three are mutually exclusive.
 * - `--port 0` is echoed back verbatim while the process binds an ephemeral
 *   port, and the pid file records the same `0`. The advertised port is
 *   useless, so this module picks a concrete free port before spawning rather
 *   than letting the kernel choose one it cannot report.
 *
 * @module dsh-connect-comate/zulu
 */

import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Lowest and highest port this module will try to claim. */
const PORT_MIN = 18810
const PORT_MAX = 18899

/** How long one readiness probe may take. */
const HEALTH_TIMEOUT_MS = 1500

/** How long to wait for the `{"success":true,...}` banner line. */
const BANNER_TIMEOUT_MS = 30_000

/** The pid file `zulu serve` maintains, relative to the Comate home. */
const PID_FILE = join(homedir(), '.comate', 'zulu-serve.pid')

/**
 * Ask the kernel for a free loopback port in the range this module owns.
 *
 * @returns a port number that was free at probe time.
 */
async function pickPort() {
  for (let port = PORT_MIN; port <= PORT_MAX; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port, '127.0.0.1')
    })
    if (free) return port
  }
  throw new Error(`no free loopback port in ${String(PORT_MIN)}-${String(PORT_MAX)}`)
}

/**
 * Probe one `zulu serve` instance's health endpoint.
 *
 * @param port - loopback port to probe.
 * @param signal - optional cancellation.
 * @returns `true` when the process answers `{"status":"ok"}`.
 */
export async function checkHealth(port, signal) {
  const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS)
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: composed })
    if (!response.ok) return false
    const payload = await response.json()
    return payload?.status === 'ok'
  } catch {
    return false
  }
}

/**
 * Read the pid file `zulu serve` writes, tolerating every malformed shape.
 *
 * @returns the parsed record, or `undefined`.
 */
function readPidFile() {
  try {
    const parsed = JSON.parse(readFileSync(PID_FILE, 'utf8'))
    return typeof parsed?.pid === 'number' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a pid names a live process.
 *
 * @param pid - process id.
 * @returns `true` when signalling it succeeds or is denied (both mean alive).
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * The credential argument the server was started with, and its CLI flag.
 *
 * @param credential - from `readCredential()`.
 * @returns the flag and its value.
 */
function authFlag(credential) {
  return credential.kind === 'license'
    ? { flag: '--license', field: 'license', value: credential.value }
    : { flag: '--ptoken', field: 'ptoken', value: credential.value }
}

/**
 * The environment `zulu serve` needs to talk to the right Comate deployment.
 *
 * Left to itself the CLI defaults to the *internal* deployment
 * (`platform = process.env.PLATFORM || PLATFORM.INTERNAL` in the bundle), so a
 * public-cloud account gets "您当前会话执行遇到了异常，请检测网络后重试！" on
 * every single turn while the credential check and the model roster both
 * succeed — they use a different code path that reads the licence directly.
 *
 * The enum values are lowercase (`saas` / `internal` / `poc`), not the uppercase
 * `platform` field the login file stores, so the conversion is explicit rather
 * than passing the stored value through.
 *
 * @param credential - from `readCredential()`.
 * @returns environment overrides to apply on top of `process.env`.
 */
export function platformEnv(credential) {
  const stored = typeof credential?.platform === 'string' ? credential.platform.toUpperCase() : ''
  if (stored === 'SAAS') return { PLATFORM: 'saas' }
  if (stored === 'INTERNAL') return { PLATFORM: 'internal' }
  if (stored === 'POC') return { PLATFORM: 'poc' }
  // An unknown platform is the one case where guessing is worse than failing
  // loudly: let the CLI keep its own default and surface its error verbatim.
  return {}
}

/**
 * One supervised `zulu serve` process.
 *
 * `start()` is idempotent per instance and rejects with a readable diagnostic
 * when the CLI cannot be launched; `stop()` is safe to call repeatedly and
 * awaits real process exit so a restart cannot race the old listener.
 */
export class ZuluServer {
  #child
  #port
  #starting
  #stopping
  #log
  #zuluBin
  #credential
  #stderrTail = ''

  /**
   * @param options - the launcher path, credential, and a log sink.
   */
  constructor(options) {
    this.#zuluBin = options.zuluBin
    this.#credential = options.credential
    this.#log = options.log ?? (() => {})
  }

  /** The loopback port this instance serves on, when started. */
  get port() {
    return this.#port
  }

  /** The credential handed to the child, as a CLI flag pair. */
  get auth() {
    return authFlag(this.#credential)
  }

  /** Whether the child was started under a licence or an internal token. */
  get authKind() {
    return this.#credential.kind
  }

  /**
   * Whether the credential this instance was built with still matches disk.
   *
   * @param credential - a freshly read credential.
   * @returns `true` when a running child would still be authorised.
   */
  matches(credential) {
    return credential !== undefined
      && credential.kind === this.#credential.kind
      && credential.value === this.#credential.value
  }

  /**
   * Start the server, or resolve immediately when it is already healthy.
   *
   * The reuse path re-reads the pid file first: an instance another plugin run
   * left behind is adopted only when its health endpoint answers and the
   * credential kind matches, because the serve auth mode is fixed at spawn.
   *
   * @param signal - optional cancellation for the startup wait.
   * @returns the loopback port.
   */
  async start(signal) {
    if (this.#port !== undefined && await checkHealth(this.#port, signal)) return this.#port
    if (this.#starting !== undefined) return this.#starting

    this.#starting = this.#startUncached(signal)
    try {
      this.#port = await this.#starting
      return this.#port
    } finally {
      this.#starting = undefined
    }
  }

  /**
   * The real start path behind {@link start}'s memoisation.
   *
   * @param signal - optional cancellation.
   * @returns the loopback port.
   */
  async #startUncached(signal) {
    const adopted = await this.#adoptExisting(signal)
    if (adopted !== undefined) return adopted

    const port = await pickPort()
    const { flag, value } = authFlag(this.#credential)
    this.#log(`starting zulu serve on 127.0.0.1:${String(port)} (auth: ${this.#credential.kind})`)

    const child = spawn(this.#zuluBin, ['serve', '--port', String(port), flag, value], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', ...platformEnv(this.#credential) },
    })
    this.#child = child
    this.#stderrTail = ''

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      this.#stderrTail = (this.#stderrTail + String(chunk)).slice(-4000)
      this.#log(`zulu serve stderr: ${String(chunk).trimEnd()}`)
    })
    child.once('exit', (code, exitSignal) => {
      this.#log(`zulu serve exited (code=${String(code)} signal=${String(exitSignal)})`)
      if (this.#child === child) {
        this.#child = undefined
        this.#port = undefined
      }
    })

    const banner = await this.#awaitBanner(child, signal)
    if (banner === undefined) {
      const tail = this.#stderrTail.trim()
      this.stop()
      throw new Error(
        `zulu serve did not report readiness on port ${String(port)}`
        + (tail === '' ? '' : `: ${tail}`),
      )
    }

    if (!await this.#awaitHealth(port, signal)) {
      this.stop()
      throw new Error(`zulu serve reported port ${String(port)} but /health never answered`)
    }
    return port
  }

  /**
   * Adopt a `zulu serve` another run left listening, when it still works.
   *
   * @param signal - optional cancellation.
   * @returns the adopted port, or `undefined` to spawn a fresh process.
   */
  async #adoptExisting(signal) {
    const record = readPidFile()
    if (record === undefined) return undefined
    if (record.port === 0 || typeof record.port !== 'number') {
      // `--port 0` records the request, not the binding; nothing to probe.
      return undefined
    }
    if (!isAlive(record.pid)) return undefined
    if (record.authMode !== this.#credential.kind) return undefined
    if (!await checkHealth(record.port, signal)) return undefined
    this.#log(`adopted an existing zulu serve on 127.0.0.1:${String(record.port)}`)
    return record.port
  }

  /**
   * Wait for the one-line `{"success":true,...}` banner the CLI prints first.
   *
   * @param child - the spawned process.
   * @param signal - optional cancellation.
   * @returns the parsed banner, or `undefined` on timeout or early exit.
   */
  async #awaitBanner(child, signal) {
    const stdout = child.stdout
    if (stdout === null) return undefined
    stdout.setEncoding('utf8')

    return await new Promise((resolve) => {
      let buffer = ''
      const timer = setTimeout(() => {
        cleanup()
        resolve(undefined)
      }, BANNER_TIMEOUT_MS)
      const onData = (chunk) => {
        buffer += String(chunk)
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        try {
          const parsed = JSON.parse(line)
          if (parsed?.success === true) {
            cleanup()
            resolve(parsed)
            return
          }
        } catch {
          // Diagnostics printed before the banner; keep waiting.
        }
        buffer = buffer.slice(newline + 1)
      }
      const onExit = () => {
        cleanup()
        resolve(undefined)
      }
      const onAbort = () => {
        cleanup()
        resolve(undefined)
      }
      const cleanup = () => {
        clearTimeout(timer)
        stdout.off('data', onData)
        child.off('exit', onExit)
        signal?.removeEventListener('abort', onAbort)
      }
      stdout.on('data', onData)
      child.once('exit', onExit)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Poll `/health` until it answers or the readiness budget runs out.
   *
   * @param port - port to probe.
   * @param signal - optional cancellation.
   * @returns `true` when the server became healthy.
   */
  async #awaitHealth(port, signal) {
    const deadline = Date.now() + BANNER_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (signal?.aborted === true) return false
      if (await checkHealth(port, signal)) return true
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return false
  }

  /**
   * Terminate the child, waiting for real exit.
   *
   * @returns a promise that settles once the process is gone.
   */
  async stop() {
    const child = this.#child
    this.#child = undefined
    this.#port = undefined
    if (child === undefined || child.exitCode !== null) return
    if (this.#stopping !== undefined) return await this.#stopping

    this.#stopping = new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        resolve()
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    try {
      await this.#stopping
    } finally {
      this.#stopping = undefined
    }
  }

  /**
   * Remove a pid file this module owns, so a later `start()` cannot adopt us.
   *
   * Only called when the recorded pid belongs to a process this module spawned
   * and that process is gone; a live foreign server is never touched.
   */
  static clearStalePidFile() {
    const record = readPidFile()
    if (record !== undefined && isAlive(record.pid)) return
    try {
      rmSync(PID_FILE, { force: true })
    } catch {
      // Not fatal: adoption also requires a passing health check.
    }
  }
}
