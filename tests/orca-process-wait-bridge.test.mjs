import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, test } from 'node:test'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const home = homedir()
const agentDir = process.env.PI_AGENT_DIR || join(home, '.pi/agent')

function resolvePiBin() {
  if (process.env.PI_BIN) return process.env.PI_BIN
  const localBin = join(home, '.local/bin/pi')
  if (existsSync(localBin)) return localBin
  try {
    return execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()
  } catch {
    return 'pi'
  }
}

function resolvePiPackageDir(piBin) {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR
  const candidates = []
  try {
    const resolvedBin = realpathSync(piBin)
    try {
      const text = readFileSync(resolvedBin, 'utf8')
      const match = text.match(/([^\s"']+?\/@earendil-works\/pi-coding-agent)\b/)
      if (match) candidates.push(match[1])
    } catch {}
    let dir = dirname(resolvedBin)
    for (let i = 0; i < 6; i++) {
      candidates.push(join(dir, 'lib/node_modules/@earendil-works/pi-coding-agent'))
      candidates.push(join(dir, 'node_modules/@earendil-works/pi-coding-agent'))
      if (existsSync(join(dir, 'package.json'))) {
        candidates.push(dir)
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {}
  const piNodeRoot = join(home, '.local/share/pi-node')
  if (existsSync(piNodeRoot)) {
    for (const entry of readdirSync(piNodeRoot)) {
      candidates.push(join(piNodeRoot, entry, 'lib/node_modules/@earendil-works/pi-coding-agent'))
    }
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    if (globalRoot) candidates.push(join(globalRoot, '@earendil-works/pi-coding-agent'))
  } catch {}
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        const req = createRequire(join(candidate, 'package.json'))
        req.resolve('jiti')
        return candidate
      } catch {}
    }
  }
  throw new Error('Unable to locate @earendil-works/pi-coding-agent with jiti. Set PI_CODING_AGENT_DIR.')
}

const piBin = resolvePiBin()
const piDir = resolvePiPackageDir(piBin)
const require = createRequire(join(piDir, 'package.json'))
const { createJiti } = require('jiti')
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false })

const bridgePath = join(repoRoot, 'extensions/orca-process-wait-bridge.ts')
const statusPath = process.env.ORCA_AGENT_STATUS_PATH || join(agentDir, 'extensions/orca-agent-status.ts')
const backgroundPath = process.env.ORCA_BACKGROUND_WORK_PATH || join(home, '.orca/pi-native-chat/orca-background-work.ts')
const processesPath =
  process.env.PI_PROCESSES_PATH ||
  join(agentDir, 'npm/node_modules/@aliou/pi-processes/extensions/processes/index.ts')

const bridge = jiti(bridgePath).default
const livenessKey = Symbol.for('@agegr/pi-web/session-liveness/v1')
const globals = [livenessKey, Symbol.for('orca.pi-process-wait-bridge/v1'), Symbol.for('orca.omp.status-session-owners'), '__orcaPiSubagents', '__orcaPiStatusPostQueue']
const busChannels = ['processes:started', 'processes:changed', 'processes:ended', 'processes:notification']
const baselineEnv = { ...process.env }

function extensionEnv(key) {
  return key.startsWith('ORCA_') || ['PI_SUBAGENT_CHILD', 'PI_SUBAGENT_PARENT_SESSION', '_'].includes(key)
}

beforeEach(() => {
  for (const key of Object.keys(process.env).filter(extensionEnv)) delete process.env[key]
})

afterEach(() => {
  for (const key of Object.keys(process.env).filter(extensionEnv)) delete process.env[key]
  for (const key of Object.keys(baselineEnv).filter(extensionEnv)) process.env[key] = baselineEnv[key]
  for (const key of globals) Reflect.deleteProperty(globalThis, key)
})

async function until(read, message, timeout = 3000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = read()
    if (value) return value
    assert.ok(Date.now() < deadline, message)
    await delay(10)
  }
}

