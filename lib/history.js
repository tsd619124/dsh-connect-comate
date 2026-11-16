/**
 * Conversation reuse: decide, per turn, whether Comate already knows the history.
 *
 * An earlier version of this adapter assumed `zulu serve` had no memory and sent
 * the whole transcript as one query on every turn under a fresh conversation id.
 * That assumption was wrong, and measurably expensive:
 *
 * - Comate persists a conversation server-side. Two turns under one id remember
 *   each other, and the memory survives killing and restarting `zulu serve`,
 *   because it lands in `~/.comate-engine/store/chat_session_<id>`.
 * - Re-sending the transcript therefore charged the licence for the same tokens
 *   on every turn, and made long conversations progressively slower.
 * - Pending interactions (`ask_user_question`) never worked: the CLI keeps the
 *   pending ask in its own conversation state, so answering it required posting
 *   the answer into the *same* conversation. A fresh id abandoned the ask, which
 *   is why turns used to end in the middle of a question.
 *
 * Reusing a conversation is only safe while the harness's transcript still
 * extends what was already delivered. DSH may compact, rewrite, or drop messages
 * between turns, and switching model changes the prompt too. In those cases the
 * server's copy is stale in a way nothing can repair from the client, so the plan
 * has to start a fresh conversation and re-send the full transcript.
 *
 * So the planner keeps a small per-session record of what it last delivered and
 * answers one question: continue this conversation with just the new messages, or
 * start over with everything?
 *
 * @module dsh-connect-comate/history
 */

import { renderQuery, renderTurn } from './prompt.js'

/** How many sessions keep their delivery record; older ones are forgotten. */
const TRACKED_SESSIONS = 64

/** The record is missing: this is the session's first turn. */
const FIRST_TURN = 'first turn'

/** The transcript is identical to what was already delivered. */
const NOTHING_NEW = 'nothing new to send'

/**
 * A stable identity for one message, used to prove the transcript still extends.
 *
 * DSH assigns every message an id, including projected history, so the ids form
 * an exact fingerprint. The role is folded in because a projection could in
 * principle reuse an id across roles, and a false match would silently drop text.
 *
 * @param message - any request message.
 * @returns the identity string.
 */
function messageKey(message) {
  return `${String(message.role)}:${String(message.id ?? '')}`
}

/**
 * The system-instruction text of this request, flattened for comparison.
 *
 * `zulu serve` has no field for a system prompt, so it is prepended to the query.
 * That makes it part of the delivered history: if it changes, the conversation
 * cannot be continued, because the server would keep answering under the old one.
 *
 * @param system - the request's system instruction, if any.
 * @param messages - the full transcript, which may also carry system messages.
 * @returns the flattened instruction text.
 */
function instructionText(system, messages) {
  const parts = []
  if (typeof system === 'string' && system.trim() !== '') parts.push(system.trim())
  for (const message of messages) {
    if (message.role !== 'system' && message.role !== 'developer') continue
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text.trim())
    }
  }
  return parts.join('\n\n')
}

/**
 * Decide how to deliver this turn to Comate.
 *
 * Keeps one record per DSH session. The record is dropped when the turn cannot be
 * continued, so the next turn starts clean instead of trying again.
 */
export class ConversationPlanner {
  #records = new Map()
  #newConversationId
  #log

  /**
   * @param options - id factory and a logger.
   */
  constructor(options) {
    this.#newConversationId = options.newConversationId
    this.#log = options.log
  }

  /**
   * Plan one turn.
   *
   * @param options - session id, transcript, system instruction, and model.
   * @returns the conversation id to use and the query to send.
   */
  plan(options) {
    const { sessionId, messages, system, model } = options
    const keys = messages.map(messageKey)
    const instructions = instructionText(system, messages)
    const record = sessionId === undefined ? undefined : this.#records.get(sessionId)
    const reason = this.#refusal(record, keys, instructions, model)

    if (reason === undefined) {
      // Continue: deliver only what the server has not seen yet.
      const fresh = messages.slice(record.delivered)
      this.#remember(sessionId, { ...record, keys, delivered: messages.length })
      return {
        conversationId: record.conversationId,
        query: renderTurn({ messages: fresh }),
        reused: true,
      }
    }

    // The transcript is unchanged since the last turn, so the conversation is
    // still right; there is simply nothing to say. Restarting here would discard
    // a healthy conversation and re-charge for history on a no-op turn.
    if (reason === NOTHING_NEW) {
      return { conversationId: record.conversationId, query: '', reused: true }
    }

    if (reason !== FIRST_TURN) this.#log?.(`comate conversation restart (${reason})`)
    const conversationId = this.#newConversationId()
    this.#remember(sessionId, {
      conversationId,
      keys,
      instructions,
      model,
      delivered: messages.length,
    })
    return { conversationId, query: renderQuery({ messages, system }), reused: false }
  }

  /**
   * Drop the record for a session, so the next turn starts a new conversation.
   *
   * @param sessionId - the DSH session id.
   */
  forget(sessionId) {
    if (sessionId === undefined) return
    this.#records.delete(sessionId)
  }

  /**
   * The conversation id currently serving a session, if any.
   *
   * Read-only reporting for the status route; it never creates a record.
   *
   * @param sessionId - the DSH session id.
   * @returns the id, or `undefined`.
   */
  conversationIdOf(sessionId) {
    return sessionId === undefined ? undefined : this.#records.get(sessionId)?.conversationId
  }

  /**
   * Why this turn cannot continue the recorded conversation, if it cannot.
   *
   * @param record - the session record, if any.
   * @param keys - the current transcript identities.
   * @param instructions - the current instruction text.
   * @param model - the current model id.
   * @returns a reason, or `undefined` when the conversation can continue.
   */
  #refusal(record, keys, instructions, model) {
    if (record === undefined) return FIRST_TURN
    if (record.instructions !== instructions) return 'system prompt changed'
    if (record.model !== model) return 'model changed'
    if (keys.length < record.delivered) return 'transcript shrank'
    for (let index = 0; index < record.delivered; index += 1) {
      if (keys[index] !== record.keys[index]) return 'transcript was rewritten'
    }
    if (keys.length === record.delivered) return NOTHING_NEW
    return undefined
  }

  /**
   * Store a record, evicting the oldest when the table is full.
   *
   * @param sessionId - the DSH session id; `undefined` disables tracking.
   * @param record - the record to store.
   */
  #remember(sessionId, record) {
    if (sessionId === undefined) return
    this.#records.set(sessionId, record)
    while (this.#records.size > TRACKED_SESSIONS) {
      const oldest = this.#records.keys().next()
      if (oldest.done === true) return
      this.#records.delete(oldest.value)
    }
  }
}
