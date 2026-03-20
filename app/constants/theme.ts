import { useColorScheme } from 'react-native'
import { Dark, Light } from './colors'

export type Theme = typeof Dark
export type ThemeMode = 'dark' | 'light'

export function useTheme(): { theme: Theme; mode: ThemeMode } {
  const scheme = useColorScheme()
  const mode: ThemeMode = scheme === 'light' ? 'light' : 'dark'
  const theme = mode === 'light' ? Light : Dark
  return { theme, mode }
}

// Resolve theme-aware border for cards
export function glassBorder(mode: ThemeMode) {
  return mode === 'dark'
    ? 'rgba(199, 199, 199, 0.08)'
    : 'rgba(0, 0, 0, 0.07)'
}

// Map agent/task status to token
export function statusColor(status: string, theme: Theme): string {
  switch (status) {
    case 'active':      return theme.statusActive
    case 'in_progress': return theme.statusActive
    case 'done':        return theme.statusDone
    case 'paused':      return theme.statusWarning
    case 'blocked':     return theme.statusError
    case 'failed':      return theme.statusError
    case 'pending':     return theme.statusIdle
    case 'idle':        return theme.statusIdle
    case 'stopped':     return theme.statusError
    default:            return theme.statusIdle
  }
}

export function statusBg(status: string, theme: Theme): string {
  switch (status) {
    case 'active':      return theme.statusActiveBg
    case 'in_progress': return theme.statusActiveBg
    case 'done':        return theme.statusDoneBg
    case 'paused':      return theme.statusWarningBg
    case 'blocked':     return theme.statusErrorBg
    case 'failed':      return theme.statusErrorBg
    case 'pending':     return theme.statusIdleBg
    default:            return theme.statusIdleBg
  }
}

export function statusBorder(status: string, theme: Theme): string {
  switch (status) {
    case 'active':      return theme.statusActiveBorder
    case 'in_progress': return theme.statusActiveBorder
    case 'done':        return theme.statusDoneBorder
    case 'paused':      return theme.statusWarningBorder
    case 'blocked':     return theme.statusErrorBorder
    case 'failed':      return theme.statusErrorBorder
    default:            return theme.statusIdleBorder
  }
}

// Status icon — always paired with color (color-blind safe)
export function statusIcon(status: string): string {
  switch (status) {
    case 'active':      return '⬡'   // hexagon pulse
    case 'in_progress': return '◎'
    case 'done':        return '✓'
    case 'paused':      return '⏸'
    case 'blocked':     return '⛔'
    case 'failed':      return '✕'
    case 'pending':     return '○'
    case 'idle':        return '○'
    default:            return '○'
  }
}

export function priorityColor(priority: string, theme: Theme): string {
  switch (priority) {
    case 'highest': return theme.priorityHighest
    case 'high':    return theme.priorityHigh
    case 'medium':  return theme.priorityMedium
    case 'low':     return theme.priorityLow
    case 'lowest':  return theme.priorityLowest
    default:        return theme.priorityMedium
  }
}