function protocol() {
  const emitter = new EventEmitter()
  const events = {
    on(channel, fn) {
      emitter.on(channel, fn)
      return () => emitter.off(channel, fn)
    },
    emit: (channel, value) => emitter.emit(channel, value),
  }
  const list = new Map()
  const started = []
  const completed = []
  let listRequests = 0
  events.on('processes:request:list', ({ reply }) => {
    listRequests++
    reply(Array.from(list.values()))
  })
  events.on('subagent:async-started', (entry) => started.push(entry))
  events.on('subagent:async-complete', (entry) => completed.push(entry))
  return {
    events, list, started, completed,
    listenerCounts: () => busChannels.map((name) => emitter.listenerCount(name)),
    get listRequests() { return listRequests },
  }
}

function runner(protocol, sessionId = 'session-1', events = protocol.events) {
  const handlers = new Map()
  const statuses = []
  const context = {
    isIdle: () => true,
    ui: { setStatus: (key, text) => statuses.push({ key, text }) },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
    },
  }
  const api = {
    events,
    on(name, fn) {
      const group = handlers.get(name) ?? new Set()
      handlers.set(name, group)
      group.add(fn)
      return () => group.delete(fn)
    },
  }
  const emit = async (type, fields = {}) => {
    for (const fn of [...(handlers.get(type) ?? [])]) await fn({ type, ...fields }, context)
  }
  return {
    api, emit, context, statuses,
    status: (key) => statuses.findLast((entry) => entry.key === key)?.text,
    roster: () => JSON.parse(statuses.findLast((entry) => entry.key === 'orca-subagents')?.text ?? '{"subagents":[]}'),
    stop: (reason = 'quit', fields) => emit('session_shutdown', { reason, ...fields }),
    start: (reason = 'startup') => emit('session_start', { reason }),
    beginTurn: async () => {
      await emit('before_agent_start', { prompt: 'Check background work' })
      await emit('agent_start')
    },
    settleTurn: async () => {
      await emit('agent_end', { messages: [{ role: 'assistant', stopReason: 'stop' }] })
      await emit('agent_settled')
    },
  }
}

const onceOnTurn = { on: 'turn', repeat: false, fired: false }

function job(id, { success = 'turn', failure = 'turn', killed = 'context', watches = [], status = 'running' } = {}) {
  return {
    id, name: `build ${id}`, command: 'make', status, exitCode: null, endReason: null,
    wake: { exitAttention: { success, failure, killed }, watches },
  }
}

function startJob(protocol, info) {
  protocol.list.set(info.id, info)
  protocol.events.emit('processes:started', info)
  protocol.events.emit('processes:changed', { reason: 'started' })
}

function endJob(protocol, info, { status = 'exited', exitCode = 0, endReason = 'exit' } = {}) {
  const ended = { ...info, status, exitCode, endReason }
  protocol.list.set(info.id, ended)
  protocol.events.emit('processes:ended', ended)
  protocol.events.emit('processes:changed', { reason: 'ended' })
}

async function terminal(t, options) {
  const posts = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    posts.push({ route: req.url, ...JSON.parse(body).payload })
    res.writeHead(200).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  process.env.ORCA_PANE_KEY = 'bridge-test-pane'
  process.env.ORCA_AGENT_HOOK_PORT = String(server.address().port)
  process.env.ORCA_AGENT_HOOK_TOKEN = 'bridge-test-token'
  const app = await integrated(t, options)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { ...app, posts, ended: () => posts.filter((post) => post.hook_event_name === 'agent_end') }
}

async function integrated(t, { native = false, bridgeFirst = false } = {}) {
  const protocolState = protocol()
  const app = runner(protocolState)
  let probeDir
  if (native) {
    probeDir = await mkdtemp(join(tmpdir(), 'orca-bridge-probe-'))
    process.env.ORCA_STRUCTURED_SESSION = '1'
    process.env.ORCA_PI_BACKGROUND_WORK_DIR = probeDir
  }
  if (bridgeFirst) bridge(app.api)
  jiti(statusPath).default(app.api)
  if (!bridgeFirst) bridge(app.api)
  if (native) jiti(backgroundPath).default(app.api)
  t.after(async () => {
    await app.stop()
    if (probeDir) await rm(probeDir, { recursive: true, force: true })
  })
  await app.start()
  return { ...app, protocol: protocolState, probeDir }
}

