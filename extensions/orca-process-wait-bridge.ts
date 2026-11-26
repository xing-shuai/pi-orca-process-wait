import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const LIVENESS_KEY = Symbol.for('@agegr/pi-web/session-liveness/v1')
const BRIDGE_KEY = Symbol.for('orca.pi-process-wait-bridge/v1')
const WAKE_GRACE_MS = 500
// pi-processes 0.13.6 waits up to 150 ms in manager.start() before registering wake settings.
const START_RECHECK_MS = 200
const LIVE_STATUSES = new Set(['running', 'terminating', 'terminate_timeout'])

type Disposer = () => void
type Attention = 'turn' | 'context' | 'ignore'
type ProcessInfo = {
  id: string
  name: string
  command: string
  status: string
  exitCode: number | null
  endReason: string | null
  wake?: {
    exitAttention: { success: Attention; failure: Attention; killed: Attention }
    watches: { on: Attention; repeat: boolean; fired: boolean }[]
  }
}
type ProcessWait = {
  exitCanWake: boolean
  ended?: ProcessInfo
  turnNotified?: boolean
  wakeStarted?: boolean
  releaseTimer?: ReturnType<typeof setTimeout>
}
type Completion = { id: string; runId: string; success: boolean; state?: 'stopped' }
type SessionIdentity = { sessionId: string; sessionFile?: string }
type Provider = SessionIdentity & { name: string; isActive: () => boolean }
type LivenessRegistry = {
  version: 1
  register: (provider: Provider) => Disposer
  hasActiveProvider: (session: SessionIdentity) => boolean
}
type BridgeRegistry = {
  byBus: WeakMap<ExtensionAPI['events'], Disposer>
  bySessionId: Map<string, Disposer>
  retiredBySessionFile: Map<string, Completion[]>
}

function sessionLivenessRegistry(): LivenessRegistry {
  const existing = Reflect.get(globalThis, LIVENESS_KEY)
  if (existing?.version === 1 && typeof existing.register === 'function' && typeof existing.hasActiveProvider === 'function') {
    return existing
  }
  const providers = new Set<Provider>()
  const registry: LivenessRegistry = {
    version: 1,
    register(provider) {
      const registration = { ...provider }
      providers.add(registration)
      return () => { providers.delete(registration) }
    },
    hasActiveProvider(session) {
      const ids = new Set([session.sessionId, session.sessionFile].filter(Boolean))
      for (const provider of providers) {
        if (!ids.has(provider.sessionId) && !ids.has(provider.sessionFile)) continue
        try {
          if (provider.isActive() !== false) return true
        } catch {
          return true
        }
      }
      return false
    },
  }
  Reflect.set(globalThis, LIVENESS_KEY, registry)
  return registry
}

