import { describe, expect, it, vi } from 'vitest'

vi.mock('./errorReporting', () => ({ reportIssue: vi.fn() }))

import { reportIssue } from './errorReporting'
import {
  classifyRpcError, getDurableObjectId, isDurableObjectResetError, isOverloadedError,
  isTransientRpcError, reportDoResetError, withDoResetRetry,
} from './rpcErrors'

// The reject frame observed in prod for a DO storage-timeout reset.
function storageTimeoutReset() {
  return Object.assign(
    new Error('Durable Object storage operation exceeded timeout which caused object to be reset.'),
    { remote: true, overloaded: true, durableObjectReset: true, durableObjectId: 'eed0859e' },
  )
}

describe('classifyRpcError', () => {
  it('classifies reset flags as do-reset', () => {
    expect(classifyRpcError(storageTimeoutReset())).toBe('do-reset')
  })

  it('trusts the durableObjectReset flag over an unrecognized message', () => {
    const err = Object.assign(new Error('internal error'), { durableObjectReset: true })
    expect(classifyRpcError(err)).toBe('do-reset')
  })

  it('falls back to known reset messages without flags', () => {
    for (const message of [
      'Durable Object reset because its code was updated.',
      "Durable Object's isolate exceeded its memory limit and was reset.",
      'Durable Object exceeded its CPU time limit and was reset.',
    ]) {
      expect(classifyRpcError(new Error(message))).toBe('do-reset')
    }
  })

  it('prefers do-reset when both reset and retryable flags are set', () => {
    const err = Object.assign(new Error('x'), { durableObjectReset: true, retryable: true })
    expect(classifyRpcError(err)).toBe('do-reset')
  })

  it('classifies the retryable flag as connection', () => {
    expect(classifyRpcError(Object.assign(new Error('x'), { retryable: true }))).toBe('connection')
  })

  it('classifies capnweb transport messages as connection', () => {
    expect(classifyRpcError(new Error('Peer closed WebSocket: 1006 '))).toBe('connection')
    expect(classifyRpcError(new Error('WebSocket connection failed.'))).toBe('connection')
    expect(classifyRpcError(new Error('RPC session was shut down by disposing the main stub')))
        .toBe('connection')
  })

  it('classifies auth failures, which must never be retried or quieted', () => {
    expect(classifyRpcError(new Error('invalid session token'))).toBe('auth')
    expect(classifyRpcError(new Error('Not authenticated with Access.'))).toBe('auth')
  })

  it('classifies everything else as other', () => {
    expect(classifyRpcError(new Error('Workspace not found.'))).toBe('other')
    expect(classifyRpcError('boom')).toBe('other')
    expect(classifyRpcError(null)).toBe('other')
    expect(classifyRpcError(undefined)).toBe('other')
  })
})

describe('isTransientRpcError', () => {
  it('is true for do-reset and connection, false otherwise', () => {
    expect(isTransientRpcError(storageTimeoutReset())).toBe(true)
    expect(isTransientRpcError(new Error('Peer closed WebSocket: 1006 '))).toBe(true)
    expect(isTransientRpcError(new Error('invalid session token'))).toBe(false)
    expect(isTransientRpcError(new Error('Workspace not found.'))).toBe(false)
  })
})

describe('flag accessors', () => {
  it('reads reset, overload, and DO id from the enriched error', () => {
    const err = storageTimeoutReset()
    expect(isDurableObjectResetError(err)).toBe(true)
    expect(isOverloadedError(err)).toBe(true)
    expect(getDurableObjectId(err)).toBe('eed0859e')
  })

  it('handles errors without flags', () => {
    expect(isOverloadedError(new Error('x'))).toBe(false)
    expect(getDurableObjectId(new Error('x'))).toBeUndefined()
    expect(getDurableObjectId(null)).toBeUndefined()
  })
})

describe('reportDoResetError', () => {
  it('forwards to reportIssue with a namespaced site', () => {
    const err = storageTimeoutReset()
    reportDoResetError('chat.send', err, { gadgetId: 'g1' })
    expect(reportIssue).toHaveBeenCalledWith('do-reset.chat.send', err,
        { severity: 'warning', handled: true, gadgetId: 'g1' })
  })
})

describe('withDoResetRetry', () => {
  it('retries once after a reset error', async () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn().mockRejectedValueOnce(storageTimeoutReset()).mockResolvedValueOnce('ok')
      const result = withDoResetRetry(fn)
      await vi.advanceTimersByTimeAsync(2000)
      expect(await result).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry non-reset errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Workspace not found.'))
    await expect(withDoResetRetry(fn)).rejects.toThrow('Workspace not found.')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the second failure', async () => {
    vi.useFakeTimers()
    try {
      const fn = vi.fn().mockRejectedValue(storageTimeoutReset())
      const result = withDoResetRetry(fn)
      result.catch(() => {})
      await vi.advanceTimersByTimeAsync(2000)
      await expect(result).rejects.toThrow('exceeded timeout')
      expect(fn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
