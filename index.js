/**
 * Comate (Zulu) as a DSH model provider, plus its credit readout.
 *
 * The plugin has two halves that share one credential:
 *
 * 1. **A provider route** (`comate`) registered on the Host's `llm` service.
 *    Every turn is relayed to a supervised `zulu serve` process and its SSE
 *    frames are translated into DSH stream chunks.
 * 2. **A read-only status surface** at `/plugins/dsh-connect-comate/*`, which
 *    reports the sign-in state, the model roster, and today's credit usage.
 *    The credential value never crosses that boundary.
 *
 * Everything it touches on the Comate side is already the user's: the sign-in
 * the CLI wrote under `~/.comate`, and the `zulu` launcher inside the installed
 * app. The plugin never writes to either, never decrypts the IDE's store, and
 * never asks for a password.
 *
 * @module dsh-connect-comate
 */

import { randomUUID } from 'node:crypto'

import z from '@deepseek-ai/schemastery'

import { ComateAdapter } from './lib/adapter.js'
import { normalizeModelIds, selectModels, visibleModelIds } from './lib/catalog.js'
import { requireLoopback, requireMethod, sendJson } from './lib/guards.js'
import { describeCredential, readCredential, resolveZuluBin } from './lib/paths.js'
import { fetchModels, fetchQuota, invalidateComateCaches, userAgentFor } from './lib/quota.js'
import { saveFieldOutcome, WRITABLE_FIELDS } from './lib/settings.js'
import { buildUsageTool } from './lib/tool.js'
import { readUsage } from './lib/usage.js'
import { ZuluServer } from './lib/zulu.js'

/** Route name the models picker and sessions select. */
export const provider = 'comate'

/** Settings namespace this plugin's Config is served under. */
export const SETTINGS_NS = 'dsh-connect-comate'

/** Prefix every HTTP route this plugin owns begins with. */
const ROUTE_PREFIX = '/plugins/dsh-connect-comate'

/** The plugin's own version, for attribution and for the status card. */
const VERSION = '0.2.1'

/** The `zulu` CLI generation these endpoints are written against. */
const ZULU_VERSION = '1.8.1'

/**
 * Plugin configuration.
 *
 * Every field is `.volatile()`: the Host resolves live values on each read, so
 * the settings card can change them without restarting the process.
 */
export const Config = z.object({
  displayName: z.string()
    .default('Comate (Zulu)')
    .description('Provider name shown in the model picker')
    .volatile(),
  zuluBin: z.string()
    .default('')
    .description('Path to the Comate `zulu` launcher; empty auto-detects')
    .volatile(),
  workingDirectory: z.string()
    .default('')
    .description('Directory the Comate agent runs in; empty follows the DSH session workspace')
    .volatile(),
  startupTimeoutSeconds: z.natural()
    .min(5)
    .max(180)
    .default(30)
    .description('How long to wait for `zulu serve` to become healthy')
    .volatile(),
  enabledModelIds: z.array(z.string())
    .default([])
    .description('Models to offer in the picker; empty means every model the licence includes')
    .volatile(),
})

/**
 * Read one field from a possibly-live Config object.
 *
 * A volatile field resolves to a `{get()}` handle rather than a value, so every
 * read goes through here instead of touching the property directly.
 *
 * @param config - the resolved config, or a `{get}` live reference.
 * @param key - field name.
 * @returns the current value, or `undefined`.
 */
