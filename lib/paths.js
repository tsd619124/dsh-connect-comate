/**
 * Where the Comate / Zulu pieces live on this machine, and where the sign-in
 * credential is read from.
 *
 * Everything here is READ-ONLY with respect to the Comate installation: the
 * plugin never writes into `/Applications/Comate.app`, never rewrites the CLI's
 * own credential files, and never touches the IDE's encrypted store. A missing
 * credential is reported, not repaired.
 *
 * @module dsh-connect-comate/paths
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Environment variable that overrides the Comate auth directory. */
export const COMATE_AUTH_DIR_ENV = 'COMATE_AUTH_DIR'

/** Environment variable that overrides the resolved license. */
export const COMATE_LICENSE_ENV = 'COMATE_LICENSE'

/**
 * Candidate locations of the `zulu` launcher, most specific first.
 *
 * The launcher inside the app bundle sets the two tree-sitter WASM variables
 * the CLI needs; a bare `bundle/index.js` does not, so the launcher is the only
 * entry point this plugin is willing to spawn.
 *
 * @param config - resolved plugin config, which may name an explicit binary.
 * @returns absolute candidate paths, in probe order.
 */
export function zuluCandidates(config) {
  const configured = typeof config?.zuluBin === 'string' ? config.zuluBin.trim() : ''
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((segment) => segment.length > 0)
    .map((segment) => join(segment, 'zulu'))
  return [
    ...(configured === '' ? [] : [configured]),
    join(homedir(), '.comate', 'zulu-cli', 'bin', 'zulu'),
    '/Applications/Comate.app/Contents/Resources/app/extensions/baiducomate.comate/dist/zulu-cli/bin/zulu',
    ...fromPath,
  ]
}

/**
 * The first existing `zulu` launcher, or `undefined` when Comate is absent.
 *
 * @param config - resolved plugin config.
 * @returns the absolute path of a regular file, or `undefined`.
 */
export function resolveZuluBin(config) {
  for (const candidate of zuluCandidates(config)) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not there; the next candidate may be.
    }
  }
  return undefined
}

/**
 * The directory holding the CLI's credential files.
 *
 * `zulu login` writes `cli-login.json` (SaaS license) and `login` (internal
 * access token) under this directory. `COMATE_AUTH_DIR` overrides it, which is
 * how the CLI itself relocates its own auth.
 *
 * @returns the absolute auth directory.
 */
export function authDir() {
  const override = (process.env[COMATE_AUTH_DIR_ENV] ?? '').trim()
  return override === '' ? join(homedir(), '.comate') : override
}

/**
 * Read one JSON credential file, returning `undefined` for anything unreadable.
 *
 * @param path - absolute file path.
 * @returns the parsed value, or `undefined`.
 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The sign-in credential the CLI leaves behind, with its provenance.
 *
 * Two shapes exist and both are honoured, because both are what the real CLI
 * writes: `cli-login.json` carries `{platform, license, displayName}` for the
 * SaaS edition, and a bare `login` file carries an internal access token.
 *
 * @returns `{kind: 'license'|'token', value: string, source: string}` or
 *   `undefined` when nobody has signed in.
 */
export function readCredential() {
  const dir = authDir()
  const override = (process.env[COMATE_LICENSE_ENV] ?? '').trim()
  if (override !== '') {
    return { kind: 'license', value: override, source: `${COMATE_LICENSE_ENV}` }
  }

  const cliLoginPath = join(dir, 'cli-login.json')
  const cliLogin = readJson(cliLoginPath)
  const license = typeof cliLogin?.license === 'string' ? cliLogin.license.trim() : ''
  if (license !== '') {
    return {
      kind: 'license',
      value: license,
      source: cliLoginPath,
      ...(typeof cliLogin?.platform === 'string' ? { platform: cliLogin.platform } : {}),
      ...(typeof cliLogin?.displayName === 'string' ? { displayName: cliLogin.displayName } : {}),
    }
  }

  const loginPath = join(dir, 'login')
  try {
    const token = readFileSync(loginPath, 'utf8').trim()
    if (token !== '') return { kind: 'token', value: token, source: loginPath }
  } catch {
    // No internal sign-in either.
  }

  return undefined
}

/**
 * Reduce a credential to the public description the status route reports.
 *
 * The value itself never leaves the Host: the browser gets the kind, the origin
 * file, and the account name, which is everything a card needs to say "signed
 * in as X" or "not signed in yet".
 *
 * @param credential - the credential returned by {@link readCredential}.
 * @returns a credential-free summary.
 */
export function describeCredential(credential) {
  if (credential === undefined) {
    return {
      signedIn: false,
      kind: 'none',
      source: null,
      platform: null,
      displayName: null,
      hint: `没有找到 Comate CLI 登录凭证。在终端执行一次 \`zulu login\` 即可（或设置 ${COMATE_LICENSE_ENV}）。`,
    }
  }
  return {
    signedIn: true,
    kind: credential.kind,
    source: credential.source,
    platform: credential.platform ?? null,
    displayName: credential.displayName ?? null,
    hint: null,
  }
}

/**
 * Whether a directory exists and is usable as a working directory.
 *
 * @param path - candidate directory.
 * @returns `true` when it exists.
 */
export function directoryExists(path) {
  return existsSync(path)
}
