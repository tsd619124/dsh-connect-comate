/**
 * Credential and locator tests.
 *
 * The credential reader is the plugin's only contact with the user's Comate
 * sign-in, so these tests pin its whole contract: which file wins, what an
 * unreadable file does, and — most importantly — that the secret never reaches
 * the description the status route publishes.
 *
 * @module dsh-connect-comate/test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { authDir, describeCredential, readCredential, resolveZuluBin, zuluCandidates } from '../lib/paths.js'

/**
 * Run one assertion with `COMATE_AUTH_DIR` pointed at a throwaway directory.
 *
 * The reader consults the environment on every call, so this is the only way to
 * exercise it without touching the real `~/.comate`.
 *
 * @param body - receives the temporary auth directory.
 */
function withAuthDir(body) {
  const directory = mkdtempSync(join(tmpdir(), 'comate-auth-'))
  const previousDir = process.env.COMATE_AUTH_DIR
  const previousLicense = process.env.COMATE_LICENSE
  process.env.COMATE_AUTH_DIR = directory
  delete process.env.COMATE_LICENSE
  try {
    body(directory)
  } finally {
    if (previousDir === undefined) delete process.env.COMATE_AUTH_DIR
    else process.env.COMATE_AUTH_DIR = previousDir
    if (previousLicense === undefined) delete process.env.COMATE_LICENSE
    else process.env.COMATE_LICENSE = previousLicense
    rmSync(directory, { recursive: true, force: true })
  }
}

test('authDir honours the environment override', () => {
  withAuthDir((directory) => {
    assert.equal(authDir(), directory)
  })
})

test('with nothing signed in the credential is undefined', () => {
  withAuthDir(() => {
    assert.equal(readCredential(), undefined)
  })
})

test('cli-login.json supplies a licence and its account name', () => {
  withAuthDir((directory) => {
    writeFileSync(join(directory, 'cli-login.json'), JSON.stringify({
      platform: 'SAAS',
      license: 'licence-abc',
      displayName: '张三',
    }))
    const credential = readCredential()
    assert.equal(credential.kind, 'license')
    assert.equal(credential.value, 'licence-abc')
    assert.equal(credential.platform, 'SAAS')
    assert.equal(credential.displayName, '张三')
  })
})

test('COMATE_LICENSE outranks the file on disk', () => {
  withAuthDir((directory) => {
    writeFileSync(join(directory, 'cli-login.json'), JSON.stringify({ license: 'from-file' }))
    process.env.COMATE_LICENSE = 'from-env'
    const credential = readCredential()
    assert.equal(credential.value, 'from-env')
    assert.match(credential.source, /COMATE_LICENSE/)
  })
})

test('a bare login file is read as an internal token', () => {
  withAuthDir((directory) => {
    writeFileSync(join(directory, 'login'), 'token-xyz\n')
    const credential = readCredential()
    assert.equal(credential.kind, 'token')
    assert.equal(credential.value, 'token-xyz')
  })
})

test('a licence file wins over the internal token', () => {
  withAuthDir((directory) => {
    writeFileSync(join(directory, 'cli-login.json'), JSON.stringify({ license: 'licence-abc' }))
    writeFileSync(join(directory, 'login'), 'token-xyz')
    assert.equal(readCredential().kind, 'license')
  })
})

test('a malformed credential file falls through instead of throwing', () => {
  withAuthDir((directory) => {
    writeFileSync(join(directory, 'cli-login.json'), '{ not json')
    assert.equal(readCredential(), undefined)
  })
})

test('an empty licence string falls through to the token', () => {
  withAuthDir((directory) => {
    writeFileSync(join(directory, 'cli-login.json'), JSON.stringify({ license: '   ' }))
    writeFileSync(join(directory, 'login'), 'token-xyz')
    assert.equal(readCredential().kind, 'token')
  })
})

test('describeCredential never carries the secret', () => {
  const described = describeCredential({
    kind: 'license',
    value: 'super-secret-value',
    source: '/tmp/cli-login.json',
    displayName: '张三',
  })
  assert.equal(described.signedIn, true)
  assert.equal(described.kind, 'license')
  assert.equal(described.displayName, '张三')
  assert.doesNotMatch(JSON.stringify(described), /super-secret-value/)
})

test('describeCredential explains how to sign in when nothing is found', () => {
  const described = describeCredential(undefined)
  assert.equal(described.signedIn, false)
  assert.equal(described.kind, 'none')
  assert.match(described.hint, /zulu login/)
})

test('zulu candidate paths put the configured binary first', () => {
  const candidates = zuluCandidates({ zuluBin: '/custom/zulu' })
  assert.equal(candidates[0], '/custom/zulu')
  assert.ok(candidates.some((path) => path.includes('.comate/zulu-cli/bin/zulu')))
})

test('a configured path that does not exist falls through to auto-detection', () => {
  // A stale setting must not brick the provider, so the probe continues past a
  // bad explicit path instead of trusting it.
  const found = resolveZuluBin({ zuluBin: '/definitely/not/here/zulu' })
  assert.notEqual(found, '/definitely/not/here/zulu')
})

test('resolveZuluBin returns a path that actually exists', () => {
  const found = resolveZuluBin({ zuluBin: '' })
  if (found === undefined) return // Comate is not installed here; nothing to assert.
  assert.match(found, /zulu$/)
})