async function probe(dir, ready, nonce, answer) {
  assert.match(ready, /^ready:/)
  const instance = ready.slice('ready:'.length)
  await writeFile(join(dir, `${instance}.${nonce}.probe`), '')
  return until(() => answer()?.startsWith(`answer:${instance}:${nonce}:`) && answer(), `probe ${nonce} was not answered`)
}

test('terminal stays working through process wait and wake, then posts one final agent_end', async (t) => {
  // Run the bridge first to ensure completion still follows Orca's agent_start handler.
  const app = await terminal(t, { bridgeFirst: true })
  const { protocol } = app
  const info = job('one-shot')
  await app.beginTurn()
  startJob(protocol, info)
  await app.settleTurn()
  const working = await until(() => app.posts.find((post) => post.subagents?.some((entry) => entry.id === 'pi-process:one-shot')), 'working hook missing')
  assert.equal(working.route, '/hook/pi')
  assert.equal(working.hook_event_name, 'agent_start')
  assert.deepEqual(protocol.started, [{ id: 'pi-process:one-shot', runId: 'pi-process:one-shot', agent: 'process', description: 'build one-shot' }])
  assert.deepEqual(app.ended(), [])

  endJob(protocol, info)
  await tick()
  assert.deepEqual(protocol.completed, [])
  assert.deepEqual(app.ended(), [])
  const beforeWake = app.posts.length
  await app.beginTurn()
  await tick()
  assert.deepEqual(protocol.completed, [{ id: 'pi-process:one-shot', runId: 'pi-process:one-shot', success: true }])
  await until(() => app.posts.slice(beforeWake).find((post) => ['agent_start', 'subagents_update'].includes(post.hook_event_name) && !post.subagents), 'working process was not removed')
  assert.deepEqual(app.ended(), [])

  await app.settleTurn()
  const ended = await until(() => app.ended()[0], 'wake turn did not settle')
  assert.equal(ended.route, '/hook/pi')
  assert.equal(typeof ended.turn_completed_at, 'number')
  assert.equal(app.ended().length, 1)
})

test('terminal externally killed process releases after grace without a wake turn', async (t) => {
  const app = await terminal(t)
  const { protocol } = app
  const info = job('killed', { status: 'terminating' })
  await app.beginTurn()
  startJob(protocol, info)
  await app.settleTurn()
  await until(() => app.posts.find((post) => post.subagents?.length), 'terminating process was not tracked')
  endJob(protocol, info, { status: 'killed', exitCode: null, endReason: 'signal' })
  protocol.events.emit('processes:notification', { processId: info.id, attention: 'context' })
  await tick()
  assert.deepEqual(protocol.completed, [])
  assert.deepEqual(app.ended(), [])
  await until(() => app.ended()[0], 'killed process left Orca working after grace')
  assert.deepEqual(protocol.completed, [{ id: 'pi-process:killed', runId: 'pi-process:killed', success: false, state: 'stopped' }])
  assert.equal(app.ended().length, 1)
})

test('Native Chat publishes active work and a failed ending, with active then idle file probes', async (t) => {
  const app = await integrated(t, { native: true })
  const { protocol, probeDir } = app
  const info = job('failing', { status: 'terminate_timeout' })
  const ready = app.status('orca-background-work')
  await app.beginTurn()
  startJob(protocol, info)
  await app.settleTurn()
  await tick()
  assert.deepEqual(app.roster().subagents.map(({ id, agentType, state }) => ({ id, agentType, state })), [
    { id: 'pi-process:failing', agentType: 'process', state: 'working' },
  ])
  assert.match(await probe(probeDir, ready, 'while-running', () => app.status('orca-background-work')), /:active$/)

  endJob(protocol, info, { exitCode: 23 })
  protocol.events.emit('processes:notification', { processId: info.id, attention: 'turn' })
  // A wake can begin before the next deferred process-list read.
  await app.beginTurn()
  await tick()
  await app.settleTurn()
  assert.deepEqual(app.roster(), { subagents: [], ended: { 'pi-process:failing': 'failed' } })
  assert.match(await probe(probeDir, ready, 'after-wake', () => app.status('orca-background-work')), /:idle$/)
})

