import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'

// WebSocket RPC connection management, as a plain state machine deliberately outside React
// (StrictMode double-mounts effects, which would create fighting duplicate connections).
//
// A reconnect attempt only becomes the current connection after a probe RPC round-trips:
// capnweb queues sends while the socket is still CONNECTING, so an unproven stub looks fine
// until everything pipelined onto it fails at once. Proving first means subscribers hear
// exactly twice per outage — lost, then restored — instead of once per failed attempt.

export type ConnectionSnapshot = Readonly<{ stub: RpcStub<PublicApi>; connectionLost: boolean }>

type Deps = Readonly<{
  makeSession: () => RpcStub<PublicApi>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}>

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 10000
// The probe is getServerConfig — a KV read plus a describe() fan-out to the auth vendors, the
// same call the app needs to boot. Generous deadlines let a slow-but-alive backend settle
// instead of connect/dispose looping (or, on wake, tearing down a healthy socket under load).
const PROBE_TIMEOUT_MS = 20000
// Not 10000: the test harness resolves fake sleeps by duration, and 10000 would collide with
// MAX_BACKOFF_MS.
const WAKE_PROBE_TIMEOUT_MS = 12000
const WAKE_PROBE_MIN_IDLE_MS = 15000

export function createConnectionManager(deps: Deps) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = deps.random ?? Math.random

  const subscribers = new Set<() => void>()
  let snapshot: ConnectionSnapshot = { stub: deps.makeSession(), connectionLost: false }
  let reconnecting = false
  let probing = false
  let lastProvenAt = now()
  let wake: (() => void) | null = null

  const publish = (next: ConnectionSnapshot) => {
    snapshot = next
    for (const cb of [...subscribers]) cb()
  }

  const watch = (stub: RpcStub<PublicApi>) => stub.onRpcBroken((err: unknown) => onBroken(stub, err))

  const dispose = (stub: RpcStub<PublicApi>) => {
    try {
      stub[Symbol.dispose]()
    } catch {
      // Already broken.
    }
  }

  const onBroken = (stub: RpcStub<PublicApi>, err: unknown) => {
    if (stub !== snapshot.stub || reconnecting) return  // stale stub, or recovery already underway
    console.warn('RPC connection lost:', err)
    publish({ stub: snapshot.stub, connectionLost: true })
    void reconnectLoop(false)
  }

  const interruptibleSleep = (ms: number) =>
    Promise.race([sleep(ms), new Promise<void>((resolve) => { wake = resolve })])
        .finally(() => { wake = null })

  const withTimeout = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, sleep(ms).then((): never => { throw new Error('probe timed out') })])

  async function reconnectLoop(skipFirstBackoff: boolean): Promise<void> {
    reconnecting = true
    let backoff = INITIAL_BACKOFF_MS
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0 || !skipFirstBackoff) {
        await interruptibleSleep(backoff * (0.85 + 0.3 * random()))  // jittered against stampedes
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
      const candidate = deps.makeSession()
      try {
        await withTimeout(candidate.getServerConfig(), PROBE_TIMEOUT_MS)
      } catch (err) {
        console.debug('Reconnect attempt failed:', err)
        dispose(candidate)
        continue
      }
      watch(candidate)
      reconnecting = false
      lastProvenAt = now()
      console.warn('RPC connection restored.')
      publish({ stub: candidate, connectionLost: false })
      return
    }
  }

  // Called on tab visibility / network-online signals. Passive close detection misses dead
  // sockets after sleep or background throttling, so probe instead of waiting for a send to fail.
  async function onWakeSignal(): Promise<void> {
    if (reconnecting) {
      wake?.()  // skip the rest of the backoff sleep — the network likely just came back
      return
    }
    if (probing || now() - lastProvenAt < WAKE_PROBE_MIN_IDLE_MS) return
    probing = true
    const suspect = snapshot.stub
    try {
      await withTimeout(suspect.getServerConfig(), WAKE_PROBE_TIMEOUT_MS)
      lastProvenAt = now()
    } catch (err) {
      // A real break may have won the race while the probe was in flight.
      if (snapshot.stub !== suspect || reconnecting) return
      console.warn('Connection unresponsive after wake:', err)
      reconnecting = true  // claim recovery before disposing, so the broken event is ignored
      dispose(suspect)
      publish({ stub: suspect, connectionLost: true })
      void reconnectLoop(true)
    } finally {
      probing = false
    }
  }

  watch(snapshot.stub)

  return {
    subscribe(cb: () => void) {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },
    getSnapshot: () => snapshot,
    onWakeSignal,
  }
}
