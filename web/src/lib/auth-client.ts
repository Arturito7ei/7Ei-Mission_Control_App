import { createElement, ComponentType, useEffect } from 'react'
import { useAuth } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'

// Session validator hook — redirects to sign-in if not authenticated
export function useSessionValidator() {
  const { isLoaded, isSignedIn } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.push('/')
    }
  }, [isLoaded, isSignedIn, router])

  return { isLoaded, isSignedIn }
}

// withAuth HOC — wraps a page component and requires authentication
// Uses createElement instead of JSX so this .ts file doesn't need JSX transform
export function withAuth<T extends object>(Component: ComponentType<T>) {
  const WrappedComponent = (props: any) => {
    useSessionValidator()
    return createElement(Component, props)
  }

  WrappedComponent.displayName = `withAuth(${Component.displayName ?? Component.name ?? 'Component'})`

  return WrappedComponent
}