test('failure-only exits and repeating or context watches do not hold persistent servers', async (t) => {
  const app = await terminal(t)
  await app.beginTurn()
  startJob(app.protocol, job('persistent', { success: 'context' }))
  startJob(app.protocol, job('repeat', { success: 'ignore', watches: [{ ...onceOnTurn, repeat: true }] }))
  startJob(app.protocol, job('context-watch', { success: 'context', watches: [{ ...onceOnTurn, on: 'context' }] }))
  await app.settleTurn()
  await until(() => app.ended()[0], 'persistent servers held terminal completion')
  assert.deepEqual(app.protocol.started, [])
})

test('one-shot readiness watch releases when it fires while the server remains live', async (t) => {
  const app = await terminal(t)
  const { protocol } = app
  const readyWatch = { ...onceOnTurn }
  const info = job('readiness', { success: 'context', watches: [readyWatch] })
  await app.beginTurn()
  startJob(protocol, info)
  await app.settleTurn()
  await until(() => app.posts.find((post) => post.subagents?.[0]?.id === 'pi-process:readiness'), 'unfired watch was not held')
  assert.deepEqual(app.ended(), [])

  readyWatch.fired = true
  protocol.events.emit('processes:notification', { processId: info.id, attention: 'turn', kind: 'log_match' })
  await tick()
  assert.deepEqual(protocol.completed, [])
  await app.beginTurn()
  await tick()
  assert.deepEqual(protocol.completed, [{ id: 'pi-process:readiness', runId: 'pi-process:readiness', success: true }])
  assert.equal(protocol.list.get(info.id).status, 'running')
  assert.deepEqual(app.ended(), [])
  await app.settleTurn()
  await until(() => app.ended()[0], 'turn following the fired watch did not settle')
})

test('late wake settings are read on tool_result and synchronously before agent_settled', async (t) => {
  const app = await terminal(t)
  const { protocol } = app
  const lateToolResult = job('late-tool-result')
  const lateAgentEnd = job('late-agent-end')
  await app.beginTurn()
  startJob(protocol, { ...lateToolResult, wake: undefined })
  startJob(protocol, { ...lateAgentEnd, wake: undefined })
  await tick()
  assert.deepEqual(protocol.started, [])
  protocol.list.set(lateToolResult.id, lateToolResult)
  await app.emit('tool_result', { toolName: 'process' })
  await tick()
  assert.deepEqual(protocol.started.map((entry) => entry.id), ['pi-process:late-tool-result'])
  protocol.list.set(lateAgentEnd.id, lateAgentEnd)
  await app.settleTurn()
  assert.deepEqual(protocol.started.map((entry) => entry.id), ['pi-process:late-tool-result', 'pi-process:late-agent-end'])
  await until(() => app.posts.find((post) => post.subagents?.length === 2), 'wake settings were missing at settle')
  assert.deepEqual(app.ended(), [])
})

test('an out-of-turn UI launch is tracked after the process manager startup grace', async (t) => {
  process.env.ORCA_STRUCTURED_SESSION = '1'
  const state = protocol()
  const app = runner(state)
  bridge(app.api)
  t.after(app.stop)
  await app.start()
  const info = job('ui-launch')
  startJob(state, { ...info, wake: undefined })
  await tick()
  assert.deepEqual(state.started, [])
  state.list.set(info.id, info)
  await until(() => state.started[0], 'UI launch without tool_result did not get rechecked')
  assert.equal(globalThis[livenessKey].hasActiveProvider({ sessionId: 'session-1' }), true)
})

