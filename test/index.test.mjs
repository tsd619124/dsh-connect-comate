/**
 * Activation tests: what the plugin registers, and what it refuses to do.
 *
 * These drive `apply()` against a host double rather than a live Host, so they
 * assert the shape of the registration — the parts most likely to break
 * silently, because a wrong provider id or settings namespace produces no error
 * at all, just a provider that never appears in the picker.
 *
 * @module dsh-connect-comate/test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, attribution, Config, inject, name, provider, SETTINGS_NS } from '../index.js'

/**
 * A host double exposing only the services `activate()` touches.
 *
 * @param overrides - per-test adjustments to the doubles.
 * @returns the context plus a record of everything registered through it.
 */
function host(overrides = {}) {
  const record = {
    adapters: [],
    directories: [],
    discoveries: [],
    routes: [],
    tools: [],
    released: [],
    pending: 0,
    effects: [],
    logs: [],
    injected: [],
  }

  const context = {
    logger: {
      info: (message) => record.logs.push(['info', message]),
      error: (message, error) => record.logs.push(['error', message, error]),
    },
    fiber: { entry: { options: { id: overrides.entryId ?? 'dsh-connect-comate' } } },
    get: (serviceName) => {
      if (serviceName === 'workingDirectory') return { get: () => '/tmp', defaultDirectory: '/tmp' }
      if (serviceName === 'sessions') return { get: () => undefined }
      return undefined
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        record.adapters.push({ providers, adapter })
        record.pending += 1
        return () => record.released.push('adapter')
      },
      registerConfigurableProviders: (rows) => {
        record.directories.push(...rows)
        record.pending += 1
        return () => record.released.push('directory')
      },
      registerModelDiscovery: (namespace, discover) => {
        record.discoveries.push({ namespace, discover })
        record.pending += 1
        return () => record.released.push('discovery')
      },
    },
    inject: (serviceNames, callback) => {
      record.injected.push(...serviceNames)
      const services = {
        webServer: {
          register: (route) => {
            record.routes.push(route.path)
            record.pending += 1
            return () => record.released.push(`route:${route.path}`)
          },
        },
        tools: {
          register: (definition) => {
            record.tools.push(definition)
            record.pending += 1
            return () => record.released.push(`tool:${definition.name}`)
          },
        },
      }
      const present = overrides.services ?? Object.keys(services)
      const wanted = serviceNames.filter((serviceName) => present.includes(serviceName))
      if (wanted.length !== serviceNames.length) return
      callback({ get: (name) => services[name] })
    },
    effect: (factory) => {
      const disposer = factory()
      record.effects.push(disposer)
      return () => {}
    },
  }

  return { context, record }
}

test('the bundle declares the provider and settings namespace the Host keys on', () => {
  assert.equal(name, 'dsh-connect-comate')
  assert.equal(provider, 'comate')
  assert.equal(SETTINGS_NS, 'dsh-connect-comate')
  assert.deepEqual(inject, ['llm'])
})

test('the patch row name matches the package name exactly', async () => {
  // A mismatch makes the Host's nearestPackage lookup drop the client bundle
  // with no error and no log, so the equality is asserted rather than assumed.
  const manifest = JSON.parse(
    await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )
  const patch = await (await import('node:fs/promises')).readFile(
    new URL('../cordis.patch.yml', import.meta.url),
    'utf8',
  )
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(patch, new RegExp(`name:\\s*${manifest.name}\\s*$`, 'm'))
})

test('every Config field is volatile so settings apply without a restart', () => {
  const schema = Config.toString()
  for (const field of ['displayName', 'zuluBin', 'workingDirectory', 'startupTimeoutSeconds', 'enabledModelIds']) {
    assert.ok(schema.includes(field), `Config is missing ${field}`)
  }
  for (const key of Object.keys(Config({}))) {
    const value = Config({})[key]
    assert.equal(typeof value, 'object', `${key} should be a live handle, not a plain value`)
  }
})

test('attribution names the plugin rather than impersonating the harness', () => {
  const headers = attribution()
  assert.match(headers['user-agent'], /^comate-zulu\/\d+\.\d+\.\d+ \(\+https:\/\/comate\.baidu\.com\)$/)
  assert.doesNotMatch(headers['user-agent'], /deepseek-harness/)
})

test('activation registers one adapter, one directory row, and one discovery', async () => {
  const { context, record } = host()
  await apply(context, {})

  assert.equal(record.adapters.length, 1)
  assert.deepEqual(record.adapters[0].providers, ['comate'])
  assert.deepEqual(record.directories, [{
    provider: 'comate',
    displayName: 'Comate (Zulu)',
    settingsNs: 'dsh-connect-comate',
    settingsPath: [],
    declared: false,
  }])
  assert.equal(record.discoveries.length, 1)
  assert.equal(record.discoveries[0].namespace, 'dsh-connect-comate')
})

test('the discovery namespace follows the entry id the Loader actually serves', async () => {
  // The settings page matches on the served namespace, so a plugin installed
  // under a different entry id must not keep reporting the literal constant.
  const { context, record } = host({ entryId: 'some-other-entry' })
  await apply(context, {})
  assert.equal(record.discoveries[0].namespace, 'some-other-entry')
})

test('the read routes and the one write route mount under the plugin prefix', async () => {
  const { context, record } = host()
  await apply(context, {})
  assert.deepEqual(record.routes.sort(), [
    '/plugins/dsh-connect-comate/__save',
    '/plugins/dsh-connect-comate/models',
    '/plugins/dsh-connect-comate/refresh',
    '/plugins/dsh-connect-comate/state',
    '/plugins/dsh-connect-comate/status',
    '/plugins/dsh-connect-comate/usage',
  ])
})

