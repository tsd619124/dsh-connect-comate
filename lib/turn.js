/**
 * One conversational turn against `zulu serve`, translated into DSH chunks.
 *
 * The wire protocol is SSE where each `data:` line is a JSON frame. Frames come
 * in two families, and both must be handled because the server buffers
 * opportunistically:
 *
 * - `{kind:'delta-batch', cid, chunks:[...]}` — a batch of coalesced deltas.
 * - a bare delta frame, when the coalescer flushed a single entry.
 *
 * Inside a batch, text arrives as `{kind:'text-delta', delta, end}` carrying an
 * *increment*, while non-text elements arrive as `element-add` / `element-patch`
 * carrying the whole element. The turn ends with `{kind:'completed', status}`
 * followed by `{type:'done', status}`, or with `{type:'EXCEPTION'}` on a crash.
 *
 * The `POST /session` endpoint is used rather than
 * `POST /api/v1/conversations/:id/messages` because only the former forwards
 * `thinkingEnabled` and `effort` to the agent — the per-conversation endpoint
 * whitelists its body fields and silently drops both, which is what made the
 * reasoning-effort setting look supported while having no effect.
 *
 * One structural point drives the whole translation: **the Comate agent runs
 * its own tool loop**. Its `TOOL` elements describe work the CLI is doing
 * (reading files, running commands), not tool calls this adapter is asking the
 * harness to perform. Emitting them as `tool-call` blocks would make DSH try to
 * execute them a second time, so they are dropped from the transcript and only
 * counted for diagnostics.
 *
 * @module dsh-connect-comate/turn
 */

/**
 * Incremental SSE reader over a `fetch` body.
 *
 * @param body - the response body stream.
 * @param signal - caller cancellation.
 * @returns an async generator of decoded `data:` payload strings.
 */
async function* readSse(body, signal) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    if (signal?.aborted === true) return
    buffer += decoder.decode(chunk, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) yield line.slice(5).trim()
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) yield tail.slice(5).trim()
}

/**
 * One open block in the translated stream, keyed by the Comate element id.
 *
 * @param index - DSH block index assigned on first sight.
 * @param blockType - `text` or `reasoning`.
 */
function openBlock(index, blockType) {
  return { index, blockType, text: '', closed: false }
}

/**
 * Map a Comate element type to the DSH block type it may open.
 *
 * @param type - `TEXT` or `REASON`; anything else opens nothing.
 * @returns the block type, or `undefined`.
 */
function blockTypeOf(type) {
  if (type === 'TEXT') return 'text'
  if (type === 'REASON') return 'reasoning'
  return undefined
}

/**
 * Render a title plus questions as readable lines.
 *
 * Both ask surfaces — the `awaiting` tool element and the `requires_action`
 * frame — carry the same `questions[]` shape, so they get the same rendering.
 * Option labels are offered rather than option ids: the id (`ab_choice`) is
 * meaningless to a reader, while the label is what the CLI will accept back.
 *
 * @param title - an optional heading.
 * @param questions - Comate's question objects.
 * @returns the readable block, or `undefined` when nothing is askable.
 */
function renderQuestions(title, questions) {
  const lines = []
  const heading = typeof title === 'string' && title !== '' ? title : undefined
  let asked = 0
  for (const question of Array.isArray(questions) ? questions : []) {
    const prompt = typeof question?.prompt === 'string' ? question.prompt.trim() : ''
    if (prompt === '') continue
    const options = (Array.isArray(question.options) ? question.options : [])
      .map((option) => (typeof option?.label === 'string' ? option.label.trim() : ''))
      .filter((label) => label !== '')
    lines.push(options.length === 0 ? `- ${prompt}` : `- ${prompt}（可选：${options.join(' / ')}）`)
    asked += 1
  }
  // A heading alone is not a question. Returning it here would swallow the
  // caller's fallback and leave the user reading a title with nothing to answer.
  if (asked === 0) return undefined
  const head = heading === undefined ? '' : `${heading}\n`
  return `${head}${lines.join('\n')}\n\n直接回答即可，我会把答案转给 Comate 继续这次会话。`
}

/**
 * Render the questions of a pending `ask_user_question` as readable lines.
 *
 * The CLI does not wait for these answers inside one HTTP turn: it finishes the
 * turn with the ask still pending and resumes when the answer arrives as the
 * next message in the same conversation. Turning the ask into visible text is
 * what keeps that from looking like a truncated reply, and phrasing it as a
 * question means an ordinary next turn answers it.
 *
 * @param element - the `TOOL` element whose state is `awaiting`.
 * @returns a readable question block, or `undefined` when this is not an ask.
 */