test('bridge is inert outside Orca, in pi-subagents children and in OMP', async () => {
  const state = protocol()
  const app = runner(state)
  const info = job('ignored')
  bridge(app.api)
  process.env.ORCA_STRUCTURED_SESSION = '1'
  process.env.PI_SUBAGENT_CHILD = '1'
  bridge(app.api)
  delete process.env.PI_SUBAGENT_CHILD
  process.env._ = '/usr/local/bin/omp'
  bridge(app.api)
  await app.start()
  startJob(state, info)
  await app.settleTurn()
  await tick()
  assert.deepEqual(state.started, [])
  assert.deepEqual(state.listenerCounts(), [0, 0, 0, 0])
  assert.equal(state.listRequests, 0)
  assert.equal(globalThis[livenessKey], undefined)
})

test('reload and re-init clean up timers and providers and leave real subagent IDs alone', async (t) => {
  const app = await integrated(t, { native: true })
  const { protocol } = app
  const info = job('proc_735e')
  protocol.events.emit('subagent:async-started', { id: info.id, runId: info.id, agent: 'explore' })
  await app.beginTurn()
  startJob(protocol, info)
  await app.settleTurn()
  await tick()
  assert.deepEqual(app.roster().subagents.map(({ id }) => id), ['proc_735e', 'pi-process:proc_735e'])
  endJob(protocol, info)
  await tick()
  assert.deepEqual(protocol.completed, [])

  await app.stop('reload')
  assert.deepEqual(protocol.listenerCounts(), [0, 0, 0, 0])
  assert.equal(globalThis[livenessKey].hasActiveProvider({ sessionId: 'session-1' }), false)
  assert.deepEqual(app.roster().subagents.map(({ id }) => id), ['proc_735e'])
  assert.equal(app.roster().ended['pi-process:proc_735e'], 'completed')
  assert.equal(protocol.completed.length, 1)

  const reload = runner(protocol)
  jiti(statusPath).default(reload.api)
  bridge(reload.api)
  t.after(reload.stop)
  await reload.start('reload')
  const next = job('next')
  startJob(protocol, next)
  await tick()
  assert.equal(protocol.started.filter((entry) => entry.id === 'pi-process:next').length, 1)

  // Each Pi ExtensionAPI can expose its own wrapper around the same bus.
  const replacement = runner(protocol, 'session-1', { ...protocol.events })
  bridge(replacement.api)
  t.after(replacement.stop)
  await replacement.start('reload')
  assert.deepEqual(protocol.listenerCounts(), [1, 1, 1, 1])
  await tick()
  assert.equal(globalThis[livenessKey].hasActiveProvider({ sessionId: 'session-1' }), true)
  assert.equal(protocol.started.filter((entry) => entry.id === 'pi-process:next').length, 2)
  assert.equal(protocol.completed.at(-1).state, 'stopped')
  const afterReinitialization = protocol.completed.length
  await delay(550)
  assert.equal(protocol.completed.length, afterReinitialization)
  await replacement.stop()
  assert.equal(globalThis[livenessKey].hasActiveProvider({ sessionId: 'session-1' }), false)
  assert.deepEqual(protocol.listenerCounts(), [0, 0, 0, 0])
})

test('switching sessions retires parked process entries when the old transcript resumes', async (t) => {
  const app = await integrated(t, { native: true })
  await app.beginTurn()
  startJob(app.protocol, job('switched'))
  await app.settleTurn()
  await tick()
  assert.equal(app.roster().subagents[0].id, 'pi-process:switched')
  await app.stop('new')
  app.protocol.list.clear()
  assert.equal(globalThis[livenessKey].hasActiveProvider({ sessionId: 'session-1' }), false)

  const other = runner(app.protocol, 'session-2')
  jiti(statusPath).default(other.api)
  bridge(other.api)
  await other.start('new')
  t.after(other.stop)
  await other.stop('resume', { targetSessionFile: '/tmp/session-1.jsonl' })

  const resumed = runner(app.protocol)
  jiti(statusPath).default(resumed.api)
  bridge(resumed.api)
  t.after(resumed.stop)
  await resumed.start('resume')
  await tick()
  assert.deepEqual(resumed.roster(), { subagents: [], ended: { 'pi-process:switched': 'aborted' } })
  assert.equal(globalThis[livenessKey].hasActiveProvider({ sessionId: 'session-1' }), false)
})

