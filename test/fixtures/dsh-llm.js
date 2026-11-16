/**
 * Fixture mirroring the `@deepseek-ai/dsh-llm` surface this plugin imports.
 *
 * The Host resolves the real package at runtime; tests run without a Host, so
 * this fixture reproduces only the contracts the plugin has to satisfy. Keep it
 * in step with `dsh-llm`'s `LlmAdapter` default methods and `LlmError`'s
 * validation, or the tests will pass against a contract the Host does not have.
 *
 * @module test/fixtures/dsh-llm
 */

/** Same shape as the real base class: only `stream` is abstract. */
export class LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  providerRetryPolicy(_provider) {
    return undefined
  }

  imageRequestPricing(_provider, _model) {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  listModels(_provider) {
    return Promise.resolve([])
  }

  resolveModel(provider, model, _signal) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) }
  }

  stream(_options) {
    throw new Error('stream() must be implemented')
  }
}

/** Mirrors the real error's constructor validation and `code`/`status` fields. */
export class LlmError extends Error {
  constructor(message, code, options = {}) {
    super(message)
    if (typeof code !== 'string' || code === '') throw new TypeError('LlmError needs a non-empty code')
    this.name = 'LlmError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.providerRetryAfterMs !== undefined) this.providerRetryAfterMs = options.providerRetryAfterMs
  }
}

/** Mirrors the real helper: fills the normal-policy defaults and freezes. */
export function resolveRetryPolicy(config, path = 'retryPolicy') {
  const policy = config ?? {}
  const mode = policy.mode ?? 'normal'
  if (mode === 'normal') {
    const maxRetries = policy.maxRetries ?? 2
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
    }
    const retryableCodes = policy.retryableCodes ?? ['TRANSPORT', 'RATE_LIMIT']
    if (retryableCodes.length === 0) throw new Error(`${path}.retryableCodes must not be empty`)
    if (new Set(retryableCodes).size !== retryableCodes.length) {
      throw new Error(`${path}.retryableCodes must not contain duplicates`)
    }
    return Object.freeze({
      mode,
      maxRetries,
      retryableCodes: Object.freeze([...retryableCodes]),
      initialDelayMs: policy.initialDelayMs ?? 500,
      maxDelayMs: policy.maxDelayMs ?? 10_000,
      jitterRatio: policy.jitterRatio ?? 0.1,
    })
  }
  if (mode === 'always') {
    return Object.freeze({
      mode,
      retryableCodes: Object.freeze([...(policy.retryableCodes ?? [])]),
      initialDelayMs: policy.initialDelayMs ?? 500,
      maxDelayMs: policy.maxDelayMs ?? 10_000,
      jitterRatio: policy.jitterRatio ?? 0.1,
    })
  }
  throw new Error(`${path}: unknown retry mode "${String(mode)}"`)
}

/** RFC 9110 product-token shape, matching the real helper. */
export function userAgent(identity) {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

/** The real helper returns exactly one header. */
export function attributionHeaders(identity) {
  return { 'user-agent': userAgent(identity) }
}
