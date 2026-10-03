export type Seat = {
  name: string
  dir: string
  tier: number
  maxWeekly: number | null
  session: number | null
  weekly: number | null
  model: number | null
  resetSession: number | null
  resetWeekly: number | null
  locked: boolean
  isCurrent: boolean
}

export type Seats = { list: Seat[]; thresholds: { session: number; weekly: number; model: number }; model: string }

declare module 'claude-code' {
  interface PluginState {
    ccseats: { seats: Seats; isDismissed: boolean }
  }
}

