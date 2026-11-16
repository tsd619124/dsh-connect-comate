/**
 * Projection of a DSH request transcript into one `zulu serve` query string.
 *
 * `zulu serve` accepts a single `query` string plus an optional conversation
 * id; it has no multi-message field and no tool-schema field. The harness, on
 * the other hand, owns the authoritative transcript and may compact it at any
 * time. Reconciling those two by letting zulu keep its own copy of the
 * conversation would make compaction invisible to the model and drift
 * permanently after any edit.
 *
 * So this adapter is stateless by construction: every request carries the whole
 * transcript as one rendered document and uses a fresh conversation id. DSH
 * stays the only source of truth, compaction and model switches behave, and a
 * cancelled or crashed turn leaves no half-remembered state behind.
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
 * `zulu serve` takes text only, so an image or file block cannot be forwarded as
 * itself. Naming what was there is better than dropping it silently: the model
 * can then say it cannot see the picture, instead of inventing its contents.
 *
 * @param blocks - the non-text blocks of one message.
 * @returns a parenthetical note, or an empty string when there is nothing to say.
 */
function describeAttachments(blocks) {
  if (blocks.length === 0) return ''
  const images = blocks.filter((block) => block.type === 'image').length
  const files = blocks.filter((block) => block.type === 'file').length
  const other = blocks.length - images - files
  const parts = []
  if (images > 0) parts.push(`图片 ${String(images)} 张`)
  if (files > 0) parts.push(`文件 ${String(files)} 个`)
  if (other > 0) parts.push(`其他附件 ${String(other)} 个`)
  return `（本条包含 ${parts.join('、')}，内容未随文本传递）`
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
 * @returns the rendered section, or `undefined` when the message carries nothing.
 */
function renderMessage(message) {
  switch (message.role) {
    case 'user': {
      const body = message.content.map(textOf).filter((text) => text !== '').join('\n')
      const note = describeAttachments(message.content.filter((block) => block.type !== 'text'))
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
 * Render the request into the single query string `zulu serve` accepts.
 *
 * @param options - the harness request pieces.
 * @returns the query body, always non-empty.
 */
export function renderQuery(options) {
  const { messages, system } = options
  const promptParts = []
  if (typeof system === 'string' && system.trim() !== '') promptParts.push(system.trim())
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = message.content.map(textOf).filter((part) => part !== '').join('\n')
      if (text.trim() !== '') promptParts.push(text.trim())
    }
  }

  const transcript = messages.map(renderMessage).filter((section) => section !== undefined)

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