function fieldOf(config, key) {
  const value = config?.[key]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/**
 * Satisfy the host's directive that every provider request carries attribution.
 *
 * The identity names this plugin rather than the harness: the request spends a
 * Comate licence, so claiming to be DSH would misattribute the traffic.
 *
 * @returns the header set to merge into every Comate call.
 */
export function attribution() {
  return { 'user-agent': userAgentFor(VERSION) }
}

/**
 * Mount the plugin.
 *
 * Registration failures are caught and logged rather than thrown: a broken
 * Comate install must cost the user one provider, not the whole Host.
 *
 * @param ctx - the Cordis context.
 * @param config - the resolved Config declaration.
 */
export async function apply(ctx, config = {}) {
  try {
    await activate(ctx, config)
  } catch (error) {
    ctx.logger.error?.('dsh-connect-comate: activation failed; the Comate provider stays unavailable', error)
  }
}

/**
 * The real activation sequence.
 *
 * @param ctx - the Cordis context.
 * @param config - the resolved Config declaration.
 */
async function activate(ctx, config) {
  const log = (message) => ctx.logger.info?.(`dsh-connect-comate: ${message}`)

  /** One supervisor per credential, so a re-login replaces the stale process. */
  let server
  const serverFor = async (zuluBin, credential) => {
    if (server !== undefined && server.matches(credential)) return server
    await server?.stop()
    server = new ZuluServer({ zuluBin, credential, log })
    return server
  }

  const adapter = new ComateAdapter({
    displayName: () => fieldOf(config, 'displayName') ?? 'Comate (Zulu)',
    enabledModelIds: () => normalizeModelIds(fieldOf(config, 'enabledModelIds')),
    userAgent: attribution()['user-agent'],
    zuluVersion: ZULU_VERSION,
    readCredential,
    resolveZuluBin: () => resolveZuluBin({ zuluBin: fieldOf(config, 'zuluBin') }),
    serverFor,
    newConversationId: () => `dsh-${randomUUID()}`,
    resolveWorkingDirectory: (sessionId) => resolveWorkingDirectory(ctx, config, sessionId),
    log,
  })

  const releases = []

  releases.push(ctx.llm.registerAdapter([provider], adapter))
  releases.push(ctx.llm.registerConfigurableProviders([{
    provider,
    displayName: 'Comate (Zulu)',
    settingsNs: SETTINGS_NS,
    settingsPath: [],
    declared: false,
  }]))

  // The settings page resolves a provider's row by the namespace the Loader
  // actually serves, which is the entry id rather than the name declared above.
  const settingsNs = ctx?.fiber?.entry?.options?.id ?? SETTINGS_NS
  releases.push(ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    const roster = await fetchModels({
      credential: readCredential(),
      userAgent: attribution()['user-agent'],
      zuluVersion: ZULU_VERSION,
      signal,
    })
    const models = selectModels(roster, normalizeModelIds(fieldOf(config, 'enabledModelIds')))
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    }))
  }))

  const routes = buildRoutes({
    log,
    ctx,
    settingsNs,
    readEnabled: () => normalizeModelIds(fieldOf(config, 'enabledModelIds')),
    describeZuluBin: () => resolveZuluBin({ zuluBin: fieldOf(config, 'zuluBin') }) ?? null,
    serverState: () => (server === undefined ? null : { port: server.port ?? null, auth: server.authKind }),
  })

  // The credit readout is also exposed as a tool whose surface is separate from
  // the model route: asking "how much have I used today" must not require the
  // picker to be switched to Comate first.
  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools')
    if (tools === undefined) return
    try {
      releases.push(tools.register(buildUsageTool({ readCredential, userAgent: attribution()['user-agent'] })))
      log('registered the comate_usage tool')
    } catch (error) {
      log(`comate_usage tool unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    if (webServer === undefined) return
    let mounted = 0
    for (const route of routes) {
      try {
        releases.push(webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
        mounted += 1
      } catch (error) {
        log(`route ${route.path} unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    log(`mounted ${mounted} route(s) under ${ROUTE_PREFIX}`)
  })

  ctx.effect(() => () => {
    for (const release of releases.splice(0)) {
      try {
        release()
      } catch {
        // A host that already reclaimed the registration is not a failure.
      }
    }
    void server?.stop()
  })

  log(`provider "${provider}" registered (settings namespace ${settingsNs})`)
}

/**
 * Resolve the directory one turn runs in.
 *
 * Precedence: the configured override, then the session's committed workspace,
 * then the harness default, then the host process directory. Comate needs a
 * real directory because it indexes the repository before answering.
 *
 * @param ctx - the Cordis context.
 * @param config - plugin config, which may carry an override.
 * @param sessionId - the session whose workspace should be used.
 * @returns an existing directory path.
 */
function resolveWorkingDirectory(ctx, config, sessionId) {
  const configured = (fieldOf(config, 'workingDirectory') ?? '').trim()
  if (configured !== '') return configured

  const workingDirectory = ctx.get('workingDirectory')
  if (sessionId !== undefined) {
    const session = ctx.get('sessions')?.get(sessionId)
    if (session !== undefined) {
      const directory = workingDirectory?.get(session)
      if (typeof directory === 'string' && directory !== '') return directory
    }
  }

  const fallback = workingDirectory?.defaultDirectory
  return typeof fallback === 'string' && fallback !== '' ? fallback : process.cwd()
}

/**
 * Build the HTTP surface.
 *
 * Everything here is a read of process state, the credential file, and two
 * short-lived upstream caches — except `__save`, which writes one settings
 * field and nothing else. No route can mutate the Comate install.
 *
 * @param options - log sink, settings namespace, and lazy state readers.
 * @returns the routes to mount.
 */
