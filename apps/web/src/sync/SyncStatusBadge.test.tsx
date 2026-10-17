import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SyncStatusBadge } from './SyncStatusBadge'
import { syncStore } from './syncStore'

afterEach(() => syncStore.reset())

describe('SyncStatusBadge', () => {
  it('shows the three states as the store changes', () => {
    render(<SyncStatusBadge />)
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'saved_on_device')

    act(() => syncStore.update({ hasSynced: true, connected: true, lastSyncedAt: Date.now() }))
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'backed_up')
    expect(screen.getByText('Backed up')).toBeInTheDocument()

    act(() => syncStore.update({ pendingOps: 4 }))
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'saved_on_device')
    expect(screen.getByText(/4 unsent/)).toBeInTheDocument()

    act(() => syncStore.update({ authProblem: 'device_revoked' }))
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'action_required')
    expect(screen.getByRole('status')).toHaveAttribute('title', expect.stringContaining('revoked'))
  })
})
