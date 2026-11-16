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
 * - The same two methods declare what the model can *take* and how it can be
 *   *steered*: `inputModalities` says whether a picture is forwarded or
 *   projected to text, and `reasoning.efforts` says which thinking depths the
 *   picker may offer. Omitting them is not neutral — DSH treats a missing
 *   `inputModalities` as "unknown" and a missing `reasoning` as "no effort
 *   setting at all", which is how both settings came to be silently absent.
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
import { ConversationPlanner } from './history.js'
import { uploadImage } from './images.js'
import { renderQuery, renderTurn } from './prompt.js'
import { apiHostFor, fetchModels } from './quota.js'
import { cancelTurn, codeForFailure, runTurn } from './turn.js'

/** Default context window when the roster omits one. */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** Default completion budget, matching what the CLI requests. */
const DEFAULT_MAX_TOKENS = 8_192

/**
 * What one roster entry can accept, as DSH's modality list.
 *
 * The distinction matters because DSH reads an absent `inputModalities` as
 * "unknown" and forwards image blocks regardless, which ends in a provider-side
 * rejection. An explicit list makes the harness project pictures to a text
 * placeholder *before* the request is built, so a text-only model still gets a
 * usable turn that names the picture instead of failing on it.
 *
 * A model absent from the roster — `auto`, or one the licence dropped — is
 * declared text-only: the adapter has no evidence the picture can be read, and
 * claiming otherwise would spend a request to find out.
 *
 * @param model - a roster entry, or `undefined` for an unknown model.
 * @returns `['text', 'image']` when the roster advertises image input.
 */
function modalitiesOf(model) {
  return model?.supportsImage === true ? ['text', 'image'] : ['text']
}

/**
 * The Comate provider route implemented over `zulu serve`.
 */
export class ComateAdapter extends LlmAdapter {
  #options
  #planner
  /**
   * Uploaded image ids by request-version id.
   *
   * The same picture often appears in more than one turn — a restart re-sends
   * the whole transcript, and a user may refer back to a screenshot. The version
   * id covers every transform input, so a hit is the same bytes at the same
   * size: re-uploading would spend a round trip for an id Comate already has.
   */
  #uploads = new Map()

