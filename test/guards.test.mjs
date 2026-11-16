/**
 * Route guard tests.
 *
 * These cover the checks that decide whether a request from a browser page may
 * read this machine's Comate account state. They matter more than they look:
 * every failure mode here is silent in the happy path — the routes work fine for
 * the plugin's own calls whether or not the guards are right — so they are
 * pinned directly.
 *
 * @module dsh-connect-comate/test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { requireLoopback, requireMethod, sendJson } from '../lib/guards.js'

/**
 * A response double that records what was written.
 *
 * @returns the response plus a way to read it back.
 */
function response() {
  const record = { status: 200, headers: {}, body: '', ended: false, headersSent: false }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      Object.assign(record.headers, headers)
    },
    setHeader(name, value) {
      record.headers[name] = value
    },
    end(body) {
      record.body = body ?? ''
      record.ended = true
    },
    get headersSent() {
      return record.ended
    },
  }
}

/** A request double with the given headers and socket address. */
function request(headers, localAddress = '127.0.0.1', method = 'GET') {
  return { headers, method, socket: { localAddress } }
}

test('a loopback Host with a loopback Origin passes', () => {
  const res = response()
  assert.equal(requireLoopback(request({ host: '127.0.0.1:52815', origin: 'http://127.0.0.1:52815' }), res), true)
  assert.equal(res.record.ended, false)
})

test('a missing Origin passes, because non-browser clients send none', () => {
  const res = response()
  assert.equal(requireLoopback(request({ host: '127.0.0.1:52815' }), res), true)
})

test('a rebinding Host is refused even from a loopback socket', () => {
  // This is the attack the check exists for: evil.example resolves to 127.0.0.1,
  // so the socket looks local while Host names the attacker's domain.
  const res = response()
  assert.equal(requireLoopback(request({ host: 'evil.example', origin: 'http://evil.example' }), res), false)
  assert.equal(res.record.status, 403)
  assert.match(res.record.body, /host-not-trusted/)
})

test('a foreign Origin is refused on a loopback Host', () => {
  const res = response()
  assert.equal(requireLoopback(request({ host: '127.0.0.1:52815', origin: 'https://evil.example' }), res), false)
  assert.equal(res.record.status, 403)
  assert.match(res.record.body, /origin-not-trusted/)
})

test('an absent Host is refused', () => {
  const res = response()
  assert.equal(requireLoopback(request({}), res), false)
  assert.equal(res.record.status, 403)
})

test('a Host naming a wildcard address is refused', () => {
  // `0.0.0.0` names "any interface", not this machine, so it is not evidence
  // that the caller reached us locally.
  const res = response()
  assert.equal(requireLoopback(request({ host: '0.0.0.0:52815' }), res), false)
  assert.equal(res.record.status, 403)
})

test('a Host naming some other machine is refused', () => {
  // The socket says we were reached at 127.0.0.1, but the caller claims a
  // different address; only an intermediary or a forged header does that.
  const res = response()
  assert.equal(requireLoopback(request({ host: '10.0.0.9:52815' }, '127.0.0.1'), res), false)
  assert.equal(res.record.status, 403)
})

test('an exact bound address is accepted', () => {
  const res = response()
  assert.equal(requireLoopback(request({ host: '192.168.1.5:52815' }, '192.168.1.5'), res), true)
})

test('localhost and IPv6 loopback are both accepted', () => {
  assert.equal(requireLoopback(request({ host: 'localhost:52815' }), response()), true)
  assert.equal(requireLoopback(request({ host: '[::1]:52815' }), response()), true)
  assert.equal(requireLoopback(request({ host: '[::1]:52815', origin: 'http://[::1]:52815' }), response()), true)
})

test('a method mismatch is refused with 405 and an Allow header', () => {
  const res = response()
  assert.equal(requireMethod(request({ host: '127.0.0.1' }, '127.0.0.1', 'POST'), res, 'GET'), false)
  assert.equal(res.record.status, 405)
  assert.equal(res.record.headers.allow, 'GET')
})

test('sendJson writes a complete JSON response', () => {
  const res = response()
  sendJson(res, { hello: '世界' })
  assert.equal(res.record.status, 200)
  assert.equal(res.record.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.record.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(res.record.body), { hello: '世界' })
})

test('sendJson measures length in bytes, not characters', () => {
  const res = response()
  sendJson(res, { text: '世界' })
  // A character count would understate the body and truncate it in the browser.
  assert.equal(res.record.headers['content-length'], Buffer.byteLength(res.record.body))
})
