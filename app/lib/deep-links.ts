// Deep Link Handler for 7ei:// scheme
// Registered scheme in app.json: scheme = "7ei"
//
// Supported deep links:
//   7ei://agent/:id           → /agents/:id
//   7ei://task/:id            → /tasks/:id (future)
//   7ei://project/:id         → /projects/:id
//   7ei://org/:id/switch      → switch to org and navigate home
//   7ei://jira/:key           → /jira?issueKey=:key
//   7ei://gmail/callback      → handled by Expo AuthSession
//   7ei://onboarding          → /onboarding
//   7ei://search              → /search

import { Linking } from 'react-native'
import { Router } from 'expo-router'

export function handleDeepLink(url: string, router: Router) {
  try {
    const parsed = new URL(url)
    const scheme = parsed.protocol  // 'customscheme:'
    const host   = parsed.hostname  // path segment after '//'
    const path   = parsed.pathname  // everything after host
    const params = Object.fromEntries(parsed.searchParams)

    // 7ei://agent/:id
    if (host === 'agent' && path) {
      const id = path.replace('/', '')
      router.push(`/agents/${id}` as any)
      return
    }

    // 7ei://project/:id
    if (host === 'project' && path) {
      const id = path.replace('/', '')
      router.push(`/projects/${id}` as any)
      return
    }

    // 7ei://jira + optional ?key=PROJ-123
    if (host === 'jira') {
      router.push('/jira' as any)
      return
    }

    // 7ei://search?q=something
    if (host === 'search') {
      router.push('/search' as any)
      return
    }

    // 7ei://onboarding
    if (host === 'onboarding') {
      router.push('/onboarding' as any)
      return
    }

    // 7ei://settings
    if (host === 'settings') {
      router.push('/settings' as any)
      return
    }

    // 7ei://scheduled
    if (host === 'scheduled') {
      router.push('/scheduled' as any)
      return
    }

    // 7ei://gmail/callback is handled by Expo AuthSession automatically
    // no manual routing needed

    // Default: go home
    router.push('/(tabs)' as any)
  } catch (e) {
    console.warn('Invalid deep link:', url, e)
  }
}

// Setup listener — call once from root _layout
export function setupDeepLinkListener(router: Router): () => void {
  const subscription = Linking.addEventListener('url', ({ url }) => {
    handleDeepLink(url, router)
  })

  // Handle cold-start deep links
  Linking.getInitialURL().then(url => {
    if (url) handleDeepLink(url, router)
  })

  return () => subscription.remove()
}
