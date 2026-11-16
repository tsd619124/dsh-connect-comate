/**
 * Test-only module redirection.
 *
 * The plugin declares `@deepseek-ai/dsh-llm` and `@deepseek-ai/schemastery` as
 * peer dependencies: at runtime the Host resolves them from its own install.
 * Nothing is bundled here, so a plain `node` run of the plugin cannot resolve
 * them at all.
 *
 * This loader supplies the two seams the tests need without putting anything in
 * the package that would later shadow the Host's real modules:
 *
 * - `schemastery` resolves to the installed copy, so Config is the real Schema.
 * - `dsh-llm` resolves to a fixture that mirrors only the API surface the
 *   plugin imports, matching the real contracts it must satisfy.
 *
 * Register it with `node --import ./test/register-loader.mjs`.
 *
 * @module dsh-connect-comate/test/loader
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const fixture = (name) => pathToFileURL(join(here, 'fixtures', name)).href

/** Where the Host's own `schemastery` copy normally lives. */
const PROFILE_SCHEMASTERY = join(
  process.env.HOME ?? '',
  '.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
)

/**
 * Resolve the plugin's peer imports to local fixtures.
 *
 * @param specifier - the import as written.
 * @param context - Node's resolution context.
 * @param nextResolve - the default resolver.
 * @returns the resolved URL.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: fixture('dsh-llm.js'), shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/schemastery') {
    if (existsSync(PROFILE_SCHEMASTERY)) {
      return { url: pathToFileURL(PROFILE_SCHEMASTERY).href, shortCircuit: true }
    }
    throw new Error('test/loader: @deepseek-ai/schemastery is not installed in the DSH profile')
  }
  return await nextResolve(specifier, context)
}
