import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { createConnectionManager, OutageSummary } from './connectionManager'

type FakeStub = {
  brokenCbs: Array<(err: unknown) => void>
  probes: Array<{ resolve: (value: unknown) => void; reject: (err: unknown) => void }>
  disposed: boolean
  onRpcBroken(cb: (err: unknown) => void): void
  getServerConfig(): Promise<unknown>
  [Symbol.dispose](): void
}

function makeFakeStub(): FakeStub {
  const stub: FakeStub = {
    brokenCbs: [],
    probes: [],
    disposed: false,
    onRpcBroken(cb) { stub.brokenCbs.push(cb) },
    getServerConfig() {
      return new Promise((resolve, reject) => { stub.probes.push({ resolve, reject }) })
    },
    [Symbol.dispose]() { stub.disposed = true },
  }
  return stub
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function makeHarness() {
  const stubs: FakeStub[] = []
  const pendingSleeps: Array<{ ms: number; resolve: () => void }> = []
  const outages: OutageSummary[] = []
  let clock = 0

  const manager = createConnectionManager({
    onOutageEnd: (outage) => { outages.push(outage) },
    makeSession: () => {
      const stub = makeFakeStub()
      stubs.push(stub)
      return stub as unknown as RpcStub<PublicApi>
    },
    now: () => clock,
    sleep: (ms) => new Promise<void>((resolve) => { pendingSleeps.push({ ms, resolve }) }),
    random: () => 0.5,  // jitter factor exactly 1.0
  })

  let notifications = 0
  manager.subscribe(() => { notifications++ })

  return {
    manager, stubs, pendingSleeps, outages,
    get notifications() { return notifications },
    advanceClock: (ms: number) => { clock += ms },
    // Resolves the newest pending sleep of the given duration. Backoff and probe-timeout
    // sleeps coexist (settled races leave their timeout sleeps pending forever), and the
    // current attempt's sleep is always the most recently created.
    elapse: async (ms: number) => {
      const i = pendingSleeps.findLastIndex((s) => s.ms === ms)
      expect(i, `no pending sleep of ${ms}ms`).toBeGreaterThanOrEqual(0)
      pendingSleeps.splice(i, 1)[0].resolve()
      await tick()
    },
    breakCurrent: async (err: unknown) => {
      const current = manager.getSnapshot().stub as unknown as FakeStub
      for (const cb of current.brokenCbs) cb(err)
      await tick()
    },
  }
}

describe('createConnectionManager', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('publishes exactly twice per outage and only swaps to a proven stub', async () => {
    const h = makeHarness()
    const [s0] = h.stubs

    await h.breakCurrent(new Error('Peer closed WebSocket: 1006 '))
    expect(h.manager.getSnapshot()).toMatchObject({ connectionLost: true })
    expect(h.notifications).toBe(1)

    await h.elapse(1000)  // first backoff
    const s1 = h.stubs[1]
    s1.probes[0].reject(new Error('WebSocket connection failed.'))
    await tick()
    expect(s1.disposed).toBe(true)
    expect(h.notifications).toBe(1)  // failed attempts publish nothing

    await h.elapse(2000)  // doubled backoff
    const s2 = h.stubs[2]
    s2.probes[0].resolve({})
    await tick()

    const snapshot = h.manager.getSnapshot()
    expect(snapshot.connectionLost).toBe(false)
    expect(snapshot.stub).toBe(s2 as unknown as RpcStub<PublicApi>)
    expect(h.notifications).toBe(2)
    expect(s0.disposed).toBe(false)  // the broken stub is capnweb's to clean up
    expect(h.outages).toHaveLength(1)
    expect(h.outages[0]).toMatchObject({
      trigger: 'broken', attempts: 2, reason: 'Error: Peer closed WebSocket: 1006 ',
    })
  })

  it('doubles backoff up to the cap', async () => {
    const h = makeHarness()
    await h.breakCurrent(new Error('Peer closed WebSocket: 1006 '))

    for (const backoff of [1000, 2000, 4000, 8000, 10000, 10000]) {
      const stubsBefore = h.stubs.length
      await h.elapse(backoff)
      // A new candidate appears only once this step's full backoff has elapsed.
      expect(h.stubs.length).toBe(stubsBefore + 1)
      const candidate = h.stubs[h.stubs.length - 1]
      candidate.probes[0].reject(new Error('WebSocket connection failed.'))
      await tick()
    }
  })

  it('ignores broken events from stale stubs', async () => {
    const h = makeHarness()
    const [s0] = h.stubs
    await h.breakCurrent(new Error('Peer closed WebSocket: 1006 '))
    await h.elapse(1000)
    h.stubs[1].probes[0].resolve({})
    await tick()
    expect(h.notifications).toBe(2)

    for (const cb of s0.brokenCbs) cb(new Error('Peer closed WebSocket: 1006 '))
    await tick()
    expect(h.manager.getSnapshot().connectionLost).toBe(false)
    expect(h.notifications).toBe(2)
  })

  it('a wake signal short-circuits the backoff sleep', async () => {
    const h = makeHarness()
    await h.breakCurrent(new Error('Peer closed WebSocket: 1006 '))
    expect(h.stubs).toHaveLength(1)  // still sleeping, no attempt yet

    await h.manager.onWakeSignal()
    await tick()
    expect(h.stubs).toHaveLength(2)  // attempt started without waiting out the backoff
  })

  it('probes a stale connection on wake and reconnects without backoff', async () => {
    const h = makeHarness()
    const [s0] = h.stubs
    h.advanceClock(20000)

    const woke = h.manager.onWakeSignal()
    await tick()
    s0.probes[0].reject(Object.assign(new Error('probe failed'), {
      durableObjectReset: true, durableObjectId: 'abc123',
    }))
    await woke
    await tick()

    expect(s0.disposed).toBe(true)
    expect(h.notifications).toBe(1)
    const s1 = h.stubs[1]  // created immediately: no backoff sleep before the first attempt
    s1.probes[0].resolve({})
    await tick()

    expect(h.manager.getSnapshot().connectionLost).toBe(false)
    expect(h.notifications).toBe(2)
    expect(h.outages[0]).toMatchObject({
      trigger: 'wake-zombie', doReset: true, durableObjectIds: ['abc123'],
    })
  })

  it('ignores wake signals while the connection is fresh', async () => {
    const h = makeHarness()
    const [s0] = h.stubs
    h.advanceClock(5000)  // under the idle threshold
    await h.manager.onWakeSignal()
    expect(s0.probes).toHaveLength(0)
  })
})
