import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { runTurn, codeForFailure } = await import(
  '/Users/fengguanjia/Documents/deepseek-harness/default-workspace/dsh-connect-comate/lib/turn.js'
)

/** Serve one canned SSE body, then close. */
async function withServer(frames, run) {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Collect a turn into an array. */
async function collect(port) {
  const chunks = []
  for await (const chunk of runTurn({ port, conversationId: 't1', body: {}, log: () => {} })) chunks.push(chunk)
  return chunks
}

test('a plain text turn becomes one text block', async () => {
  const chunks = await withServer([
    { kind: 'delta-batch', cid: 't1', chunks: [{ kind: 'text-delta', cid: 't1', mid: 'm1', eid: 'e1', delta: '你好', end: false }] },
    { kind: 'delta-batch', cid: 't1', chunks: [{ kind: 'text-delta', cid: 't1', mid: 'm1', eid: 'e1', delta: '，世界', end: true }] },
    { kind: 'completed', cid: 't1', status: 'completed', content: '你好，世界' },
    { type: 'done', status: 'completed', conversationId: 't1' },
  ], collect)

  assert.deepEqual(chunks.filter((c) => c.type === 'block-start'), [{ type: 'block-start', index: 0, blockType: 'text' }])
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '你好，世界')
  assert.deepEqual(chunks.find((c) => c.type === 'block-end'), { type: 'block-end', index: 0, block: { type: 'text', text: '你好，世界' } })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('reasoning and text interleave as two blocks', async () => {
  const chunks = await withServer([
    { kind: 'delta-batch', cid: 't1', chunks: [{ kind: 'thinking-delta', cid: 't1', mid: 'm1', eid: 'r1', delta: '先想', end: false }] },
    { kind: 'delta-batch', cid: 't1', chunks: [{ kind: 'text-delta', cid: 't1', mid: 'm1', eid: 'e1', delta: '再答', end: false }] },
    { type: 'done', status: 'completed', conversationId: 't1' },
  ], collect)

  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.deepEqual(starts, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'block-start', index: 1, blockType: 'text' },
  ])
  assert.equal(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''), '先想')
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '再答')
})

test('tool elements never become tool-call blocks', async () => {
  const chunks = await withServer([
    { kind: 'delta-batch', cid: 't1', chunks: [{ kind: 'text-delta', cid: 't1', mid: 'm1', eid: 'e1', delta: '查一下', end: false }] },
    { kind: 'element-add', cid: 't1', mid: 'm1', element: { id: 'tool1', type: 'TOOL', toolName: 'read_file', toolState: 'executed', content: 'done' } },
    { kind: 'delta-batch', cid: 't1', chunks: [{ kind: 'text-delta', cid: 't1', mid: 'm1', eid: 'e1', delta: '，读到了', end: true }] },
    { type: 'done', status: 'completed', conversationId: 't1' },
  ], collect)

  assert.equal(chunks.filter((c) => c.type === 'tool-call-delta').length, 0)
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '查一下，读到了')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('a task_failed frame becomes an error finish with a mapped code', async () => {
  const chunks = await withServer([
    { type: 'task_failed', error: 'Please enter a valid license.\nTips：可进入如流群（12199111）获得帮助\n', errorMessage: 'x' },
  ], collect)

  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'INVALID_CREDENTIAL')
})

test('a cancelled status becomes an aborted finish', async () => {
  const chunks = await withServer([
    { kind: 'delta-batch', cid: 't1', chunks: [{ kind: 'text-delta', cid: 't1', mid: 'm1', eid: 'e1', delta: '半截', end: false }] },
    { kind: 'completed', cid: 't1', status: 'cancelled' },
    { type: 'done', status: 'cancelled', conversationId: 't1' },
  ], collect)

  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.equal(chunks.filter((c) => c.type === 'block-end').length, 1)
})

test('an exception with no content becomes an error finish', async () => {
  const chunks = await withServer([
    { kind: 'element-add', cid: 't1', mid: 'm1', element: { id: 'x1', type: 'EXCEPTION', content: '模型服务超时' } },
    { type: 'done', status: 'completed', conversationId: 't1' },
  ], collect)

  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT')
})

