import { useEffect, useRef } from 'react'
import { View, Text, Animated, StyleSheet } from 'react-native'
import { useTheme } from '../constants/theme'
import { Space, Radius, FontSize, FontWeight } from '../constants/colors'

type ToastType = 'success' | 'error' | 'info' | 'warning'

interface ToastProps {
  message: string
  type?: ToastType
  visible: boolean
  onHide: () => void
  duration?: number
}

export function Toast({ message, type = 'info', visible, onHide, duration = 3000 }: ToastProps) {
  const { theme } = useTheme()
  const opacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (visible) {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(duration),
        Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start(() => onHide())
    }
  }, [visible])

  const bgColor = {
    success: theme.statusDone,
    error:   theme.statusError,
    warning: theme.statusWarning,
    info:    theme.accent,
  }[type]

  if (!visible) return null

  return (
    <Animated.View style={[styles.container, { opacity, backgroundColor: bgColor + 'EE' }]}>
      <Text style={styles.icon}>
        {{ success: '✓', error: '✕', warning: '⚠', info: 'ℹ' }[type]}
      </Text>
      <Text style={styles.message}>{message}</Text>
    </Animated.View>
  )
}

// Simple hook for showing toasts
import { useState, useCallback } from 'react'

export function useToast() {
  const [state, setState] = useState<{ message: string; type: ToastType; visible: boolean }>({
    message: '', type: 'info', visible: false,
  })

  const show = useCallback((message: string, type: ToastType = 'info') => {
    setState({ message, type, visible: true })
  }, [])

  const hide = useCallback(() => {
    setState(s => ({ ...s, visible: false }))
  }, [])

  return { toast: state, show, hide }
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute', bottom: 80, left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center', gap: Space.sm,
    padding: Space.md, borderRadius: Radius.lg, zIndex: 9999,
  },
  icon: { fontSize: 16, fontWeight: FontWeight.bold, color: '#fff' },
  message: { flex: 1, fontSize: FontSize.sm, color: '#fff', fontWeight: FontWeight.medium },
})
