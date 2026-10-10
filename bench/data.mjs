// Fixed data for the output projection bench. Each task has traps that make a
// first filter miss: pages, nested fields, null fields, bots, text results,
// a sum that is not the largest row, results larger than 20,000 characters.
// All names are fake.

const rng = seed => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const rand = rng(20261010)
const pick = xs => xs[Math.floor(rand() * xs.length)]
const shuffle = xs => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const PEOPLE = ['alice', 'bruno', 'chen', 'dana', 'emil', 'farah', 'goran', 'hana']
const APPS = ['checkout', 'search', 'booking', 'payments', 'profile', 'notify']
const person = name => ({ id: `U${(PEOPLE.indexOf(name) + 1).toString().padStart(4, '0')}`, name, real_name: name[0].toUpperCase() + name.slice(1) })

// --- messages in #release: 250, in pages of at most 100 -------------------
const FILLER = [
  a => `deploy of ${a} done`,
  a => `${a} looks fine after the release`,
  a => `starting the ${a} release train`,
  a => `${a} canary at 10%`,
  a => `who owns the ${a} alert?`,
  a => `${a} build is green`,
]
const planted = [
  ...Array.from({ length: 9 }, (_, i) => ({ by: 'dana', text: i % 2 ? `Rollback of ${pick(APPS)} started` : `rollback ${pick(APPS)} to the last version` })),
  ...Array.from({ length: 5 }, () => ({ by: 'alice', text: `rollback done for ${pick(APPS)}` })),
  ...Array.from({ length: 4 }, () => ({ by: 'chen', text: `is a ROLLBACK needed for ${pick(APPS)}?` })),
  ...Array.from({ length: 12 }, () => ({ bot: 'deploybot', text: `Automatic rollback: ${pick(APPS)} health check failed` })),
  ...Array.from({ length: 4 }, () => ({ by: 'emil', text: 'see OPS-77 for the details' })),
  ...Array.from({ length: 2 }, () => ({ by: 'farah', text: 'OPS-140 is the same problem' })),
  { by: 'goran', text: 'linked OPS-17' },
  ...Array.from({ length: 6 }, () => ({ by: 'hana', text: 'OPS-50 again' })),
]
const rawMessages = shuffle([
  ...planted,
  ...Array.from({ length: 250 - planted.length }, () => ({ by: pick(PEOPLE), text: pick(FILLER)(pick(APPS)) })),
])
export const MESSAGES = rawMessages.map((m, i) => {
  const ts = `${1760000000 + i * 97}.${String(100000 + i).slice(1)}`
  const base = { type: 'message', ts, text: m.text, reactions: rand() < 0.3 ? [{ name: pick(['eyes', 'white_check_mark', 'rocket']), count: 1 + Math.floor(rand() * 4) }] : [] }
  return m.bot ? { ...base, subtype: 'bot_message', user: null, bot_profile: { name: m.bot } } : { ...base, user: person(m.by) }
})

// --- issues in project OPS: 180 ----------------------------------------------
const OPEN = ['To Do', 'In Progress']
const TARGETS = [17, 42, 77, 103, 140, 166] // Highest, open, no assignee
const DECOYS = [8, 61, 120, 150] // Highest, open, assigned; or Highest, Done, no assignee
export const ISSUES = Array.from({ length: 180 }, (_, i) => {
  const n = i + 1
  let status = pick([...OPEN, 'Done', 'Closed'])
  let priority = pick(['Highest', 'High', 'Medium', 'Medium', 'Low'])
  let assignee = rand() < 0.35 ? null : { accountId: `acc-${n}`, displayName: pick(PEOPLE) }
  if (TARGETS.includes(n)) [status, priority, assignee] = [pick(OPEN), 'Highest', null]
  else if (DECOYS.includes(n)) [status, priority, assignee] = n % 2 ? ['Done', 'Highest', null] : ['In Progress', 'Highest', { accountId: `acc-${n}`, displayName: 'bruno' }]
  else if (priority === 'Highest' && OPEN.includes(status) && assignee === null) assignee = { accountId: `acc-${n}`, displayName: pick(PEOPLE) }
  return {
    id: String(10000 + n),
    key: `OPS-${n}`,
    fields: {
      summary: `${pick(APPS)}: ${pick(['latency', 'errors', 'timeouts', 'memory', 'config drift'])} after ${pick(['deploy', 'traffic peak', 'migration'])}`,
      status: { name: status, statusCategory: { key: OPEN.includes(status) ? 'indeterminate' : 'done' } },
      priority: { name: priority },
      assignee,
      labels: rand() < 0.4 ? [pick(['oncall', 'customer', 'tech-debt'])] : [],
      created: new Date(Date.UTC(2026, 8, 1 + (n % 30))).toISOString(),
    },
  }
})