test('a growing element forwards only the new suffix', async () => {
  const chunks = await withServer([
    { kind: 'element-add', cid: 't1', mid: 'm1', element: { id: 'e1', type: 'TEXT', content: '第一句。' } },
    { kind: 'element-patch', cid: 't1', mid: 'm1', eid: 'e1', patch: { id: 'e1', type: 'TEXT', content: '第一句。第二句。' } },
    { type: 'done', status: 'completed', conversationId: 't1' },
  ], collect)

  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '第一句。第二句。')
  assert.equal(chunks.find((c) => c.type === 'block-end').block.text, '第一句。第二句。')
})

test('codeForFailure maps the wording the CLI actually uses', () => {
  assert.equal(codeForFailure('No license or token provided'), 'INVALID_CREDENTIAL')
  assert.equal(codeForFailure('请先登录'), 'INVALID_CREDENTIAL')
  assert.equal(codeForFailure('quota exhausted'), 'QUOTA')
  assert.equal(codeForFailure('积分不足'), 'QUOTA')
  assert.equal(codeForFailure('rate limit reached'), 'RATE_LIMIT')
  assert.equal(codeForFailure('请求超时'), 'TIMEOUT')
  assert.equal(codeForFailure('上下文超出'), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(codeForFailure('something else entirely'), 'UNKNOWN')
})

test('a pending ask becomes visible text instead of a silent stop', async () => {
  const chunks = await withServer([
    { kind: 'delta-batch', cid: 't1', chunks: [{ kind: 'text-delta', cid: 't1', mid: 'm1', eid: 'e1', delta: '我需要确认一下。', end: true }] },
    {
      kind: 'element-add',
      cid: 't1',
      mid: 'm1',
      element: {
        id: 'tool1',
        type: 'TOOL',
        name: 'ask_user_question',
        toolName: 'ask_user_question',
        state: 'awaiting',
        toolState: 'awaiting',
        detail: {
          kind: 'ask',
          title: '今天的选择',
          state: 'pending',
          questions: [
            { id: 'choice_ab', prompt: '今天你选 A 还是 B？', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
          ],
        },
      },
    },
    { type: 'done', status: 'requires_action', conversationId: 't1' },
  ], collect)

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.match(text, /我需要确认一下/)
  assert.match(text, /今天的选择/)
  assert.match(text, /今天你选 A 还是 B/)
  assert.match(text, /可选：A \/ B/)
  assert.equal(chunks.filter((c) => c.type === 'tool-call-delta').length, 0)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('an ask with no prose still produces a question block', async () => {
  const chunks = await withServer([
    {
      kind: 'element-add',
      cid: 't1',
      mid: 'm1',
      element: {
        id: 'tool1',
        type: 'TOOL',
        toolName: 'ask_user_question',
        toolState: 'awaiting',
        detail: { kind: 'ask', questions: [{ id: 'q1', prompt: '要先做哪个？', options: [] }] },
      },
    },
    { type: 'done', status: 'requires_action', conversationId: 't1' },
  ], collect)

  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.deepEqual(starts, [{ type: 'block-start', index: 0, blockType: 'text' }])
  assert.match(chunks.find((c) => c.type === 'text-delta').text, /要先做哪个/)
})

test('an executed tool is not mistaken for a pending question', async () => {
  const chunks = await withServer([
    {
      kind: 'element-add',
      cid: 't1',
      mid: 'm1',
      element: {
        id: 'tool1',
        type: 'TOOL',
        toolName: 'ask_user_question',
        toolState: 'executed',
        detail: { kind: 'ask', questions: [{ id: 'q1', prompt: '这个问题已经答过了' }] },
      },
    },
    { type: 'done', status: 'completed', conversationId: 't1' },
  ], collect)

  assert.equal(chunks.filter((c) => c.type === 'text-delta').length, 0)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('a requires_action frame becomes a question the user can answer', async () => {
  const chunks = await withServer([
    { kind: 'requires_action', action: { toolName: 'run_command', actionType: 'confirm', resumeToken: 'c1:t1', payload: { title: '需要确认', prompt: '要执行 rm -rf build 吗', options: [{ label: '同意' }, { label: '拒绝' }] } } },
    { type: 'done', status: 'requires_action', conversationId: 't1' },
  ], collect)
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')

  assert.match(text, /需要确认/)
  assert.match(text, /要执行 rm -rf build 吗（可选：同意 \/ 拒绝）/)
  assert.match(text, /直接回答即可/)
  assert.equal(chunks.filter((chunk) => chunk.type === 'tool-call-delta').length, 0)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('a requires_action without a prompt still names the tool', async () => {
  const chunks = await withServer([
    { kind: 'requires_action', action: { toolName: 'create_plan', actionType: 'plan' } },
    { type: 'done', status: 'requires_action', conversationId: 't1' },
  ], collect)
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')

  assert.match(text, /create_plan/)
})

test('a requires_action carrying questions renders them the way the CLI sends them', async () => {
  // `POST /session` reports the same ask as `{title, questions:[{id,prompt,options}]}`,
  // with the turn ending on `status: requires_action`. Rendering only the
  // flat `prompt`/`options` shape would show nothing here.
  const chunks = await withServer([
    {
      kind: 'requires_action',
      cid: 'dsh-1',
      action: {
        conversationId: 'dsh-1',
        toolId: 'call_00_abc',
        toolName: 'ask_user_question',
        actionType: 'answer_questions',
        resumeToken: 'dsh-1:call_00_abc',
        payload: {
          title: '',
          questions: [
            {
              id: 'ab_choice',
              prompt: '选 A 还是 B？',
              options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }, { id: 'other_option', label: '' }],
              selectedOptionIds: [],
            },
          ],
        },
      },
    },
    { type: 'done', status: 'requires_action', conversationId: 'dsh-1', action: {} },
  ], collect)
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')

  assert.match(text, /选 A 还是 B？（可选：A \/ B）/)
  assert.match(text, /直接回答即可/)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})
test('the same ask arriving as both an element and a frame is shown once', async () => {
  // The server sends the pending question twice: as the `awaiting` TOOL element
  // that opens it, and as the `requires_action` frame that ends the turn. Both
  // carry the same `questions[]`, so showing both would duplicate the question.
  const ask = { title: '选 A 还是 B', questions: [{ id: 'choose_ab', prompt: '选 A 还是 B？', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }
  const chunks = await withServer([
    {
      kind: 'delta-batch',
      cid: 't1',
      chunks: [{
        kind: 'element-add',
        cid: 't1',
        mid: 'm1',
        element: { id: 'call_1', type: 'TOOL', name: 'ask_user_question', state: 'awaiting', toolState: 'awaiting', detail: { kind: 'ask', ...ask } },
      }],
    },
    { kind: 'requires_action', cid: 't1', action: { conversationId: 't1', toolId: 'call_1', toolName: 'ask_user_question', actionType: 'answer_questions', payload: ask } },
    { type: 'done', status: 'requires_action', conversationId: 't1' },
  ], collect)
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')

  // One heading, one option line, one closing line — not the whole block twice.
  assert.equal(text.split('- 选 A 还是 B？').length - 1, 1)
  assert.equal(text.match(/直接回答即可/g)?.length, 1)
  assert.equal(text.match(/- 选 A 还是 B？/g)?.length, 1)
})

test('a replayed ask that was already answered is not asked again', async () => {
  // Answering a pending ask continues the same conversation, and the server
  // re-emits the tool call it belongs to — still `awaiting`, because that is
  // what the transcript says happened. The turn itself ends `ok`, which is how
  // this differs from a question that is genuinely still waiting.
  const chunks = await withServer([
    {
      kind: 'delta-batch',
      cid: 't1',
      chunks: [{ kind: 'text-delta', cid: 't1', mid: 'm1', eid: 'e1', delta: '已收到你的选择：A。', end: true }],
    },
    {
      kind: 'element-add',
      cid: 't1',
      mid: 'm1',
      element: {
        id: 'call_00_6gepph9ws7n9fp8vcrzwm28p',
        type: 'TOOL',
        name: 'ask_user_question',
        state: 'awaiting',
        toolState: 'awaiting',
        detail: { kind: 'ask', title: '选 A 还是 B', questions: [{ id: 'choose_ab', prompt: '选 A 还是 B？', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] },
      },
    },
    { kind: 'completed', cid: 't1', status: 'ok', content: '已收到你的选择：A。' },
    { type: 'done', status: 'ok', conversationId: 't1' },
  ], collect)
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')

  assert.match(text, /已收到你的选择/)
  assert.doesNotMatch(text, /直接回答即可/)
})