function pendingAsk(element) {
  const detail = element?.detail
  if (detail?.kind !== 'ask') return undefined
  if (element.state !== 'awaiting' && element.toolState !== 'awaiting') return undefined
  const questions = Array.isArray(detail.questions) ? detail.questions : []
  if (questions.length === 0) return undefined
  return renderQuestions(detail.title, questions)
}

/**
 * Record one pending question, ignoring a repeat of one already recorded.
 *
 * @param state - translator state carrying the questions.
 * @param text - the rendered question block.
 */
function recordAsk(state, text) {
  if (text === undefined) return
  if (state.asks.includes(text)) return
  state.asks.push(text)
}

/**
 * Whether the turn ended normally, meaning nothing is waiting on the user.
 *
 * @param state - translator state holding the terminal statuses.
 * @returns `true` when the server reported a clean completion.
 */
function endedNormally(state) {
  const terminal = state.doneStatus ?? state.completedStatus
  return terminal === 'completed' || terminal === 'ok'
}

/**
 * The questions a finished turn is actually waiting on.
 *
 * A live ask reaches the translator twice — as an `awaiting` `TOOL` element and
 * as the `requires_action` frame that ends the turn — so the two are collected
 * into one list and deduplicated by {@link recordAsk}.
 *
 * The turn's own ending decides whether any of them is still open. An answered
 * question is replayed as the same `awaiting` element, because that is what the
 * transcript says happened, but the turn then ends `ok`; repeating the question
 * would ask the user something they just answered. Only a turn that stops short
 * of a normal ending — `requires_action`, or a stream cut off mid-turn — really
 * still has something to ask.
 *
 * @param state - translator state carrying the questions and the terminal status.
 * @returns the questions to show, possibly empty.
 */
function pendingAsks(state) {
  return endedNormally(state) ? [] : state.asks
}

/**
 * Describe a `requires_action` frame as something the user can answer.
 *
 * The frame carries `{toolName, actionType, payload, resumeToken}`. On
 * `POST /session` the payload of an `ask_user_question` is
 * `{title, questions:[{id, prompt, options:[{id, label}]}]}` — the same shape the
 * `awaiting` element uses, so both are rendered by {@link renderQuestions}.
 * Dropping the frame would look identical to a reply that stopped for no reason,
 * and answering in the next turn is the same recovery either way.
 *
 * @param action - the frame's `action` payload.
 * @returns the text to show, or `undefined` when there is nothing to say.
 */
function requiredAction(action) {
  const payload = action?.payload
  const toolName = typeof action?.toolName === 'string' ? action.toolName : undefined
  const title = typeof payload?.title === 'string' && payload.title !== '' ? payload.title : undefined

  const questions = renderQuestions(title, payload?.questions)
  if (questions !== undefined) return questions

  // A frame may instead offer a single prompt with options, or nothing at all.
  const prompt = typeof payload?.prompt === 'string' && payload.prompt !== '' ? payload.prompt : undefined
  if (prompt !== undefined) {
    const options = (Array.isArray(payload?.options) ? payload.options : [])
      .map((option) => (typeof option?.label === 'string' ? option.label.trim() : typeof option === 'string' ? option.trim() : ''))
      .filter((label) => label !== '')
    const line = options.length === 0 ? `- ${prompt}` : `- ${prompt}（可选：${options.join(' / ')}）`
    const heading = title === undefined ? '' : `${title}\n`
    return `${heading}${line}\n\n直接回答即可，我会把答案转给 Comate 继续这次会话。`
  }
  if (toolName === undefined) return undefined
  return `Comate 需要你确认 \`${toolName}\` 这一步。\n\n直接回答即可，我会把答案转给 Comate 继续这次会话。`
}

/**
 * Translate one Comate element into zero or more DSH chunks.
 *
 * @param element - the raw element, or a text delta increment.
 * @param deltaKind - `element` for a whole element, otherwise the delta kind.
 * @param state - translator state carried across frames.
 * @param emit - called with each produced chunk.
 */
