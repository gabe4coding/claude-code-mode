// The tools this plugin registers: each one's description, input schema and
// place (isDeferred: behind ToolSearch until the model loads it). The
// registration, the full ids that hooks match on (TOOL) and the typed input
// of a call (parseInput) all come from this table.
// tests/code.check.mjs fails when a file in hooks/ or tests/ types out a
// full id.

import { SAVE_FUNCTION_DESCRIPTION } from './functions'
import { ADD_HINT_DESCRIPTION, EDIT_HINT_DESCRIPTION, REMOVE_HINT_DESCRIPTION } from './hints'
import { RUN_DESCRIPTION, SEARCH_DESCRIPTION } from './protocol'

/** The tools search_tools returns when the model gives no limit. */
export const SEARCH_LIMIT = 15

type Property =
  | { type: 'string'; description: string; enum?: readonly string[] }
  | { type: 'number'; description: string }
  | { type: 'array'; items: { type: 'string' }; description: string }

type ToolSpec = {
  description: string
  isDeferred: boolean
  properties: Record<string, Property>
  required: readonly string[]
}

const str = (description: string) => ({ type: 'string', description }) as const

const HINT_PATH = str('The hint file, from "[<scope> hint: <path>]".')
const HINT_WHY = str('What the hint says and what the tool does now, in one sentence.')

export const TOOLS = {
  run_code: {
    description: RUN_DESCRIPTION,
    isDeferred: false,
    properties: { code: str('Body of an async JavaScript function.') },
    required: ['code'],
  },
  search_tools: {
    description: SEARCH_DESCRIPTION,
    isDeferred: false,
    properties: {
      query: str('Keywords; empty lists every MCP tool.'),
      limit: { type: 'number', description: `Most tools to return (default ${SEARCH_LIMIT}).` },
    },
    required: ['query'],
  },
  add_hint: {
    description: ADD_HINT_DESCRIPTION,
    isDeferred: true,
    properties: {
      server: str(
        'The MCP server: its name as /mcp lists it ("claude.ai Datadog") or the <server> part of mcp__<server>__<tool>.',
      ),
      text: str('The hint: one short, factual sentence.'),
      why: str('What failed before and what worked, in one sentence.'),
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: tool names on that server (globs allowed) when the hint is for some tools only.',
      },
      scope: { type: 'string', enum: ['user', 'project'], description: 'Default "user".' },
    },
    required: ['server', 'text', 'why'],
  },
  remove_hint: {
    description: REMOVE_HINT_DESCRIPTION,
    isDeferred: true,
    properties: { path: HINT_PATH, text: str('The hint to remove, as shown.'), why: HINT_WHY },
    required: ['path', 'text', 'why'],
  },
  edit_hint: {
    description: EDIT_HINT_DESCRIPTION,
    isDeferred: true,
    properties: {
      path: HINT_PATH,
      text: str('The hint to change, as shown.'),
      new_text: str('The corrected hint: one short, factual sentence.'),
      why: HINT_WHY,
    },
    required: ['path', 'text', 'new_text', 'why'],
  },
  save_function: {
    description: SAVE_FUNCTION_DESCRIPTION,
    isDeferred: true,
    properties: {
      name: str('A JavaScript name: programs call it as lib.<name>(args).'),
      description: str('What it returns, in one sentence.'),
      code: str(
        'An async function expression with one argument, such as async ({ cloudId, jql }) => { ... }. It can use call, sleep and the other run_code functions.',
      ),
      why: str('Which task it did and why the task comes back, in one sentence.'),
    },
    required: ['name', 'description', 'code', 'why'],
  },
} as const satisfies Record<string, ToolSpec>

export type ToolName = keyof typeof TOOLS

/** The short names, as the model reads them in text. */
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[]

/** The full id of each tool, as a tool.call or ui.render hook matches it. */
export const TOOL = Object.fromEntries(TOOL_NAMES.map(name => [name, `mcp__code-mode__${name}`])) as {
  readonly [N in ToolName]: `mcp__code-mode__${N}`
}

/** The spec of `$.tool.register` for one tool. */
export const registration = (name: ToolName) => {
  const { description, isDeferred, properties, required } = TOOLS[name]
  return { name, description, isDeferred, inputSchema: { type: 'object', properties, required } } as const
}

type ValueOf<P> = P extends { type: 'number' } ? number | undefined : P extends { type: 'array' } ? string[] : string

/** The input of one tool, each value of the type its schema gives. */
export type InputOf<N extends ToolName> = {
  -readonly [K in keyof (typeof TOOLS)[N]['properties']]: ValueOf<(typeof TOOLS)[N]['properties'][K]>
}

/**
 * The model's input to tool `name`. The schema is advice to the model, not a
 * check, so a value of another type becomes '' (a string), [] (an array) or
 * undefined (a number). A number may come as a string ("5"). A string is not
 * trimmed.
 */
export const parseInput = <N extends ToolName>(name: N, e: object): InputOf<N> => {
  const raw = e as Record<string, unknown>
  const properties: Record<string, Property> = TOOLS[name].properties
  const input: Record<string, unknown> = {}
  for (const [key, property] of Object.entries(properties)) {
    const v = raw[key]
    if (property.type === 'number') {
      const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN
      input[key] = Number.isFinite(n) ? n : undefined
    } else if (property.type === 'array')
      input[key] = Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
    else input[key] = typeof v === 'string' ? v : ''
  }
  return input as InputOf<N>
}
