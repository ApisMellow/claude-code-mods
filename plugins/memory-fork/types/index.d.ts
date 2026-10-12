export type Change = { name: string; kind: 'added' | 'updated' | 'deleted' }

export type Run = {
  id: string
  at: number
  status: 'classifying' | 'skipped' | 'forking' | 'done' | 'failed'
  reason?: string
  changes: Change[]
}

declare module 'claude-code' {
  interface PluginState {
    'memory-fork': { runs: Run[]; dismissed: string | null }
  }
}
