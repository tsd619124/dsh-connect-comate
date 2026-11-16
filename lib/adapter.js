/**
 * The `LlmAdapter` that puts Comate behind a DSH provider route.
 *
 * DSH's contract has one required method, `stream`, and everything else has a
 * default. This adapter overrides exactly the pieces where a default would be
 * wrong:
 *
 * - `providerInfo` names the route, because the default echoes the id back.
 * - `listModels` / `resolveModel` report the live Comate roster and the context
 *   window that roster advertises; the defaults return an empty catalog and no
 *   context, which would leave the picker empty.
 * - Both of those narrow the roster to the models the user ticked in the
 *   settings page, so the picker holds the two or three models someone actually
 *   drives rather than the fifteen the licence happens to include.
 * - `providerRetryPolicy` retries the codes that a local subprocess can
 *   legitimately produce (transport, timeouts, rate limits) and never retries a
 *   credential or quota failure, which a retry cannot fix.
 *
 * @module dsh-connect-comate/adapter
 */

import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { selectModels } from './catalog.js'
import { fetchModels } from './quota.js'
import { renderQuery } from './prompt.js'
import { cancelTurn, codeForFailure, runTurn } from './turn.js'

/** Default context window when the roster omits one. */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** Default completion budget, matching what the CLI requests. */
const DEFAULT_MAX_TOKENS = 8_192

/**
 * The Comate provider route implemented over `zulu serve`.
 */
export class ComateAdapter extends LlmAdapter {
  #options

  /**
   * @param options - display name, credential reader, and server supervisor.
   */
  constructor(options) {
    super()
    this.#options = options
  }

  /**
   * Report the route's display identity.
   *
   * @param provider - the provider id this adapter is registered for.
   * @returns the id plus a human-readable name.
   */
  providerInfo(provider) {
    // `displayName` is a getter, not a value: the settings card can rename the
    // provider mid-session, and the route's metadata must follow it.
    const name = typeof this.#options.displayName === 'function'
      ? this.#options.displayName()
      : this.#options.displayName
    return { id: provider, name: typeof name === 'string' && name !== '' ? name : provider }
  }

  /**
   * Retry only what a retry can plausibly fix.
   *
   * A licence rejection, a missing credential, or an exhausted quota is stable
   * across attempts, so retrying wastes the user's time and can burn a rate
   * budget. Transport and timeout failures are transient.
   *
   * The shape matters: DSH's retry policy is `{mode, maxRetries, retryableCodes,
   * initialDelayMs, maxDelayMs, jitterRatio}` and is consumed by the
   * `llm-retry` service, which reads `mode` to decide whether a retry limit
   * exists at all and multiplies `initialDelayMs` for the wait. A hand-rolled
   * `{maxAttempts}` silently means "unlimited retries, no backoff", so the
   * object is built through DSH's own resolver rather than typed out here.
   *
   * @returns the policy for this route.
   */
  providerRetryPolicy() {
    return resolveRetryPolicy({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'SERVER', 'STREAM_CLOSED'],
    }, 'dsh-connect-comate: provider "comate" retryPolicy')
  }

  /**
   * List the models the current licence can drive.
   *
   * @param provider - the registered provider id.
   * @returns the roster, always with at least `auto`.
   */
  async listModels(provider) {
    const credential = this.#options.readCredential()
    const roster = await fetchModels({
      credential,
      userAgent: this.#options.userAgent,
      zuluVersion: this.#options.zuluVersion,
    })
    const models = selectModels(roster, this.#options.enabledModelIds())
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
    }))
  }

  /**
   * Describe one model exactly, including the context budget DSH sizes against.
   *
   * @param provider - the registered provider id.
   * @param model - the model id from the roster.
   * @param signal - caller cancellation.
   * @returns the exact model record.
   */
  async resolveModel(provider, model, signal) {
    const credential = this.#options.readCredential()
    const roster = await fetchModels({
      credential,
      userAgent: this.#options.userAgent,
      zuluVersion: this.#options.zuluVersion,
      signal,
    })
    // A hidden model still resolves: an existing session can be sitting on one
    // the user unticked after the fact, and refusing to describe it would end
    // that conversation with a metadata error instead of letting it finish.
    const match = roster.find((entry) => entry.id === model)
    return {
      provider,
      id: model,
      name: match?.name ?? model,
      ...(match?.description === undefined ? {} : { description: match.description }),
      context: { contextWindow: match?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    }
  }

  /**
   * Stream one turn.
   *
   * The credential is re-read on every call rather than captured once, so a user
   * who signs in mid-session starts working without a restart, and a stale
   * server started under an older licence is replaced.
   *
   * @param options - the fully projected harness request.
   * @returns the chunk stream.
   */
  async *stream(options) {
    const credential = this.#options.readCredential()
    if (credential === undefined) {
      throw new LlmError(
        'Comate 未登录：先执行 `zulu login`，或设置 COMATE_LICENSE 环境变量',
        'MISSING_CREDENTIAL',
      )
    }

    const zuluBin = this.#options.resolveZuluBin()
    if (zuluBin === undefined) {
      throw new LlmError('没有找到 Comate CLI（zulu），请确认已安装 Comate', 'DISCOVERY_FAILED')
    }

    const server = await this.#options.serverFor(zuluBin, credential)
    const port = await server.start(options.signal)

    const workingDirectory = this.#options.resolveWorkingDirectory(options.sessionId)
    const conversationId = this.#options.newConversationId()
    const query = renderQuery({ messages: options.messages, system: options.system })

    const body = {
      conversationId,
      query,
      cwd: workingDirectory,
      model: options.model,
      mode: 'Agent',
      display: 'delta-stream',
      ...(credential.kind === 'license' ? { license: credential.value } : { ptoken: credential.value }),
    }

    this.#options.log(`comate turn → ${String(port)} model=${options.model} cwd=${workingDirectory}`)

    try {
      yield* runTurn({
        port,
        conversationId,
        body,
        signal: options.signal,
        log: this.#options.log,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '轮次已取消', code: 'ABORTED' } } }
        return
      }
      throw new LlmError(message, codeForFailure(message))
    } finally {
      if (options.signal?.aborted === true) void cancelTurn(port, conversationId)
    }
  }
}
