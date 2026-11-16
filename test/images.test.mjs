/**
 * Image upload tests.
 *
 * `zulu serve` uploads a local path with the caller's auth headers, but inside
 * the serve process those headers come back empty, so the upload answers
 * `401 licence 为空`. Uploading here and handing the server a bare numeric id
 * takes the server's own short-circuit — the id path never touches the network,
 * so it works where the path form cannot.
 *
 * @module dsh-connect-comate/test/images
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_IMAGE_BYTES, isUploadedImageId, uploadImage } from '../lib/images.js'

const license = { kind: 'license', value: 'test-license', source: 'test' }

/**
 * Replace the global `fetch` for the duration of one test.
 *
 * @param answer - a response, or a function producing one from the request.
 * @returns the request log plus a restore callback.
 */
function stubFetch(answer) {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return typeof answer === 'function' ? answer(url, init) : answer
  }
  return {
    calls,
    restore() {
      globalThis.fetch = previous
    },
  }
}

/** A minimal PNG-shaped payload; the bytes are only carried, never decoded. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('an uploaded id is the shape the server short-circuits on', () => {
  // The server tests `/^\d+$/` before deciding to upload, so anything else
  // would be treated as a local path and fail inside the serve process.
  assert.equal(isUploadedImageId('788264'), true)
  assert.equal(isUploadedImageId(' 788264 '), true)
  assert.equal(isUploadedImageId(788264), true)
  assert.equal(isUploadedImageId('/tmp/probe-image.png'), false)
  assert.equal(isUploadedImageId(''), false)
  assert.equal(isUploadedImageId(undefined), false)
})

test('an upload sends the licence as the login header and returns the id', async () => {
  const stub = stubFetch(
    new Response(JSON.stringify({ code: 200, data: { id: 788261, contentType: 'image/png' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  try {
    const id = await uploadImage({ data: png, mediaType: 'image/png', credential: license, host: 'https://comate.baidu.com' })
    assert.equal(id, '788261')
    assert.equal(stub.calls.length, 1)
    const [{ url, init }] = stub.calls
    assert.equal(url, 'https://comate.baidu.com/api/aidevops/autocomate/rest/autowork/v1/file/upload')
    // The server-side upload path fails because these headers come back empty
    // there; sending them from here is the whole point.
    assert.equal(init.headers['login-name'], 'test-license')
    assert.equal(init.headers['Uuap-login-name'], 'test-license')
    const body = JSON.parse(init.body)
    assert.equal(body.contentType, 'image/png')
    assert.match(body.fileData, /^data:image\/png;base64,/)
    assert.equal(body.width, 0)
    assert.equal(body.height, 0)
  } finally {
    stub.restore()
  }
})

test('a token credential is refused before any request is made', async () => {
  const stub = stubFetch(new Response('{}', { status: 200 }))
  try {
    await assert.rejects(
      uploadImage({ data: png, mediaType: 'image/png', credential: { kind: 'token', value: 't' }, host: 'https://x' }),
      /内部版/,
    )
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('a rejection names the status, and a body without an id names the code', async () => {
  const rejecting = stubFetch(new Response('{}', { status: 502 }))
  try {
    await assert.rejects(
      uploadImage({ data: png, mediaType: 'image/png', credential: license, host: 'https://x' }),
      /HTTP 502/,
    )
  } finally {
    rejecting.restore()
  }

  const idless = stubFetch(
    new Response(JSON.stringify({ code: 401, message: 'license为空', data: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  try {
    await assert.rejects(
      uploadImage({ data: png, mediaType: 'image/png', credential: license, host: 'https://x' }),
      /license为空/,
    )
  } finally {
    idless.restore()
  }
})

test('an oversized picture is rejected locally instead of being uploaded', async () => {
  const stub = stubFetch(new Response('{}', { status: 200 }))
  try {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1)
    await assert.rejects(
      uploadImage({ data: huge, mediaType: 'image/png', credential: license, host: 'https://x' }),
      /超过/,
    )
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})