function isOrcaPi(): boolean {
  const env = process.env
  if (!(env.ORCA_PANE_KEY || env.ORCA_STRUCTURED_SESSION || env.ORCA_PI_BACKGROUND_WORK_DIR || env.ORCA_AGENT_HOOK_ENDPOINT)) return false
  if (env.PI_SUBAGENT_CHILD === '1' || env.PI_SUBAGENT_PARENT_SESSION) return false
  const isOmp = [process.title, env._, process.argv[1], process.argv[0]].some(
    (path) => /^omp(?:\.(?:js|sh|cmd|exe|bat))?$/i.test(path?.split(/[\\/]/).pop() ?? ''),
  )
  if (isOmp) return false

  const owner = Number(env.ORCA_PI_STATUS_OWNED)
  if (Number.isInteger(owner) && owner > 0 && owner <= 0x7fffffff && owner !== process.pid) {
    try {
      process.kill(owner, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }
  return true
}

function makeCompletion(id: string, ended?: ProcessInfo, stopping = false): Completion {
  const runId = `pi-process:${id}`
  const stopped = ended ? ended.status === 'killed' || ended.endReason === 'signal' : stopping
  return {
    id: runId,
    runId,
    success: !stopped && (ended ? ended.exitCode === 0 : true),
    ...(stopped ? { state: 'stopped' } : {}),
  }
}

export default function orcaProcessWaitBridge(pi: ExtensionAPI): void {
  if (!isOrcaPi()) return
  const { events } = pi
  let registry: BridgeRegistry | undefined = Reflect.get(globalThis, BRIDGE_KEY)
  if (!registry) {
    registry = { byBus: new WeakMap(), bySessionId: new Map(), retiredBySessionFile: new Map() }
    Reflect.set(globalThis, BRIDGE_KEY, registry)
  }
  const { byBus, bySessionId, retiredBySessionFile } = registry
  byBus.get(events)?.()
  const handlers: Disposer[] = []
  let session: ReturnType<typeof openSession> | undefined

  function closeSession(parkedSessionFile?: string): void {
    const current = session
    session = undefined
    if (!current) return
    if (bySessionId.get(current.id) === dispose) bySessionId.delete(current.id)
    current.close(parkedSessionFile)
  }

  function dispose(parkedSessionFile?: string): void {
    closeSession(parkedSessionFile)
    for (const remove of handlers.splice(0)) remove()
    if (byBus.get(events) === dispose) byBus.delete(events)
  }

  function openSession(identity: SessionIdentity) {
    const waits = new Map<string, ProcessWait>()
    let immediate: ReturnType<typeof setImmediate> | undefined
    let startRecheck: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const unregister = sessionLivenessRegistry().register({
      ...identity,
      name: 'orca-process-wait-bridge',
      isActive: () => waits.size > 0,
    })

    function complete(id: string, wait: ProcessWait, stopping = false): Completion {
      clearTimeout(wait.releaseTimer)
      waits.delete(id)
      const payload = makeCompletion(id, wait.ended, stopping)
      events.emit('subagent:async-complete', payload)
      return payload
    }

    function sync(): void {
      if (closed) return
      let list: ProcessInfo[] | undefined
      events.emit('processes:request:list', { reply: (entries: ProcessInfo[]) => { list = entries } })
      if (!list) return

      const processes = new Map(list.map((info) => [info.id, info]))
      const waiting = new Set<string>()
      for (const info of list) {
        const wake = info.wake
        if (!LIVE_STATUSES.has(info.status) || !wake) continue
        if (wake.exitAttention?.success !== 'turn' && !wake.watches?.some((watch) => watch.on === 'turn' && !watch.repeat && !watch.fired)) continue
        waiting.add(info.id)
        const previous = waits.get(info.id)
        clearTimeout(previous?.releaseTimer)
        waits.set(info.id, { exitCanWake: Object.values(wake.exitAttention ?? {}).includes('turn') })
        if (previous) continue
        const id = `pi-process:${info.id}`
        const description = (info.name?.trim() || info.command?.trim() || info.id).replace(/\s+/g, ' ').slice(0, 120)
        events.emit('subagent:async-started', { id, runId: id, agent: 'process', description })
      }

      for (const [id, wait] of waits) {
        if (waiting.has(id)) continue
        const info = processes.get(id)
        if (info && !LIVE_STATUSES.has(info.status)) wait.ended ??= info
        const expectWake = wait.turnNotified || (wait.ended && wait.exitCanWake)
        if (wait.wakeStarted || !expectWake) {
          complete(id, wait)
        } else if (!wait.releaseTimer) {
          wait.releaseTimer = setTimeout(() => complete(id, wait), WAKE_GRACE_MS)
          wait.releaseTimer.unref()
        }
      }
    }

    function scheduleSync(): void {
      if (closed || immediate) return
      immediate = setImmediate(() => {
        immediate = undefined
        // On a session switch Orca can park the roster before this extension receives shutdown.
        // Retire those entries after the managed status extension restores the old session.
        const file = identity.sessionFile
        const retired = file && retiredBySessionFile.get(file)
        if (retired && file) {
          retiredBySessionFile.delete(file)
          for (const payload of retired) events.emit('subagent:async-complete', payload)
        }
        sync()
      })
      immediate.unref()
    }

    const listeners = [
      events.on('processes:started', () => {
        scheduleSync()
        // A process launched from the UI has no process tool_result to trigger a second read.
        clearTimeout(startRecheck)
        startRecheck = setTimeout(() => {
          startRecheck = undefined
          sync()
        }, START_RECHECK_MS)
        startRecheck.unref()
      }),
      events.on('processes:changed', scheduleSync),
      events.on('processes:ended', (payload) => {
        const info = payload as ProcessInfo | undefined
        const wait = info && waits.get(info.id)
        if (wait) wait.ended = info
        scheduleSync()
      }),
      events.on('processes:notification', (payload) => {
        const notification = payload as { processId: string; attention: Attention } | undefined
        const wait = notification && waits.get(notification.processId)
        if (wait && notification?.attention === 'turn') wait.turnNotified = true
        scheduleSync()
      }),
    ]

    scheduleSync()
    return {
      id: identity.sessionId,
      sync,
      scheduleSync,
      agentStarted() {
        for (const wait of waits.values()) {
          if (!wait.releaseTimer && !wait.ended && !wait.turnNotified) continue
          wait.wakeStarted = true
          clearTimeout(wait.releaseTimer)
          wait.releaseTimer = undefined
        }
        // Allow every agent_start listener to run before removing Orca's hold.
        scheduleSync()
      },
      close(parkedSessionFile?: string) {
        closed = true
        clearImmediate(immediate)
        clearTimeout(startRecheck)
        for (const remove of listeners) remove()
        unregister()
        const retired = Array.from(waits, ([id, wait]) => complete(id, wait, true))
        if (parkedSessionFile && retired.length > 0) retiredBySessionFile.set(parkedSessionFile, retired)
      },
    }
  }

  byBus.set(events, dispose)
  handlers.push(
    pi.on('session_start', (event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId()
      if (session && session.id !== sessionId && event.reason === 'startup') return
      closeSession()
      // Pi can expose different API wrappers around the same bus on reinitialization.
      bySessionId.get(sessionId)?.()
      const sessionFile = ctx.sessionManager.getSessionFile()
      session = openSession({ sessionId, ...(sessionFile ? { sessionFile } : {}) })
      bySessionId.set(sessionId, dispose)
    }),
    pi.on('session_shutdown', (event, ctx) => {
      if (session && session.id !== ctx.sessionManager.getSessionId()) return
      const file = ctx.sessionManager.getSessionFile()
      const shouldPark = event.reason === 'new' || event.reason === 'fork' || (event.reason === 'resume' && event.targetSessionFile !== file)
      dispose(shouldPark ? file : undefined)
    }),
    pi.on('tool_result', (event, ctx) => {
      if (event.toolName === 'process' && session?.id === ctx.sessionManager.getSessionId()) session.scheduleSync()
    }),
    pi.on('before_agent_start', (_event, ctx) => {
      if (session?.id === ctx.sessionManager.getSessionId()) session.scheduleSync()
    }),
    pi.on('agent_start', (_event, ctx) => {
      if (session?.id === ctx.sessionManager.getSessionId()) session.agentStarted()
    }),
    pi.on('agent_end', (_event, ctx) => {
      if (session?.id !== ctx.sessionManager.getSessionId()) return
      session.sync()
      session.scheduleSync()
    }),
  )
}
