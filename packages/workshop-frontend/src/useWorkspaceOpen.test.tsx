// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createOpenGadgetError,
  OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi,
  type GadgetMetadata,
  type Overseer,
} from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { useWorkspaceOpen } from './useWorkspaceOpen'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function disposableStub<T extends object>(value: T, dispose = vi.fn<() => void>()) {
  return Object.assign(value, { [Symbol.dispose]: dispose }) as T & Disposable
}

function api(overseer: RpcStub<Overseer>): RpcStub<AuthenticatedApi> {
  return { openGadget: () => overseer } as unknown as RpcStub<AuthenticatedApi>
}

function resetError() {
  return Object.assign(
    new Error('Durable Object storage operation exceeded timeout which caused object to be reset.'),
    { durableObjectReset: true },
  )
}

const METADATA = {
  id: 'workspace-1',
  title: 'Quarterly planning',
  provisional: false,
} as GadgetMetadata

function WorkspaceProbe({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) {
  const state = useWorkspaceOpen({
    id: 'workspace-1',
    authenticatedApi,
    onInvalidShareKey: () => {},
    onMetadata: () => {},
    onShareKeyConsumed: () => {},
  })
  if (state.connectionLost) return <p>reconnecting</p>
  if (state.error?.kind === 'open') {
    return (
      <WorkspaceOpenErrorPage
        kind={state.error.failure}
        onGoToWorkspaces={() => {}}
        onRetry={state.retry}
      />
    )
  }
  return <p>{state.metadata?.title}</p>
}

describe('useWorkspaceOpen', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.title = ''
    vi.restoreAllMocks()
  })

  it('disposes a metadata subscription that resolves after its load attempt is cleaned up', async () => {
    const pendingSubscription = deferred<RpcStub<{}>>()
    const overseerDispose = vi.fn<() => void>()
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }, overseerDispose) as unknown as RpcStub<Overseer>
    const subscriptionDispose = vi.fn<() => void>()
    const subscription = disposableStub({}, subscriptionDispose) as RpcStub<{}>
    const authenticatedApi = api(overseer)

    function Probe() {
      useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))

    act(() => root!.unmount())
    root = undefined
    await act(async () => { pendingSubscription.resolve(subscription); await Promise.resolve() })

    expect(overseerDispose).toHaveBeenCalledOnce()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('clears loaded metadata and title and disposes the failed stub after access is denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    document.title = 'outside'
    const firstSubscriptionDispose = vi.fn<() => void>()
    const firstOverseer = disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}, firstSubscriptionDispose) as RpcStub<{}>
        }),
    }) as unknown as RpcStub<Overseer>
    const deniedOverseerDispose = vi.fn<() => void>()
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
      }),
    }, deniedOverseerDispose) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(firstOverseer)} />))
    expect(container.textContent).toContain('Quarterly planning')
    expect(document.title).toBe('Quarterly planning - Cloudflare OS')

    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(deniedOverseer)} />))
    expect(container.textContent).toContain("You don't have access to this workspace")
    expect(container.textContent).not.toContain('Quarterly planning')
    expect(document.title).toBe('Cloudflare OS')
    expect(firstSubscriptionDispose).toHaveBeenCalledOnce()
    expect(deniedOverseerDispose).toHaveBeenCalledOnce()
  })

  it('coalesces a burst of DO-reset errors into one reopen', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      let captured!: ReturnType<typeof useWorkspaceOpen>
      const openGadget = vi.fn<() => RpcStub<Overseer>>(() => disposableStub({
        subscribeToMetadata: async (callback: (metadata: GadgetMetadata) => void) => {
          callback(METADATA)
          return disposableStub({}) as RpcStub<{}>
        },
      }) as unknown as RpcStub<Overseer>)
      const authenticatedApi = { openGadget } as unknown as RpcStub<AuthenticatedApi>

      function Probe() {
        captured = useWorkspaceOpen({
          id: 'workspace-1',
          authenticatedApi,
          onInvalidShareKey: () => {},
          onMetadata: () => {},
          onShareKeyConsumed: () => {},
        })
        return null
      }

      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => root!.render(<Probe />))
      expect(openGadget).toHaveBeenCalledTimes(1)

      act(() => {
        for (let i = 0; i < 5; i++) expect(captured.notifyWorkspaceRpcError(resetError())).toBe(true)
      })
      await act(async () => { vi.advanceTimersByTime(600) })
      expect(openGadget).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reopen for non-reset errors', async () => {
    vi.useFakeTimers()
    try {
      let captured!: ReturnType<typeof useWorkspaceOpen>
      const openGadget = vi.fn<() => RpcStub<Overseer>>(() => disposableStub({
        subscribeToMetadata: async () => disposableStub({}) as RpcStub<{}>,
      }) as unknown as RpcStub<Overseer>)
      const authenticatedApi = { openGadget } as unknown as RpcStub<AuthenticatedApi>

      function Probe() {
        captured = useWorkspaceOpen({
          id: 'workspace-1',
          authenticatedApi,
          onInvalidShareKey: () => {},
          onMetadata: () => {},
          onShareKeyConsumed: () => {},
        })
        return null
      }

      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => root!.render(<Probe />))

      act(() => {
        expect(captured.notifyWorkspaceRpcError(new Error('Peer closed WebSocket: 1006 '))).toBe(false)
      })
      await act(async () => { vi.advanceTimersByTime(6000) })
      expect(openGadget).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows reconnecting instead of a terminal error when the initial open fails transiently', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => { throw resetError() }),
    }) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(overseer)} />))

    expect(container.textContent).toContain('reconnecting')
    expect(container.textContent).not.toContain('access')
  })
})
