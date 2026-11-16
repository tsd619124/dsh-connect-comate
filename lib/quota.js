/**
 * The Comate HTTP surface: the model catalog and the credit readout.
 *
 * Comate publishes no OpenAI-compatible chat endpoint, but it does publish two
 * plain JSON endpoints the plugin can call directly:
 *
 * - `POST /api/v2/api/models/available` — the model roster for one license.
 * - `GET  /api/openapi/v3/agent/daily_cost?username=<license>` — today's credit
 *   usage, the same readout the IDE's own quota card draws.
 *
 * Both are anonymous-readable but answer `data: null` without a valid license,
 * so a caller that holds no credential gets an empty result rather than an
 * error. That distinction matters: "not signed in" is a state to report, not a
 * failure to throw.
 *
 * @module dsh-connect-comate/quota
 */

/** Public SaaS host; the internal edition uses `comate.baidu-int.com`. */
export const SAAS_API_HOST = 'https://comate.baidu.com'

/** Internal-edition host, reachable only on the Baidu intranet. */
export const INTERNAL_API_HOST = 'https://comate.baidu-int.com'

/** How long one catalog or quota response is reused. */
const CACHE_TTL_MS = 60_000

/** How long any single Comate HTTP call may take. */
const REQUEST_TIMEOUT_MS = 8000

/**
 * The `User-Agent` this plugin sends.
 *
 * The host requires every adapter request to carry an attribution header, and
 * that header must name *this* product: claiming to be `deepseek-harness` while
 * spending a Comate license would misattribute the traffic.
 *
 * @param version - plugin version from its own manifest.
 * @returns the RFC 9110 product string.
 */
export function userAgentFor(version) {
  return `comate-zulu/${version} (+https://comate.baidu.com)`
}

/**
 * A tiny time-based cache entry holder.
 *
 * @param ttlMs - how long a stored value stays fresh.
 * @returns `read` and `clear` over one slot.
 */
function slot(ttlMs = CACHE_TTL_MS) {
  let value
  let storedAt = 0
  return {
    read() {
      return Date.now() - storedAt < ttlMs ? value : undefined
    },
    write(next) {
      value = next
      storedAt = Date.now()
      return next
    },
    clear() {
      value = undefined
      storedAt = 0
    },
  }
}

/**
 * Perform one JSON request against a Comate host.
 *
 * @param url - absolute URL.
 * @param init - fetch options, already carrying the attribution header.
 * @param signal - caller cancellation.
 * @returns the parsed body, or `undefined` when the call failed.
 */