test('adapter metadata preserves the provider id and carries a real name', async () => {
  const { context, record } = host()
  await apply(context, {})
  const info = record.adapters[0].adapter.providerInfo('comate')
  assert.equal(info.id, 'comate')
  assert.equal(info.name, 'Comate (Zulu)')
})

test('resolveModel reports a positive context window and max tokens', async () => {
  const { context, record } = host()
  await apply(context, {})
  const resolved = await record.adapters[0].adapter.resolveModel('comate', 'auto')
  assert.equal(resolved.provider, 'comate')
  assert.equal(resolved.id, 'auto')
  assert.ok(Number.isInteger(resolved.context.contextWindow) && resolved.context.contextWindow > 0)
  assert.ok(Number.isSafeInteger(resolved.defaultMaxTokens) && resolved.defaultMaxTokens > 0)
})

test('a missing credential fails as MISSING_CREDENTIAL, not as a generic error', async () => {
  // Both the environment override and the on-disk credential have to be
  // neutralised: this suite must pass on a machine where the developer is
  // signed in, which is exactly the machine it is meant to be run on.
  const previousLicense = process.env.COMATE_LICENSE
  const previousDir = process.env.COMATE_AUTH_DIR
  delete process.env.COMATE_LICENSE
  process.env.COMATE_AUTH_DIR = mkdtempSync(join(tmpdir(), 'comate-unauthed-'))
  try {
    const { context, record } = host()
    await apply(context, {})
    await assert.rejects(
      async () => {
        for await (const chunk of record.adapters[0].adapter.stream({
          provider: 'comate',
          model: 'auto',
          messages: [],
          sessionId: 's1',
        })) void chunk
      },
      (error) => error.code === 'MISSING_CREDENTIAL',
    )
  } finally {
    if (previousLicense !== undefined) process.env.COMATE_LICENSE = previousLicense
    if (previousDir === undefined) delete process.env.COMATE_AUTH_DIR
    else process.env.COMATE_AUTH_DIR = previousDir
  }
})

test('the retry policy uses the shape DSH actually consumes', async () => {
  const { context, record } = host()
  await apply(context, {})
  const policy = record.adapters[0].adapter.providerRetryPolicy('comate')

  // `llm-retry` branches on `mode` to decide whether a retry limit exists at
  // all, and multiplies `initialDelayMs` for the wait. A policy missing those
  // keys is not rejected anywhere — it quietly becomes "retry forever, wait
  // nothing" — so the keys are pinned here rather than left to the type system.
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 2)
  assert.ok(Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0)
  assert.ok(Number.isFinite(policy.initialDelayMs) && policy.initialDelayMs > 0)
  assert.ok(Number.isFinite(policy.maxDelayMs) && policy.maxDelayMs > 0)
  assert.ok(Number.isFinite(policy.jitterRatio))

  // A retry cannot fix a credential or quota failure, so those stay out.
  assert.equal(policy.retryableCodes.includes('INVALID_CREDENTIAL'), false)
  assert.equal(policy.retryableCodes.includes('QUOTA'), false)
})

test('cleanup releases every registration it made', async () => {
  const { context, record } = host()
  await apply(context, {})
  // Four `llm`/`tools` registrations plus six routes were handed to the host;
  // the effect must hold one releaser for each of them.
  assert.equal(record.released.length + record.pending, 10)
  for (const disposer of record.effects) if (typeof disposer === 'function') disposer()
  assert.deepEqual(record.released, [
    'adapter',
    'directory',
    'discovery',
    'tool:comate_usage',
    'route:/plugins/dsh-connect-comate/status',
    'route:/plugins/dsh-connect-comate/state',
    'route:/plugins/dsh-connect-comate/models',
    'route:/plugins/dsh-connect-comate/usage',
    'route:/plugins/dsh-connect-comate/refresh',
    'route:/plugins/dsh-connect-comate/__save',
  ])
})

test('the usage tool is registered and reports an unauthenticated account honestly', async () => {
  const previousLicense = process.env.COMATE_LICENSE
  const previousDir = process.env.COMATE_AUTH_DIR
  delete process.env.COMATE_LICENSE
  process.env.COMATE_AUTH_DIR = mkdtempSync(join(tmpdir(), 'comate-unauthed-'))
  try {
    const { context, record } = host()
    await apply(context, {})
    assert.equal(record.tools.length, 1)
    const definition = record.tools[0]
    assert.equal(definition.name, 'comate_usage')

    const value = await definition.execute({}, {})
    assert.equal(value.available, false)
    assert.equal(value.signedIn, false)
    assert.equal(value.reason, 'not-signed-in')
    // The hint names the command that fixes it, so the card is actionable.
    assert.match(value.summary, /zulu login/)
    // The licence value must never be part of the tool's answer.
    assert.equal(JSON.stringify(value).includes('license"'), false)
  } finally {
    if (previousLicense !== undefined) process.env.COMATE_LICENSE = previousLicense
    if (previousDir === undefined) delete process.env.COMATE_AUTH_DIR
    else process.env.COMATE_AUTH_DIR = previousDir
  }
})

test('a host without a tools service still mounts the provider route', async () => {
  const { context, record } = host({ services: ['webServer'] })
  await apply(context, {})
  assert.equal(record.tools.length, 0)
  assert.equal(record.adapters.length, 1)
  assert.equal(record.routes.length, 6)
})

test('a broken registration is logged instead of thrown out of apply()', async () => {
  const { context, record } = host()
  context.llm.registerAdapter = () => {
    throw new Error('boom')
  }
  await apply(context, {})
  assert.ok(record.logs.some(([level]) => level === 'error'), 'the failure should be logged')
})