function translateElement(element, deltaKind, state, emit) {
  // Text increments identify their element as `eid`; whole elements use `id`.
  // Both are the same Comate element, so one keying keeps them in one block.
  const elementId = typeof element?.id === 'string'
    ? element.id
    : (typeof element?.eid === 'string' ? element.eid : undefined)
  if (elementId === undefined) return

  // Bare text/thinking increments carry only the new characters.
  if (deltaKind === 'text-delta' || deltaKind === 'thinking-delta') {
    const wanted = deltaKind === 'text-delta' ? 'text' : 'reasoning'
    const existing = state.blocks.get(elementId)
    const text = typeof element.delta === 'string' ? element.delta : ''
    if (text === '') return
    if (existing === undefined) {
      const block = openBlock(state.nextIndex(), wanted)
      state.blocks.set(elementId, block)
      emit({ type: 'block-start', index: block.index, blockType: block.blockType })
      emit({ type: wanted === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text })
      block.text += text
      return
    }
    if (existing.closed || existing.blockType !== wanted) return
    emit({ type: wanted === 'text' ? 'text-delta' : 'reasoning-delta', index: existing.index, text })
    existing.text += text
    return
  }

  // Whole elements: open once, then forward only the newly appended suffix.
  const blockType = blockTypeOf(element.type)
  if (blockType === undefined) {
    if (element.type === 'TOOL') {
      state.toolEvents += 1
      recordAsk(state, pendingAsk(element))
    }
    if (element.type === 'WARNING') state.warnings.push(String(element.content ?? ''))
    if (element.type === 'EXCEPTION') state.exceptions.push(String(element.content ?? ''))
    return
  }

  const content = typeof element.content === 'string' ? element.content : ''
  const existing = state.blocks.get(elementId)
  if (existing === undefined) {
    if (content === '') return
    const block = openBlock(state.nextIndex(), blockType)
    state.blocks.set(elementId, block)
    emit({ type: 'block-start', index: block.index, blockType })
    emit({ type: blockType === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: content })
    block.text = content
    return
  }
  if (existing.closed || existing.blockType !== blockType) return
  // The server may resend a full element; forward only the unknown suffix, and
  // treat a rewrite that is not a pure extension as no change (the earlier text
  // is already committed to the transcript).
  if (!content.startsWith(existing.text)) return
  const addition = content.slice(existing.text.length)
  if (addition === '') return
  emit({ type: blockType === 'text' ? 'text-delta' : 'reasoning-delta', index: existing.index, text: addition })
  existing.text = content
}

/**
 * Run one turn and yield DSH `StreamChunk`s.
 *
 * @param options - server port, request payload, and cancellation. `body` is the
 *   `POST /session` payload and already carries `conversation`, `model`,
 *   `thinkingEnabled`, `effort` and `attachImages`; this function only posts it.
 * @returns an async generator of chunks, ending with exactly one `finish`.
 */