async function requestJson(url, init, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const response = await fetch(url, { ...init, signal: composed })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Resolve the API host for one credential's platform.
 *
 * @param platform - `SAAS`, `INTERNAL`, or anything else.
 * @returns the base URL to call.
 */
export function apiHostFor(platform) {
  return platform === 'INTERNAL' ? INTERNAL_API_HOST : SAAS_API_HOST
}

/** Cached model catalog, keyed by license so a re-login invalidates it. */
const catalogCache = new Map()

/**
 * Read the model roster Comate offers for one license.
 *
 * The roster is what the CLI itself reads (`zulu list-model` hits the same
 * route), so the picker shows exactly the models the licence can drive. A
 * failed call falls back to the single `auto` route, which every account can
 * use, rather than failing the whole provider.
 *
 * @param options - credential, plugin version, user agent, and cancellation.
 * @returns model entries, never empty.
 */
export async function fetchModels(options) {
  const { credential, signal } = options
  const host = apiHostFor(credential?.platform)
  const key = `${host}\u0000${credential?.value ?? ''}`
  const cached = catalogCache.get(key)?.read()
  if (cached !== undefined) return cached

  const fallback = [{ id: 'auto', name: 'Auto', description: '让 Comate 自行选择模型' }]
  if (credential === undefined) return fallback

  const body = {
    username: credential.value,
    type: 'ZULU',
    rootRepo: '',
    submodules: [],
    zuluVersion: options.zuluVersion ?? '1.8.1',
    source: 'cli',
    ideType: 'zulucli',
  }
  const payload = await requestJson(`${host}/api/v2/api/models/available`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': options.userAgent },
    body: JSON.stringify(body),
  }, signal)

  const raw = Array.isArray(payload?.data?.models) ? payload.data.models : []
  const models = raw
    .filter((model) => typeof model?.modelId === 'string' && model.modelId !== '')
    .map((model) => {
      // `maxContextWindow` is expressed in *thousands* of tokens, not tokens.
      // ERNIE 5.5 reports 1000 and describes itself as "1M context"; GLM-4.7
      // reports 200 for a 200K window. Multiplying is what makes DSH's
      // compaction trigger at the right place — passing 1024 through raw would
      // compact a conversation after ~1K tokens.
      const contextWindow = Number.isInteger(model.maxContextWindow) && model.maxContextWindow > 0
        ? model.maxContextWindow * 1000
        : undefined
      return {
        id: model.modelId,
        name: typeof model.displayName === 'string' && model.displayName !== '' ? model.displayName : model.modelId,
        ...(typeof model.modelDescription === 'string' && model.modelDescription !== ''
          ? { description: model.modelDescription }
          : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
      }
    })

  const resolved = models.length === 0 ? fallback : models
  const entry = catalogCache.get(key) ?? slot()
  catalogCache.set(key, entry)
  entry.write(resolved)
  return resolved
}

/** Cached credit readout, keyed by license. */
const quotaCache = new Map()

/**
 * Read today's credit usage for one license.
 *
 * `daily_cost` answers `{status:"OK", data:null}` for an unknown or absent
 * licence — that is a legitimate "no data", so it is reported as `available:
 * false` with the reason, never as an exception.
 *
 * @param options - credential, user agent, and cancellation.
 * @returns the normalized readout, or an `available:false` explanation.
 */
export async function fetchQuota(options) {
  const { credential, signal } = options
  if (credential === undefined) {
    return { available: false, reason: 'not-signed-in', detail: '未找到 Comate CLI 登录凭证，先执行一次 `zulu login`。' }
  }

  const host = apiHostFor(credential.platform)
  const key = `${host}\u0000${credential.value}`
  const cached = quotaCache.get(key)?.read()
  if (cached !== undefined) return cached

  const payload = await requestJson(
    `${host}/api/openapi/v3/agent/daily_cost?username=${encodeURIComponent(credential.value)}`,
    { headers: { 'user-agent': options.userAgent } },
    signal,
  )
  if (payload === undefined) {
    return { available: false, reason: 'unreachable', detail: 'Comate 积分接口没有响应。' }
  }
  if (payload.status !== 'OK') {
    return { available: false, reason: 'rejected', detail: typeof payload.message === 'string' ? payload.message : '积分接口拒绝了请求。' }
  }
  if (payload.data === null || payload.data === undefined) {
    return { available: false, reason: 'no-data', detail: '该 license 没有返回积分数据（未登录或接口降级）。' }
  }

  const used = numberOrUndefined(payload.data.used_quota)
  const monthLimit = numberOrUndefined(payload.data.month_quota_limit)
  const remaining = numberOrUndefined(payload.data.remaining_quota)
  const result = {
    available: true,
    usedQuota: used,
    monthQuotaLimit: monthLimit,
    remainingQuota: remaining,
    requestCount: numberOrUndefined(payload.data.request_count),
    unlimited: payload.data.is_unlimited === true,
    raw: payload.data,
  }
  const entry = quotaCache.get(key) ?? slot()
  quotaCache.set(key, entry)
  entry.write(result)
  return result
}

/**
 * Keep a numeric field only when the payload really carries a finite number.
 *
 * @param value - candidate.
 * @returns the number, or `undefined`.
 */
function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Drop every cached response, so the next read reflects a new license.
 */
export function invalidateComateCaches() {
  for (const entry of catalogCache.values()) entry.clear()
  for (const entry of quotaCache.values()) entry.clear()
}
