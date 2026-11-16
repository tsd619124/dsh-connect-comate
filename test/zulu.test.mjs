/**
 * Launch-environment tests for the supervised `zulu serve` process.
 *
 * `zulu serve` picks its Comate deployment from `process.env.PLATFORM` and
 * falls back to the *internal* one when that variable is absent. A public-cloud
 * account therefore authenticates fine, lists its models fine, and then fails
 * every single conversation with "请检测网络后重试" — a failure that reads like a
 * network problem and is not one. These tests pin the translation from the
 * platform the login file records to the lowercase enum the CLI expects.
 *
 * @module dsh-connect-comate/test/zulu
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { platformEnv } from '../lib/zulu.js'

test('a SaaS licence runs the server against the public cloud', () => {
  // `~/.comate/cli-login.json` stores "SAAS", the CLI enum is "saas".
  assert.deepEqual(platformEnv({ kind: 'license', platform: 'SAAS' }), { PLATFORM: 'saas' })
})

test('an internal licence names the internal deployment in lowercase', () => {
  assert.deepEqual(platformEnv({ kind: 'ptoken', platform: 'INTERNAL' }), { PLATFORM: 'internal' })
})

test('the poc deployment is forwarded as-is', () => {
  assert.deepEqual(platformEnv({ kind: 'license', platform: 'POC' }), { PLATFORM: 'poc' })
})

test('an unknown platform sets nothing so the CLI reports its own error', () => {
  // Guessing here would turn a clear "wrong deployment" message into a silent
  // misroute; leaving the variable alone keeps the CLI's diagnostic.
  assert.deepEqual(platformEnv({ kind: 'license', platform: 'SOMETHING_ELSE' }), {})
  assert.deepEqual(platformEnv({ kind: 'license' }), {})
  assert.deepEqual(platformEnv(undefined), {})
})
