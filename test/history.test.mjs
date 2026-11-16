import { test } from 'node:test'
import assert from 'node:assert/strict'

const { ConversationPlanner } = await import(
  '/Users/fengguanjia/Documents/deepseek-harness/default-workspace/dsh-connect-comate/lib/history.js'
)

/** A message shaped the way the harness projects history. */
function message(id, role, text) {
  return { id, role, content: [{ type: 'text', text }] }
}

/** A planner with deterministic ids and a recording logger. */
function planner() {
  let counter = 0
  const logs = []
  const instance = new ConversationPlanner({
    newConversationId: () => {
      counter += 1
      return `conv-${String(counter)}`
    },
    log: (line) => logs.push(line),
  })
  return { instance, logs }
}

test('the first turn starts a conversation and sends the whole transcript', () => {
  const { instance } = planner()
  const messages = [message('m1', 'user', '第一句')]
  const plan = instance.plan({ sessionId: 's1', messages, system: '你是助手', model: 'auto' })

  assert.equal(plan.reused, false)
  assert.equal(plan.conversationId, 'conv-1')
  assert.match(plan.query, /你是助手/)
  assert.match(plan.query, /第一句/)
})

test('the second turn reuses the conversation and sends only the new turn', () => {
  const { instance } = planner()
  const first = [message('m1', 'user', '第一句'), message('m2', 'assistant', '第一答')]
  const start = instance.plan({ sessionId: 's1', messages: first, model: 'auto' })
  const second = [...first, message('m3', 'user', '第二句')]
  const plan = instance.plan({ sessionId: 's1', messages: second, model: 'auto' })

  assert.equal(plan.reused, true)
  assert.equal(plan.conversationId, start.conversationId)
  assert.match(plan.query, /第二句/)
  // The point of reuse: the earlier turns are not paid for again.
  assert.doesNotMatch(plan.query, /第一句/)
  assert.doesNotMatch(plan.query, /第一答/)
})

test('a rewritten transcript starts a fresh conversation with everything', () => {
  const { instance, logs } = planner()
  const first = [message('m1', 'user', '原始问题'), message('m2', 'assistant', '原始回答')]
  instance.plan({ sessionId: 's1', messages: first, model: 'auto' })
  // Compaction replaced the opening turn with a summary the server never saw.
  const compacted = [message('c1', 'user', '摘要：原始问题'), message('m2', 'assistant', '原始回答'), message('m3', 'user', '继续')]
  const plan = instance.plan({ sessionId: 's1', messages: compacted, model: 'auto' })

  assert.equal(plan.reused, false)
  assert.notEqual(plan.conversationId, 'conv-1')
  assert.match(plan.query, /摘要：原始问题/)
  assert.match(plan.query, /继续/)
  assert.ok(logs.some((line) => line.includes('transcript was rewritten')))
})

test('a shrunk transcript starts over instead of continuing a longer one', () => {
  const { instance, logs } = planner()
  const first = [message('m1', 'user', '一'), message('m2', 'assistant', '二'), message('m3', 'user', '三')]
  instance.plan({ sessionId: 's1', messages: first, model: 'auto' })
  const plan = instance.plan({ sessionId: 's1', messages: first.slice(0, 1).concat(message('m4', 'user', '新')), model: 'auto' })

  assert.equal(plan.reused, false)
  assert.match(plan.query, /一/)
  assert.ok(logs.some((line) => line.includes('transcript was rewritten') || line.includes('shrank')))
})

test('switching model starts a new conversation', () => {
  const { instance, logs } = planner()
  const messages = [message('m1', 'user', '你好')]
  instance.plan({ sessionId: 's1', messages, model: 'auto' })
  const plan = instance.plan({ sessionId: 's1', messages: [...messages, message('m2', 'user', '再来')], model: 'deepseek-v4-flash_x' })

  assert.equal(plan.reused, false)
  assert.match(plan.query, /你好/)
  assert.ok(logs.some((line) => line.includes('model changed')))
})

test('a changed system prompt starts a new conversation', () => {
  const { instance, logs } = planner()
  const messages = [message('m1', 'user', '你好')]
  instance.plan({ sessionId: 's1', messages, system: '旧提示', model: 'auto' })
  const plan = instance.plan({ sessionId: 's1', messages: [...messages, message('m2', 'user', '继续')], system: '新提示', model: 'auto' })

  assert.equal(plan.reused, false)
  assert.match(plan.query, /新提示/)
  assert.ok(logs.some((line) => line.includes('system prompt changed')))
})

test('a turn with nothing new produces an empty query', () => {
  const { instance } = planner()
  const messages = [message('m1', 'user', '只有这一句')]
  const start = instance.plan({ sessionId: 's1', messages, model: 'auto' })
  const plan = instance.plan({ sessionId: 's1', messages, model: 'auto' })

  // The conversation is still healthy, there is simply nothing to send — so it
  // is reused rather than restarted, and no history is re-charged.
  assert.equal(plan.reused, true)
  assert.equal(plan.conversationId, start.conversationId)
  assert.equal(plan.query, '')
})

test('sessions do not share conversations', () => {
  const { instance } = planner()
  const first = instance.plan({ sessionId: 'a', messages: [message('m1', 'user', 'A 的')], model: 'auto' })
  const second = instance.plan({ sessionId: 'b', messages: [message('m1', 'user', 'B 的')], model: 'auto' })

  assert.notEqual(first.conversationId, second.conversationId)
  assert.equal(second.reused, false)
})

test('forget drops the record so the next turn starts clean', () => {
  const { instance } = planner()
  const messages = [message('m1', 'user', '一')]
  const start = instance.plan({ sessionId: 's1', messages, model: 'auto' })
  instance.forget('s1')
  const plan = instance.plan({ sessionId: 's1', messages: [...messages, message('m2', 'user', '二')], model: 'auto' })

  assert.equal(plan.reused, false)
  assert.notEqual(plan.conversationId, start.conversationId)
  assert.match(plan.query, /一/)
})

test('conversationIdOf reports without creating a record', () => {
  const { instance } = planner()
  assert.equal(instance.conversationIdOf('nope'), undefined)
  assert.equal(instance.conversationIdOf(undefined), undefined)
  const plan = instance.plan({ sessionId: 's1', messages: [message('m1', 'user', '一')], model: 'auto' })
  assert.equal(instance.conversationIdOf('s1'), plan.conversationId)
})

test('a session without an id is never tracked, so turns never reuse', () => {
  const { instance } = planner()
  const messages = [message('m1', 'user', '一')]
  const first = instance.plan({ messages, model: 'auto' })
  const second = instance.plan({ messages: [...messages, message('m2', 'user', '二')], model: 'auto' })

  assert.equal(first.reused, false)
  assert.equal(second.reused, false)
  assert.notEqual(first.conversationId, second.conversationId)
})