  /**
   * @param options - display name, credential reader, and server supervisor.
   */
  constructor(options) {
    super()
    this.#options = options
    this.#planner = new ConversationPlanner({
      newConversationId: options.newConversationId,
      log: options.log,
    })
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
   * One roster entry, or `undefined` when the roster cannot be read.
   *
   * A failed lookup must not fail the turn: the roster decides *how* to send a
   * request (which effort to forward, whether to attach pictures), not whether
   * a request is possible at all. Losing it degrades the turn to the plain
   * text-only shape rather than blocking a conversation someone is in the
   * middle of.
   *
   * @param model - the exact model id of this request.
   * @param signal - caller cancellation.
   * @returns the matching roster entry.
   */
  async #rosterEntry(model, signal) {
    const roster = await fetchModels({
      credential: this.#options.readCredential(),
      userAgent: this.#options.userAgent,
      zuluVersion: this.#options.zuluVersion,
      signal,
    }).catch(() => undefined)
    return roster?.find((entry) => entry.id === model)
  }

  /**
   * Upload this turn's pictures and collect the ids `zulu serve` accepts.
   *
   * Attachment bytes are the harness's to read: the adapter receives only a
   * reference, and `attachments.readImageRequest` is the sanctioned way to turn
   * one into bytes at the target size this route declared. Uploading is the
   * adapter's job because `serve`'s own uploader cannot authenticate (see
   * `./images.js`).
   *
   * A picture that cannot be attached does not fail the turn. The alternative —
   * ending a conversation because one screenshot was oversized — is worse than
   * telling the model in prose that a picture was there, which is what
   * `imagesAttached` drives in the renderer.
   *
   * @param options - the not-yet-delivered messages, the model id, credentials,
   *   cancellation, and a logger.
   * @returns the ids to send, plus a predicate telling whether one message's
   *   images all made it.
   */
  async #attachImages(options) {
    const { messages, model, credential, signal, log } = options
    const refs = []
    for (const message of messages) {
      for (const block of message.content) {
        // An offloaded image is a deliberate omission: the harness already
        // replaced its bytes with placeholder text to make the request fit.
        if (block.type !== 'image' || block.offloaded === true) continue
        refs.push(block.attachment)
      }
    }
    if (refs.length === 0) return { ids: [], attached: () => true }

    // Resolved per turn rather than captured at activation: the attachment
    // service is a separate plugin, and a profile without it must still be able
    // to run a text conversation.
    const store = this.#options.attachments?.()
    if (store === undefined) {
      log?.('comate images skipped: no attachment provider is mounted')
      return { ids: [], attached: () => false }
    }

    const byAttachment = new Map()
    const ids = []
    for (const ref of refs) {
      const key = String(ref.attachmentId)
      const known = byAttachment.get(key)
      if (known !== undefined) {
        if (known !== '') ids.push(known)
        continue
      }
      try {
        const cached = this.#uploads.get(`${key}@${String(ref.bytes)}`)
        const id = cached ?? await this.#uploadOne(store, ref, model, credential, signal)
        this.#uploads.set(`${key}@${String(ref.bytes)}`, id)
        byAttachment.set(key, id)
        ids.push(id)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        log?.(`comate image not attached: ${reason}`)
        // An empty string records "tried and failed", so a message with two
        // copies of one picture does not retry the same upload twice.
        byAttachment.set(key, '')
      }
    }

    const attached = (message) => message.content
      .filter((block) => block.type === 'image' && block.offloaded !== true)
      .every((block) => {
        const id = byAttachment.get(String(block.attachment.attachmentId))
        return id !== undefined && id !== ''
      })
    return { ids, attached }
  }

  /**
   * Read one attachment at this route's target size and upload it.
   *
   * @param read - the attachment service's `readImageRequest`.
   * @param ref - the durable attachment reference.
   * @param model - the model id, for target resolution.
   * @param credential - the credential whose licence authenticates the upload.
   * @param signal - caller cancellation.
   * @returns the numeric id the request body carries.
   */
  async #uploadOne(store, ref, model, credential, signal) {
    const target = this.imageRequestTarget('comate', model, ref)
    const version = await store.readImageRequest(ref, target, signal)
    return uploadImage({
      data: version.data,
      mediaType: version.mediaType,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      credential,
      host: apiHostFor(credential.platform),
      signal,
      userAgent: this.#options.userAgent,
    })
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
      inputModalities: modalitiesOf(model),
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
      inputModalities: modalitiesOf(match),
      ...(match?.reasoning === undefined ? {} : { reasoning: match.reasoning }),
    }
  }

  /**
   * Stream one turn.
   *
   * The credential is re-read on every call rather than captured once, so a user
   * who signs in mid-session starts working without a restart, and a stale
   * server started under an older licence is replaced.
   *
   * The conversation is reused when Comate's copy of it is still an exact prefix
   * of the harness's transcript; otherwise a fresh one is started with the whole
   * transcript re-sent. `./history.js` owns that judgement and the reasoning
   * behind it.
   *
   * The request goes to `POST /session`, not to
   * `/api/v1/conversations/<id>/messages`. Both drive the same agent, but only
   * `/session` forwards `thinkingEnabled` and `effort` to the model: the
   * messages endpoint builds its request body from a fixed field list that
   * predates both, so reasoning depth sent there is dropped without an error.
   * `/session` also reports a `requires_action` frame with the pending question
   * attached, instead of the ambiguous "tool element then completed" pair.
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
    const plan = this.#planner.plan({
      sessionId: options.sessionId,
      messages: options.messages,
      system: options.system,
      model: options.model,
    })
    const conversationId = plan.conversationId

    // A continued turn with nothing new to say still has to produce a stream, and
    // the server rejects an empty query, so it is answered locally instead.
    if (plan.fresh.length === 0) {
      this.#options.log(`comate turn ← ${String(port)} nothing new to send`)
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const entry = await this.#rosterEntry(options.model, options.signal)
    const images = await this.#attachImages({
      messages: plan.fresh,
      model: options.model,
      credential,
      signal: options.signal,
      log: this.#options.log,
    })
    const query = plan.restart
      ? renderQuery({
        messages: plan.fresh,
        system: options.system,
        imagesAttached: images.attached,
      })
      : renderTurn({ messages: plan.fresh, imagesAttached: images.attached })

    const body = {
      conversation: conversationId,
      query,
      cwd: workingDirectory,
      model: options.model,
      mode: 'Agent',
      // Only sent when the roster actually advertises a depth the model knows:
      // the endpoint accepts any string, so a value derived from nothing would
      // be silently accepted and silently useless.
      ...(options.reasoningEffort === undefined || entry?.reasoning === undefined
        ? {}
        : { effort: options.reasoningEffort }),
      // Thinking is on by default upstream, so only the *absence* of support
      // needs saying. There is no harness knob that turns reasoning off — the
      // nearest thing is a low effort — so nothing here can express "off".
      ...(entry?.supportsThinking === false ? { thinkingEnabled: false } : {}),
      ...(images.ids.length === 0 ? {} : { attachImages: images.ids }),
      // `username` must stay absent: with serve-side auth on, sending it is a
      // 403 rather than an alternative credential.
      ...(credential.kind === 'license' ? { license: credential.value } : { ptoken: credential.value }),
    }

    this.#options.log(
      `comate turn → ${String(port)} model=${options.model} cwd=${workingDirectory} ${plan.reused ? 'continuing' : 'new'} conversation`
      + `${body.effort === undefined ? '' : ` effort=${String(body.effort)}`}`
      + `${images.ids.length === 0 ? '' : ` images=${String(images.ids.length)}`}`,
    )

    try {
      yield* runTurn({
        port,
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
      // The server's copy of this conversation is now suspect: a transport fault
      // can leave it half-written. Starting over next turn is what keeps a broken
      // conversation from poisoning every later turn.
      this.#planner.forget(options.sessionId)
      throw new LlmError(message, codeForFailure(message))
    } finally {
      if (options.signal?.aborted === true) {
        this.#planner.forget(options.sessionId)
        void cancelTurn(port, conversationId)
      }
    }
  }
}