function buildRoutes(options) {
  const { log, ctx, settingsNs, readEnabled, describeZuluBin, serverState } = options

  /**
   * Wrap one read-only handler in the guards every route shares.
   *
   * The guards run in a fixed order — method, then loopback — so a request from
   * another origin learns nothing beyond "not allowed" even when it also used
   * the wrong method.
   *
   * @param run - the route's own body.
   * @returns a request handler.
   */
  const read = (run) => async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    if (!requireLoopback(req, res)) return
    try {
      await run(req, res)
    } catch (error) {
      log(`route ${req.url ?? '?'} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500)
    }
  }

  /**
   * Wrap the one mutating handler in the same guards, plus a body read.
   *
   * The body is capped because the only legitimate payload is a list of model
   * ids: anything larger is either a mistake or an attempt to make the host
   * allocate on someone else's behalf.
   *
   * @param run - the route's own body, receiving the parsed JSON.
   * @returns a request handler.
   */
  const write = (run) => async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    if (!requireLoopback(req, res)) return
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, { error: error instanceof Error ? error.message : 'invalid body' }, 400)
      return
    }
    try {
      const { status, body: payload } = await run(body)
      sendJson(res, payload, status)
    } catch (error) {
      log(`route ${req.url ?? '?'} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, { error: 'internal error' }, 500)
    }
  }

  return [
    {
      path: `${ROUTE_PREFIX}/status`,
      handler: read((req, res) => {
        sendJson(res, {
          version: VERSION,
          provider,
          credential: describeCredential(readCredential()),
          zuluBin: describeZuluBin(),
          server: serverState(),
        })
      }),
    },
    {
      // The settings card's first read: the roster it renders checkboxes for,
      // the selection it should show ticked, and which ids the picker is really
      // offering. The card cannot compute the last one itself because an empty
      // or stale selection falls back to the whole roster.
      path: `${ROUTE_PREFIX}/state`,
      handler: read(async (req, res) => {
        const credential = readCredential()
        const roster = await fetchModels({
          credential,
          userAgent: attribution()['user-agent'],
          zuluVersion: ZULU_VERSION,
        })
        const enabledIds = readEnabled()
        sendJson(res, {
          signedIn: credential !== undefined,
          credential: describeCredential(credential),
          settings: { namespace: SETTINGS_NS, servedAs: settingsNs, writableFields: WRITABLE_FIELDS },
          roster: roster.map((model) => ({
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
            ...(model.ratio === undefined ? {} : { ratio: model.ratio }),
          })),
          enabledModelIds: enabledIds,
          visibleModelIds: visibleModelIds(roster, enabledIds),
        })
      }),
    },
    {
      path: `${ROUTE_PREFIX}/models`,
      handler: read(async (req, res) => {
        const credential = readCredential()
        const roster = await fetchModels({
          credential,
          userAgent: attribution()['user-agent'],
          zuluVersion: ZULU_VERSION,
        })
        const models = selectModels(roster, readEnabled())
        sendJson(res, { signedIn: credential !== undefined, models })
      }),
    },
    {
      path: `${ROUTE_PREFIX}/usage`,
      handler: read(async (req, res) => {
        const credential = readCredential()
        const quota = await fetchQuota({ credential, userAgent: attribution()['user-agent'] })
        // The credit endpoint returns nothing for a public SaaS account, so the
        // real spend is reported from the CLI's own session store alongside it.
        const roster = await fetchModels({
          credential,
          userAgent: attribution()['user-agent'],
          zuluVersion: ZULU_VERSION,
        })
        sendJson(res, {
          credential: describeCredential(credential),
          quota,
          usage: readUsage({ roster }),
        })
      }),
    },
    {
      path: `${ROUTE_PREFIX}/refresh`,
      handler: read((req, res) => {
        invalidateComateCaches()
        log('caches invalidated on request')
        sendJson(res, { ok: true })
      }),
    },
    {
      // The only write. It answers 503 (not 404) when this fiber has no
      // settings service, because the card reads a 404 as "no such route on
      // this host" and falls back to an unverified scope write.
      path: `${ROUTE_PREFIX}/__save`,
      handler: write(async (body) => saveFieldOutcome(ctx.get('settings'), body, {
        candidates: settingsCandidates(settingsNs),
      })),
    },
  ]
}

/**
 * The namespaces a save may land under, most specific first.
 *
 * The Host keys a plugin's settings document by the Loader entry id, which is
 * usually the package name but can differ (a row aliased in the profile patch,
 * or a test harness mounting the plugin directly). Both spellings are tried so
 * a save works either way, but only exact matches are accepted.
 *
 * @param settingsNs - the namespace this instance registered under.
 * @returns the namespaces to try.
 */
function settingsCandidates(settingsNs) {
  const candidates = []
  for (const name of [settingsNs, SETTINGS_NS, `include:${SETTINGS_NS}`]) {
    if (typeof name === 'string' && name !== '' && !candidates.includes(name)) candidates.push(name)
  }
  return candidates
}

/** Largest body the one write route will read. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read and parse a JSON request body.
 *
 * @param req - the incoming request.
 * @returns the parsed value.
 * @throws when the body is oversized, unparseable, or not an object.
 */
async function readJsonBody(req) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('body too large')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new Error('empty body')
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('body is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('body must be a JSON object')
  }
  return value
}

/** The Host services this plugin cannot mount without. */
export const inject = ['llm']

/** The plugin name the Loader keys this entry by. */
export const name = 'dsh-connect-comate'
