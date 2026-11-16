/**
 * Projection of a DSH request transcript into `zulu serve` query strings.
 *
 * `zulu serve` accepts a single `query` string plus a conversation id; it has no
 * multi-message field and no tool-schema field. Two renderings are needed,
 * because Comate remembers conversations and the harness may still rewrite its
 * own transcript:
 *
 * - {@link renderQuery} renders the **whole** transcript. Used when a
 *   conversation is started (first turn, or after the planner found the server's
 *   copy unusable).
 * - {@link renderTurn} renders only what the server has **not** seen yet. Used
 *   when continuing a conversation, so a long chat does not pay for its own
 *   history on every turn.
 *
 * Which one applies is decided in `./history.js`, which also explains why
 * reusing a conversation is conditional rather than unconditional.
 *
 * The renderer is deliberately plain: Comate's agent is trained on CLI-style
 * prompts, so labelled sections read better to it than XML soup.
 *
 * @module dsh-connect-comate/prompt
 */

/**
 * Flatten one text-bearing content block to a string.
 *
 * @param block - a content block from any message role.
 * @returns the block's text, or an empty string.
 */
function textOf(block) {
  return block.type === 'text' ? block.text : ''
}

/**
 * Describe attachments that cannot survive the prose transport.
 *
 * `zulu serve` takes one query string, so a file block has no field of its own.
 * Naming what was there is better than dropping it silently: the model can then
 * say it cannot read the file, instead of inventing its contents.
 *
 * Images are the exception, and only when they really were attached: the request
 * carries them as `attachImages`, so the prose only has to say *where* they sit
 * relative to the text. Saying they were not transmitted while the picture is
 * sitting in the same request would be worse than saying nothing.
 *
 * @param blocks - the non-text blocks of one message.
 * @param imagesAttached - whether every image in these blocks was uploaded.
 * @returns a parenthetical note, or an empty string when there is nothing to say.
 */
function describeAttachments(blocks, imagesAttached) {
  if (blocks.length === 0) return ''
  const images = blocks.filter((block) => block.type === 'image').length
  const files = blocks.filter((block) => block.type === 'file').length
  const other = blocks.length - images - files
  const parts = []
  if (images > 0) {
    parts.push(imagesAttached ? `随本条附上 图片 ${String(images)} 张` : `图片 ${String(images)} 张（未随文本传递）`)
  }
  if (files > 0) parts.push(`文件 ${String(files)} 个（内容未随文本传递）`)
  if (other > 0) parts.push(`其他附件 ${String(other)} 个（内容未随文本传递）`)
  return parts.length === 0 ? '' : `（${parts.join('；')}）`
}

/**
 * Render a tool call as a readable line.
 *
 * The Comate agent runs its own tools and cannot be handed a callable schema, so
 * a recorded call is presented as a fact about what already happened. Keeping it
 * in the transcript preserves the reasoning that produced it.
 *
 * @param block - the `tool-call` block.
 * @returns a one-line description.
 */
function renderToolCall(block) {
  const args = typeof block.arguments === 'string' ? block.arguments : ''
  return `- 调用 ${block.name}(${args === '' ? '无参数' : args})`
}

/**
 * Render one non-system message into the transcript.
 *
 * @param message - any request message.
 * @param imagesAttached - tells whether this message's images were uploaded.
 * @returns the rendered section, or `undefined` when the message carries nothing.
 */
function renderMessage(message, imagesAttached) {
  switch (message.role) {
    case 'user': {
      const body = message.content.map(textOf).filter((text) => text !== '').join('\n')
      const note = describeAttachments(
        message.content.filter((block) => block.type !== 'text'),
        imagesAttached(message),
      )
      const sections = []
      if (body !== '') sections.push(body)
      if (note !== '') sections.push(note)
      return sections.length === 0 ? undefined : `### 用户\n${sections.join('\n')}`
    }
    case 'assistant': {
      const body = message.content.map(textOf).filter((text) => text !== '').join('\n')
      const calls = message.content.filter((block) => block.type === 'tool-call').map(renderToolCall)
      const sections = []
      if (body !== '') sections.push(body)
      if (calls.length > 0) sections.push(calls.join('\n'))
      return sections.length === 0 ? undefined : `### 助手\n${sections.join('\n')}`
    }
    case 'tool': {
      const body = message.content.map(textOf).filter((text) => text !== '').join('\n')
      if (body === '') return undefined
      const label = message.isError === true ? '工具结果（失败）' : '工具结果'
      return `### ${label}\n${body}`
    }
    default:
      return undefined
  }
}

/**
 * The default answer to "did this message's images reach the server?".
 *
 * Erring towards "no" keeps the prose honest when a caller forgets to pass the
 * predicate: it claims the pictures were not transmitted, which is exactly what
 * happens when nothing was uploaded.
 *
 * @returns always false.
 */
function neverAttached() {
  return false
}

/**
 * Render the request into the single query string `zulu serve` accepts.
 *
 * @param options - the harness request pieces, plus `imagesAttached`, a
 *   predicate answering whether one message's images were uploaded.
 * @returns the query body, always non-empty.
 */
export function renderQuery(options) {
  const { messages, system } = options
  const imagesAttached = options.imagesAttached ?? neverAttached
  const promptParts = []
  if (typeof system === 'string' && system.trim() !== '') promptParts.push(system.trim())
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = message.content.map(textOf).filter((part) => part !== '').join('\n')
      if (text.trim() !== '') promptParts.push(text.trim())
    }
  }

  const transcript = messages
    .map((message) => renderMessage(message, imagesAttached))
    .filter((section) => section !== undefined)

  const blocks = []
  if (promptParts.length > 0) {
    blocks.push(`以下是运行环境提供的系统提示，请在回答中遵守：\n\n${promptParts.join('\n\n')}`)
  }
  blocks.push(
    transcript.length === 0
      ? '以下是本轮需要你回答的内容：\n\n（本轮没有可用的对话内容）'
      : `以下是到目前为止的对话记录，最后一个「用户」区块是本轮需要你回答的内容：\n\n${transcript.join('\n\n')}`,
  )
  return blocks.join('\n\n---\n\n')
}

/**
 * The newest user turn's text, useful for logging and for a conversation title.
 *
 * @param messages - the request transcript.
 * @returns the last user message's text, or an empty string.
 */
export function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const text = message.content.map(textOf).filter((part) => part !== '').join('\n')
    if (text !== '') return text
  }
  return ''
}

/**
 * Render only the part of a transcript the server has not seen yet.
 *
 * Used when continuing a conversation Comate already remembers. Assistant
 * messages are dropped: the CLI produced its own replies, so echoing them back
 * would re-charge for text both sides already hold. Anything the harness newly
 * authored — the newest user turn, and any developer note prepended to it — is
 * rendered in full.
 *
 * @param options - the not-yet-delivered messages.
 * @returns the query body, or an empty string when there is nothing to send.
 */
export function renderTurn(options) {
  const imagesAttached = options.imagesAttached ?? neverAttached
  const fresh = options.messages.filter((message) => message.role !== 'assistant')
  const transcript = fresh
    .map((message) => renderMessage(message, imagesAttached))
    .filter((section) => section !== undefined)
  if (transcript.length === 0) return ''
  return `以下是本轮的新内容（更早的对话你已在本次会话中看到，无需重复）：\n\n${transcript.join('\n\n')}`
}
