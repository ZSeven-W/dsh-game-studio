// Validates docs/TRACEABILITY.md: every file, test and npm script it points at
// must exist. The traceability table is only useful if it cannot silently drift
// away from the code, so this script is the guard.
//
//   node scripts/trace-check.mjs
//
// Exit 1 when a reference is missing.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const docPath = join(repo, 'docs', 'TRACEABILITY.md')
const doc = readFileSync(docPath, 'utf8')
const scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts ?? {}
const failures = []

const testRefs = [...doc.matchAll(/`(test\/[^`]+?\.mjs)::([^`]+)`/gu)]
for (const [, file, fragment] of testRefs) {
  // The doc explains the convention with a placeholder like 	est/<name>.mjs::….
  if (file.includes('<') || fragment.includes('<')) continue
  const path = join(repo, file)
  if (!existsSync(path)) { failures.push(`${file} does not exist`); continue }
  const text = readFileSync(path, 'utf8')
  if (!text.includes(fragment.trim())) failures.push(`${file} has no test containing "${fragment.trim()}"`)
}

const cmdRefs = [...doc.matchAll(/`(?:cmd:)?(npm run [a-z-]+)`/gu)]
for (const [, command] of cmdRefs) {
  const name = command.replace('npm run ', '')
  if (!scripts[name]) failures.push(`package.json has no script "${name}"`)
}

const fileRefs = [...doc.matchAll(/`((?:src|docs|scripts|test)\/[\w./-]+)`/gu)]
for (const [, relative] of fileRefs) {
  if (!existsSync(join(repo, relative))) failures.push(`${relative} does not exist`)
}

const summary = {
  doc: 'docs/TRACEABILITY.md',
  testRefs: testRefs.length,
  commandRefs: cmdRefs.length,
  fileRefs: fileRefs.length,
  failures,
}
if (failures.length === 0) {
  console.log(`traceability ok — ${summary.testRefs} test refs, ${summary.commandRefs} commands, ${summary.fileRefs} files`)
} else {
  console.log(`traceability FAILED — ${failures.length} broken reference(s)`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
}


