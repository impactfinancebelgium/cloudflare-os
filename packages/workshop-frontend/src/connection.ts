import { newWebSocketRpcSession, RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { createConnectionManager } from './connectionManager'

// The app's singleton connection: manager wiring plus browser wake signals.

function getBackendHost(): string {
  const backendHost = import.meta.env.VITE_BACKEND_HOST?.trim()
  if (backendHost) return backendHost

  // When opening the Vite dev server directly (localhost:3000), the backend is at localhost:8787.
  // Otherwise, the API is on the same host as the frontend.
  return window.location.hostname === 'localhost' ? 'localhost:8787' : window.location.host
}

function makeSession(): RpcStub<PublicApi> {
  const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + getBackendHost() + '/api'
  return newWebSocketRpcSession<PublicApi>(wsUrl)
}

const manager = createConnectionManager({ makeSession })

export const subscribeConnection = manager.subscribe
export const getConnectionSnapshot = manager.getSnapshot

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void manager.onWakeSignal()
})
window.addEventListener('online', () => void manager.onWakeSignal())
