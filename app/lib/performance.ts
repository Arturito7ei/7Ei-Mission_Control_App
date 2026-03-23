// Performance utilities for React Native
// Usage: wrap expensive list item components with memo + these helpers

import { memo, useCallback, useMemo } from 'react'
import type { ComponentType } from 'react'

// Memoize a list item component — prevents re-renders when parent re-renders
export function memoItem<T extends object>(Component: ComponentType<T>): ComponentType<T> {
  return memo(Component) as ComponentType<T>
}

// Stable key extractor for FlatList — avoids closure recreations
export function keyById(item: { id: string }) {
  return item.id
}

// Throttle a function (e.g. search input) to avoid excessive updates
export function throttle<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let last = 0
  return ((...args: any[]) => {
    const now = Date.now()
    if (now - last >= ms) { last = now; return fn(...args) }
  }) as T
}

// Debounce — delay until user stops typing (for search)
export function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: any[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

// FlatList performance props — use these on every large list
export const LIST_PERF_PROPS = {
  removeClippedSubviews: true,
  maxToRenderPerBatch: 10,
  updateCellsBatchingPeriod: 50,
  windowSize: 10,
  initialNumToRender: 12,
  getItemLayout: undefined,  // override per list when item height is fixed
} as const

// Fixed-height list optimiser — call when items have known height
export function fixedHeightLayout(height: number) {
  return (_: any, index: number) => ({ length: height, offset: height * index, index })
}