export async function* runTurn(options) {
  const { port, body, signal, log } = options
  const state = {
    blocks: new Map(),
    order: [],
    nextIndex: () => {
      const index = state.order.length
      state.order.push(index)
      return index
    },
    toolEvents: 0,
    asks: [],
    warnings: [],
    exceptions: [],
    finished: false,
    completedStatus: undefined,
    doneStatus: undefined,
    failure: undefined,
    failureCode: undefined,
  }

  const url = `http://127.0.0.1:${String(port)}/session`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '轮次已取消', code: 'ABORTED' } } }
      return
    }
    throw error
  }

  if (!response.ok) {
    const detail = await safeJson(response)
    const message = typeof detail?.error === 'string' ? detail.error : `zulu serve 返回 HTTP ${String(response.status)}`
    throw new Error(message)
  }
  if (response.body === null) throw new Error('zulu serve 返回了空的响应体')

  for await (const payload of readSse(response.body, signal)) {
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      continue
    }
    if (frame === null || typeof frame !== 'object') continue

    if (frame.type === 'task_failed') {
      state.failure = typeof frame.error === 'string' && frame.error !== '' ? frame.error : 'zulu serve 报告轮次失败'
      if (typeof frame.errorCode === 'string') state.failureCode = frame.errorCode
      break
    }
    if (frame.type === 'task_done') {
      state.doneStatus = frame.status
      break
    }
    // `POST /session` closes with `{kind:'completed'}` followed by `{type:'done'}`;
    // there is no `task_done`, so the terminal status has to be read off this one.
    if (frame.type === 'done') {
      state.doneStatus = frame.status
      break
    }
    // A crash inside the agent arrives as `{type:'EXCEPTION'}` before the
    // terminal frames. Keeping the text lets a bare failure be attributable.
    if (frame.type === 'EXCEPTION') {
      state.exceptions.push(String(frame.content ?? ''))
      continue
    }
    if (frame.kind === 'completed') {
      state.completedStatus = frame.status
      // A non-`ok` terminal frame carries zulu's own error code, e.g.
      // `SERVICE_UNAVAILABLE`. Preferring it over the message heuristic is what
      // makes a deployment or upstream fault attributable instead of UNKNOWN.
      if (frame.status !== undefined && frame.status !== 'ok') {
        const code = frame.error?.code
        if (typeof code === 'string' && code !== '') state.failureCode = code
        if (typeof frame.error?.message === 'string' && frame.error.message !== '') state.failure = frame.error.message
      }
      continue
    }
    if (frame.kind === 'requires_action') {
      recordAsk(state, requiredAction(frame.action))
      continue
    }
    if (frame.kind === 'delta-batch') {
      for (const chunk of Array.isArray(frame.chunks) ? frame.chunks : []) {
        if (chunk.kind === 'requires_action') {
          recordAsk(state, requiredAction(chunk.action))
        } else if (chunk.kind === 'element-add' || chunk.kind === 'element-patch') {
          const emitted = []
          translateElement(chunk.element ?? chunk.patch, 'element', state, (next) => emitted.push(next))
          yield* emitted
        } else if (chunk.kind === 'text-delta' || chunk.kind === 'thinking-delta') {
          const emitted = []
          translateElement(chunk, chunk.kind, state, (next) => emitted.push(next))
          yield* emitted
        }
      }
      continue
    }
    // A single un-coalesced delta frame, or a notice; notices carry no content.
    if (frame.kind === 'element-add' || frame.kind === 'element-patch') {
      const emitted = []
      translateElement(frame.element ?? frame.patch, 'element', state, (next) => emitted.push(next))
      yield* emitted
    } else if (frame.kind === 'text-delta' || frame.kind === 'thinking-delta') {
      const emitted = []
      translateElement(frame, frame.kind, state, (next) => emitted.push(next))
      yield* emitted
    }
  }

  // A pending ask becomes its own text block when the turn produced no prose of
  // its own; otherwise it is appended to the last text block. Either way the user
  // sees a question instead of a reply that simply stops.
  const asks = pendingAsks(state)
  if (asks.length > 0) {
    const question = asks.join('\n\n')
    const texts = [...state.blocks.values()].filter((block) => block.blockType === 'text' && !block.closed)
    const target = texts.at(-1)
    if (target === undefined) {
      const index = state.nextIndex()
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text: question }
      yield { type: 'block-end', index, block: { type: 'text', text: question } }
    } else {
      yield { type: 'text-delta', index: target.index, text: `\n\n${question}` }
      target.text += `\n\n${question}`
    }
  }

  // Close every block that is still open, in the order they were opened.
  for (const block of state.blocks.values()) {
    if (block.closed) continue
    block.closed = true
    yield {
      type: 'block-end',
      index: block.index,
      block: block.blockType === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'reasoning', text: block.text },
    }
  }

  if (state.failure !== undefined) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: state.failure, code: state.failureCode ?? codeForFailure(state.failure) },
      },
    }
    return
  }

  const status = state.doneStatus ?? state.completedStatus
  if (status === 'cancelled') {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'zulu 取消了本次轮次', code: 'ABORTED' } } }
    return
  }
  if (status === 'failed') {
    const message = state.exceptions.at(-1) ?? 'zulu 报告本轮失败'
    yield { type: 'finish', reason: { kind: 'error', failure: { message, code: state.failureCode ?? codeForFailure(message) } } }
    return
  }
  if (state.exceptions.length > 0 && state.blocks.size === 0) {
    const message = state.exceptions.at(-1)
    yield { type: 'finish', reason: { kind: 'error', failure: { message, code: codeForFailure(message) } } }
    return
  }

  log?.(`zulu turn finished (status=${String(status)} tools=${String(state.toolEvents)} warnings=${String(state.warnings.length)})`)
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * Ask the server to cancel one in-flight conversation.
 *
 * @param port - loopback port.
 * @param conversationId - the conversation to cancel.
 */
export async function cancelTurn(port, conversationId) {
  // `/conv/cancel/<id>` is the session-registry endpoint, and it is the one that
  // knows about conversations opened through `POST /session`. The
  // `/api/v1/conversations/<id>/cancel` route belongs to the older per-request
  // API and updates a snapshot table the session registry never reads, so using
  // it here would report success while the agent kept running.
  try {
    await fetch(`http://127.0.0.1:${String(port)}/conv/cancel/${encodeURIComponent(conversationId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // Best effort: an abandoned turn is also reclaimed when the session ends.
  }
}

/**
 * Read a failed response body without letting a bad payload mask the status.
 *
 * @param response - the non-ok response.
 * @returns the parsed body, or `undefined`.
 */
async function safeJson(response) {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Map a Comate error string onto a provider-neutral DSH failure code.
 *
 * The CLI answers with prose, so the classification is textual. Anything
 * unrecognised becomes `UNKNOWN`, which is not retried — better to show the
 * message than to spin on an error we cannot name.
 *
 * @param message - the failure text.
 * @returns a code from `LLM_FAILURE_CODES`.
 */
export function codeForFailure(message) {
  const text = message.toLowerCase()
  if (text.includes('license') || text.includes('token') || text.includes('登录') || text.includes('auth')) {
    return 'INVALID_CREDENTIAL'
  }
  if (text.includes('quota') || text.includes('积分') || text.includes('额度')) return 'QUOTA'
  if (text.includes('rate') || text.includes('限流') || text.includes('too many')) return 'RATE_LIMIT'
  if (text.includes('timeout') || text.includes('超时')) return 'TIMEOUT'
  if (text.includes('context') || text.includes('上下文')) return 'CONTEXT_WINDOW_EXCEEDED'
  return 'UNKNOWN'
}
