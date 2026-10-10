// A fake MCP server (stdio, JSON-RPC lines) for the output projection bench.
// Every tools/call is appended to $BENCH_LOG as one JSON line.
//
//   BENCH_LOG=/tmp/calls.jsonl node bench/fake-server.mjs

import fs from 'node:fs'
import readline from 'node:readline'
import { DEPLOYS, ISSUES, MESSAGES, logsText } from './data.mjs'

const LOG = process.env.BENCH_LOG
let tickets = 0

const obj = (properties, required = []) => ({ type: 'object', properties, required })
const TOOLS = [
  {
    name: 'search_messages',
    description: 'Read the messages of a Slack channel, newest last. Pages of at most 100 messages: pass response_metadata.next_cursor as cursor for the next page.',
    inputSchema: obj({ channel: { type: 'string', description: 'Channel name, for example "#release".' }, cursor: { type: 'string' }, limit: { type: 'number', description: 'At most 100 (default 100).' } }, ['channel']),
  },
  {
    name: 'list_issues',
    description: 'List all issues of a project in the issue tracker.',
    inputSchema: obj({ project: { type: 'string', description: 'Project key, for example "OPS".' } }, ['project']),
  },
  {
    name: 'query_logs',
    description: 'Count log events by service, host and status for a time range. Returns a table as text.',
    inputSchema: obj({ from: { type: 'string', description: 'For example "now-24h".' }, to: { type: 'string', description: 'For example "now".' } }, ['from']),
  },
  {
    name: 'create_ticket',
    description: 'Create an incident ticket.',
    inputSchema: obj({ title: { type: 'string' }, description: { type: 'string' } }, ['title']),
  },
  {
    name: 'get_deploys',
    description: 'List all deploys of all apps on one day.',
    inputSchema: obj({ date: { type: 'string', description: 'YYYY-MM-DD' } }, ['date']),
  },
]

const text = t => ({ content: [{ type: 'text', text: t }] })
const json = v => text(JSON.stringify(v))
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true })

const handlers = {
  search_messages: ({ channel, cursor, limit }) => {
    if (String(channel).replace(/^#/, '') !== 'release') return fail(`channel_not_found: ${channel}`)
    const size = Math.min(100, Math.max(1, Number(limit) || 100))
    const start = cursor ? Number(Buffer.from(String(cursor), 'base64').toString('utf8').replace('offset:', '')) : 0
    const page = MESSAGES.slice(start, start + size)
    const next = start + size < MESSAGES.length ? Buffer.from(`offset:${start + size}`).toString('base64') : ''
    return json({ ok: true, channel: { id: 'C0BENCH01', name: 'release' }, messages: page, has_more: next !== '', response_metadata: { next_cursor: next } })
  },
  list_issues: ({ project }) => (project === 'OPS' ? json({ total: ISSUES.length, issues: ISSUES }) : fail(`project not found: ${project}`)),
  query_logs: () => text(logsText()),
  create_ticket: ({ title }) => {
    tickets++
    return json({ created: { id: String(90000 + tickets), key: `INC-${100 + tickets}`, title }, links: { self: `https://tracker.example.com/INC-${100 + tickets}` } })
  },
  get_deploys: ({ date }) => (date === '2026-10-09' ? json({ date, count: DEPLOYS.length, deploys: DEPLOYS }) : json({ date, count: 0, deploys: [] })),
}

const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)

readline.createInterface({ input: process.stdin }).on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // a notification
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.method === 'initialize') {
    return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bench', version: '1.0.0' } })
  }
  if (msg.method === 'ping') return reply({})
  if (msg.method === 'tools/list') return reply({ tools: TOOLS })
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {}
    const handler = handlers[name]
    const result = handler ? handler(args) : fail(`unknown tool: ${name}`)
    if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), tool: name, args, chars: result.content[0].text.length, isError: result.isError === true })}\n`)
    return reply(result)
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
})
