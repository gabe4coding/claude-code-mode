// Where code-mode keeps its files: the folder .claude/code-mode in HOME (the
// person's) and in the project root. Every path into it is made here, so the
// loaders and the hint-file guard always name the same folders.
// tests/code.check.mjs fails when another file in hooks/ types one out.

const APP = 'code-mode'
const HINTS = 'hints'
const FUNCTIONS = 'functions'

/** An absolute path with empty, `.` and `..` parts resolved. */
export const normalizePath = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/**
 * A path in code-mode's folder under `root`: HOME or the project root. It is
 * normalized, as isUnder needs: HOME can end in a slash or hold a double one.
 */
export const codeModePath = (root: string, ...parts: string[]): string =>
  normalizePath([root, '.claude', APP, ...parts].join('/'))

/** The hint folder under HOME or the project root. */
export const hintsFolder = (root: string): string => codeModePath(root, HINTS)

/** The saved-function folder under HOME. */
export const functionsFolder = (home: string): string => codeModePath(home, FUNCTIONS)

/**
 * The folders whose files steer the model, as written: the person's and the
 * project's hints (the project's even while projectHints is off, so none can
 * be planted to load later), and the person's saved functions. The model's
 * file tools may not write them. An empty root has none.
 * The plugin's own folder holds its code and its bundled hints: it is guarded
 * where Claude Code installed it, under HOME. A folder loaded with --plugin-dir
 * is the person's own checkout, which they edit.
 */
export const guardedDirs = (home: string, project: string, pluginRoot = ''): string[] => {
  const plugin = normalizePath(pluginRoot)
  const plugins = normalizePath(`${home}/.claude/plugins`)
  return [
    ...(home ? [hintsFolder(home), functionsFolder(home)] : []),
    ...(project ? [hintsFolder(project)] : []),
    ...(home && plugin.startsWith(`${plugins}/`) ? [plugin] : []),
  ]
}