test('real Pi RPC loads the installed extensions and tracks and releases a real process', { timeout: 25000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-bridge-rpc-'))
  const driver = join(dir, 'process-smoke.ts')
  await writeFile(driver, `export default function (pi) {
  let id
  pi.on('session_start', (_event, ctx) => {
    pi.events.emit('processes:command:start', {
      name: 'bridge smoke', command: 'sleep 30',
      reply: (result) => {
        id = result.process?.id
        ctx.ui.setStatus('smoke-process', id || result.error)
      }
    })
  })
  pi.registerCommand('bridge-smoke-stop', {
    description: 'Stop the smoke test process',
    handler: () => new Promise((resolve) => {
      pi.events.emit('processes:command:kill', { id, reply: resolve })
    })
  })
}\n`)
  const probeDir = join(dir, 'probes')
  const pi = spawn(piBin, [
    '--mode', 'rpc', '--no-session', '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files',
    '--provider', 'openai', '--model', 'gpt-4.1-mini', '--api-key', 'bridge-smoke-no-provider-calls',
    '-e', processesPath, '-e', statusPath, '-e', bridgePath, '-e', backgroundPath, '-e', driver,
  ], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, 'agent'), ORCA_STRUCTURED_SESSION: '1', ORCA_PI_BACKGROUND_WORK_DIR: probeDir } })
  const exit = once(pi, 'close')
  const messages = []
  let stderr = ''
  pi.stderr.setEncoding('utf8').on('data', (data) => { stderr += data })
  createInterface({ input: pi.stdout }).on('line', (line) => {
    try { messages.push(JSON.parse(line)) } catch { messages.push({ type: 'invalid-output', line }) }
  })
  t.after(async () => {
    if (pi.exitCode === null && pi.signalCode === null) {
      pi.stdin.end()
      const watchdog = setTimeout(() => pi.kill('SIGTERM'), 3000)
      try { await exit } finally { clearTimeout(watchdog) }
    }
    await rm(dir, { recursive: true, force: true })
  })
  const status = (key) => messages.findLast((message) => message.method === 'setStatus' && message.statusKey === key)?.statusText
  const diagnostics = () => JSON.stringify({ messages: messages.slice(-12), stderr })
  pi.stdin.write(JSON.stringify({ id: 'smoke-state', type: 'get_state' }) + '\n')
  await until(() => messages.find((message) => message.id === 'smoke-state' && message.success), 'Pi RPC startup failed', 12000)
  const ready = await until(() => status('orca-background-work'), 'background work extension did not load')
  const id = await until(() => status('smoke-process'), 'processes command did not reply')
  assert.match(id, /^proc_[0-9a-f]+$/)
  const processId = `pi-process:${id}`
  const roster = () => JSON.parse(status('orca-subagents') ?? '{}')
  await until(() => roster().subagents?.some((entry) => entry.id === processId), 'real processes start did not reach Orca')
  const active = await probe(probeDir, ready, 'real-running', () => status('orca-background-work'))
  assert.match(active, /:active$/)
  pi.stdin.write(JSON.stringify({ id: 'smoke-stop', type: 'prompt', message: '/bridge-smoke-stop' }) + '\n')
  await until(() => roster().ended?.[processId] === 'aborted', 'real process stop did not reach Orca')
  assert.deepEqual(roster().subagents, [])
  const idle = await probe(probeDir, ready, 'real-stopped', () => status('orca-background-work'))
  assert.match(idle, /:idle$/)
  pi.stdin.end()
  assert.deepEqual(await exit, [0, null], diagnostics())
  assert.deepEqual(messages.filter((message) => ['extension_error', 'invalid-output'].includes(message.type)), [], diagnostics())
  assert.equal(stderr, '')
  t.diagnostic('Pi RPC reported the real process as working, then aborted, with active and idle liveness replies and empty stderr.')
})
