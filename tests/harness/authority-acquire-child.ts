/**
 * Child process for the two-process authority race test (P0-F section G). NOT production code.
 *
 * Run as: node tests/harness/authority-acquire-child.ts <lockPath> <authorityModulePath>
 *
 * It loads the REAL authority module (via a dynamic import of an absolute path — dynamic so
 * `tsc` never sees a .ts-extension specifier) and attempts to acquire the marker, printing
 * ACQUIRED or DENIED. Node runs this .ts directly via native type-stripping; no bundler,
 * no network. Two of these racing the same path must yield exactly one ACQUIRED.
 */
const [, , lockPath, modPath] = process.argv

import(modPath).then((mod) => {
  const meta = mod.makeAuthorityMetadata({ mode: 'PAPER_TRADE' })
  const res = mod.acquireExecutionAuthority(meta, { lockPath })
  // Deliberately DO NOT release: the winner keeps the marker so the parent can inspect it.
  process.stdout.write(res.acquired ? 'ACQUIRED' : 'DENIED')
}).catch((e: unknown) => {
  process.stdout.write('ERROR:' + (e instanceof Error ? e.message : String(e)))
  process.exitCode = 1
})
