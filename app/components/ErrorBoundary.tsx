import React from 'react'
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { Dark, Space, Radius, FontSize, FontWeight } from '../constants/colors'

interface State { hasError: boolean; error: string | null }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode; fallback?: React.ReactNode }, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  reset = () => this.setState({ hasError: false, error: null })

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <View style={styles.container}>
          <Text style={styles.emoji}>⚠️</Text>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message} numberOfLines={3}>{this.state.error}</Text>
          <TouchableOpacity style={styles.btn} onPress={this.reset}>
            <Text style={styles.btnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      )
    }
    return this.props.children
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xxxl, backgroundColor: Dark.bg, gap: Space.md },
  emoji: { fontSize: 44 },
  title: { fontSize: FontSize.xl, fontWeight: FontWeight.bold, color: Dark.text, textAlign: 'center' },
  message: { fontSize: FontSize.sm, color: Dark.textMuted, textAlign: 'center', lineHeight: 18 },
  btn: { marginTop: Space.md, backgroundColor: Dark.accent, paddingHorizontal: Space.xl, paddingVertical: Space.md, borderRadius: Radius.md },
  btnText: { fontSize: FontSize.base, fontWeight: FontWeight.semibold, color: '#fff' },
})
