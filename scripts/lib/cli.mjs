// Small helpers shared by the script entry points.
import { pathToFileURL } from 'node:url'

export function isMain(metaUrl) {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

// Runs main() and turns any thrown error into {"error": "..."} with exit code 2.
// main() returns {output, exitCode}.
export async function runCli(main, usage) {
  try {
    const { output, exitCode = 0 } = await main()
    if (output !== undefined) {
      if (typeof output === 'string') process.stdout.write(output.endsWith('\n') ? output : `${output}\n`)
      else printJson(output)
    }
    process.exitCode = exitCode
  } catch (e) {
    printJson({ error: e.message, ...(e.usage || e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? { usage } : {}) })
    process.exitCode = 2
  }
}

export function usageError(message) {
  const e = new Error(message)
  e.usage = true
  return e
}

export function parseBool(value, name) {
  if (value === undefined) return undefined
  const v = String(value).toLowerCase()
  if (v === 'true') return true
  if (v === 'false') return false
  throw usageError(`${name} must be true or false, got "${value}"`)
}

export function parseRepo(nameWithOwner) {
  const [owner, name] = String(nameWithOwner || '').split('/')
  if (!owner || !name) throw usageError(`repo must look like owner/name, got "${nameWithOwner}"`)
  return { owner, name }
}
