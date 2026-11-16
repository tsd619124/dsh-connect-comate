/**
 * Prompt rendering tests.
 *
 * `zulu serve` accepts one `query` string per turn and nothing else: no message
 * array, no tool schema. The whole transcript therefore has to survive a
 * round-trip through prose, and these tests pin what that prose must retain —
 * roles, tool outcomes, and the instruction that names the live question.
 *
 * @module dsh-connect-comate/test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { latestUserText, renderQuery } from '../lib/prompt.js'

/** Build a message in the shape the harness projects. */
function message(role, content, extra = {}) {
  return { id: `${role}-1`, role, content, source: { kind: 'test' }, ...extra }
}

test('an empty transcript still names the question', () => {
  const rendered = renderQuery({ messages: [] })
  // `zulu serve` rejects a request whose query is empty, so the renderer must
  // always produce prose; this pins that it stays non-empty and on-topic.
  assert.ok(rendered.length > 0)
  assert.ok(rendered.includes('本轮需要你回答'))
})

test('system text is presented as environment, not as a user turn', () => {
  const rendered = renderQuery({
    messages: [message('user', [{ type: 'text', text: '帮我看看' }])],
    system: '你是一个严谨的助手。',
  })
  assert.ok(rendered.includes('你是一个严谨的助手。'))
  assert.ok(rendered.includes('系统提示'))
  // The system text must not be labelled as the user's own words.
  assert.ok(rendered.indexOf('系统提示') < rendered.indexOf('帮我看看'))
})

test('roles are labelled so the model can tell speakers apart', () => {
  const rendered = renderQuery({
    messages: [
      message('user', [{ type: 'text', text: '第一个问题' }]),
      message('assistant', [{ type: 'text', text: '第一个回答' }]),
      message('user', [{ type: 'text', text: '第二个问题' }]),
    ],
  })
  assert.ok(rendered.includes('第一个问题'))
  assert.ok(rendered.includes('第一个回答'))
  assert.ok(rendered.includes('第二个问题'))
  assert.match(rendered, /### 用户/)
  assert.match(rendered, /### 助手/)
})

test('tool results keep their outcome and their failure flag', () => {
  const rendered = renderQuery({
    messages: [
      message('user', [{ type: 'text', text: '读一下文件' }]),
      message('assistant', [{
        type: 'tool-call',
        id: 'call-1',
        name: 'read_file',
        arguments: { path: 'a.txt' },
      }]),
      message('tool', [{ type: 'text', text: 'ENOENT: no such file' }], { toolCallId: 'call-1', isError: true }),
    ],
  })
  assert.ok(rendered.includes('read_file'))
  assert.ok(rendered.includes('ENOENT'))
  assert.ok(rendered.includes('失败'))
})

test('a successful tool result is not labelled as a failure', () => {
  const rendered = renderQuery({
    messages: [
      message('user', [{ type: 'text', text: '读一下' }]),
      message('tool', [{ type: 'text', text: '文件内容' }], { toolCallId: 'c1' }),
    ],
  })
  assert.ok(rendered.includes('文件内容'))
  assert.doesNotMatch(rendered, /工具结果（失败）/)
})

test('the last user turn is what the model is told to answer', () => {
  const rendered = renderQuery({
    messages: [
      message('user', [{ type: 'text', text: '早先的问题' }]),
      message('assistant', [{ type: 'text', text: '早先的回答' }]),
      message('user', [{ type: 'text', text: '现在这个问题' }]),
    ],
  })
  assert.ok(rendered.includes('本轮需要你回答'))
})

test('reasoning blocks are not replayed as if the model had said them', () => {
  const rendered = renderQuery({
    messages: [
      message('user', [{ type: 'text', text: '问题' }]),
      message('assistant', [
        { type: 'reasoning', text: '这是我的内部思考' },
        { type: 'text', text: '这是给用户的回答' },
      ]),
    ],
  })
  assert.ok(rendered.includes('这是给用户的回答'))
  assert.doesNotMatch(rendered, /这是我的内部思考/)
})

test('image blocks degrade to a readable placeholder', () => {
  const rendered = renderQuery({
    messages: [message('user', [{ type: 'text', text: '看图' }, { type: 'image', mediaType: 'image/png' }])],
  })
  assert.ok(rendered.includes('看图'))
  assert.match(rendered, /图片/)
})

test('latestUserText returns the newest user wording', () => {
  assert.equal(
    latestUserText([
      message('user', [{ type: 'text', text: '旧的' }]),
      message('assistant', [{ type: 'text', text: '回答' }]),
      message('user', [{ type: 'text', text: '新的' }]),
    ]),
    '新的',
  )
  assert.equal(latestUserText([]), '')
})