// --- error logs for the last 24 hours, as text ------------------------------
// payments has the largest sum; search has the largest single row.
const ERRORS = { payments: [520, 480, 470, 470], search: [910, 230, 210, 150], checkout: [300, 290, 280, 270], booking: [200, 190, 180, 170], profile: [90, 80, 70, 60], notify: [40, 30, 20, 10] }
export const LOG_ROWS = APPS.flatMap(app =>
  [1, 2, 3, 4].flatMap(h => [
    [app, `${app}-h${h}`, 'info', 2000 + Math.floor(rand() * 9000)],
    [app, `${app}-h${h}`, 'warn', 100 + Math.floor(rand() * 900)],
    [app, `${app}-h${h}`, 'error', ERRORS[app][h - 1]],
  ]),
)
export const logsText = () =>
  [
    '<METADATA>',
    `<displayed_columns>4</displayed_columns>`,
    `<displayed_rows>${LOG_ROWS.length}</displayed_rows>`,
    `<total_rows>${LOG_ROWS.length}</total_rows>`,
    '</METADATA>',
    '<DATA>',
    'service\thost\tstatus\tcount',
    ...LOG_ROWS.map(r => r.join('\t')),
    '</DATA>',
  ].join('\n')

// --- deploys on 2026-10-09: 400 ----------------------------------------------
// booking has the most failed production deploys (7). search has more failed
// deploys in all envs (9), checkout more rolled_back ones in production (8).
const plantedDeploys = [
  ...Array.from({ length: 4 }, () => ({ app: 'booking', env: 'prod-eu', status: 'failed' })),
  ...Array.from({ length: 3 }, () => ({ app: 'booking', env: 'prod-us', status: 'failed' })),
  ...Array.from({ length: 5 }, () => ({ app: 'search', env: 'staging', status: 'failed' })),
  ...Array.from({ length: 4 }, () => ({ app: 'search', env: 'prod-us', status: 'failed' })),
  ...Array.from({ length: 8 }, () => ({ app: 'checkout', env: pick(['prod-eu', 'prod-us']), status: 'rolled_back' })),
  ...Array.from({ length: 3 }, () => ({ app: 'payments', env: 'prod-eu', status: 'failed' })),
]
export const DEPLOYS = shuffle([
  ...plantedDeploys,
  ...Array.from({ length: 400 - plantedDeploys.length }, () => ({ app: pick(APPS), env: pick(['prod-eu', 'prod-us', 'staging', 'dev']), status: 'success' })),
]).map((d, i) => ({
  id: `dep-${5000 + i}`,
  app: d.app,
  version: `v${1 + Math.floor(rand() * 9)}.${Math.floor(rand() * 20)}.${Math.floor(rand() * 10)}`,
  env: d.env,
  status: d.status,
  triggered_by: { login: pick(PEOPLE) },
  started_at: new Date(Date.UTC(2026, 9, 9, 0, 0, i * 200)).toISOString(),
  duration_s: 30 + Math.floor(rand() * 600),
}))

// --- the tasks and how to check an answer ------------------------------------
const has = (text, word) => text.toLowerCase().includes(word.toLowerCase())
const hasNumber = (text, n) => new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(text.replace(/(\d),(\d)/g, '$1$2'))

export const TASKS = [
  {
    id: 'messages',
    prompt: 'In the Slack channel #release (bench server), how many messages contain the word "rollback" in any case? And which person, not a bot, wrote the most of them?',
    check: a => hasNumber(a, 30) && has(a, 'dana'),
    expected: '30 messages; dana',
  },
  {
    id: 'issues',
    prompt: 'In the issue tracker project OPS (bench server), list the keys of all issues that are open (status "To Do" or "In Progress"), have priority "Highest", and have no assignee.',
    check: a => TARGETS.every(n => new RegExp(`OPS-${n}(?!\\d)`).test(a)) && !DECOYS.some(n => new RegExp(`OPS-${n}(?!\\d)`).test(a)),
    expected: TARGETS.map(n => `OPS-${n}`).join(', '),
  },
  {
    id: 'logs',
    prompt: 'From the logs of the bench server for the last 24 hours, which service had the most error logs, and how many error logs did it have in total?',
    check: a => has(a, 'payments') && hasNumber(a, 1940),
    expected: 'payments, 1940',
  },
  {
    id: 'ticket',
    prompt: 'Create one incident ticket on the bench server with the title "Checkout outage" and a one-line description. Tell me the key of the ticket.',
    check: (a, calls) => has(a, 'INC-101') && calls.filter(c => c.tool === 'create_ticket').length === 1,
    expected: 'INC-101, with one create_ticket call',
  },
  {
    id: 'deploys',
    prompt: 'On 2026-10-09, which app had the most failed deploys to production (bench server)? How many?',
    check: a => has(a, 'booking') && hasNumber(a, 7),
    expected: 'booking, 7',
  },
  {
    id: 'cross',
    prompt: 'Find the open OPS issues with priority "Highest" and no assignee (bench server). Which of these issues is mentioned most often in the Slack channel #release, and how many times?',
    check: a => /OPS-77(?!\d)/.test(a) && hasNumber(a, 4),
    expected: 'OPS-77, 4 times',
  },
]
