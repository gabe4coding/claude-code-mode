// The runner of the tests/*.check.mjs scripts: one line per test, a summary,
// and exit code 1 when a test fails.

export const runChecks = tests => {
  let failed = 0
  for (const [name, fn] of Object.entries(tests)) {
    try {
      fn()
      console.log(`pass  ${name}`)
    } catch (err) {
      failed++
      console.log(`FAIL  ${name}\n${err.message}`)
    }
  }
  console.log(failed === 0 ? 'all passed' : `${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
}
