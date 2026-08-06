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
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}>

const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 10000
// The probe is getServerConfig — a KV read plus a describe() fan-out to the auth vendors, the
// same call the app needs to boot. Generous deadlines let a slow-but-alive backend settle
// instead of connect/dispose looping (or, on wake, tearing down a healthy socket under load).
const PROBE_TIMEOUT_MS = 20000

export function createConnectionManager(deps: Deps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const random = deps.random ?? Math.random

  const subscribers = new Set<() => void>()
  let snapshot: ConnectionSnapshot = { stub: deps.makeSession(), connectionLost: false }
  let reconnecting = false

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
    void reconnectLoop()
  }

  const withTimeout = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([promise, sleep(ms).then((): never => { throw new Error('probe timed out') })])

  async function reconnectLoop(): Promise<void> {
    reconnecting = true
    let backoff = INITIAL_BACKOFF_MS
    while (true) {
      await sleep(backoff * (0.85 + 0.3 * random()))  // jittered to avoid multi-tab stampedes
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
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
      console.warn('RPC connection restored.')
      publish({ stub: candidate, connectionLost: false })
      return
    }
  }

  watch(snapshot.stub)

  return {
    subscribe(cb: () => void) {
      subscribers.add(cb)
      return () => { subscribers.delete(cb) }
    },
    getSnapshot: () => snapshot,
  }
}
