import './globals.css'
import { themeCss } from './dashboard/tokens'
import { ThemeProvider } from './theme'

// Runs before first paint: resolves the stored mode ('7ei-theme') or the OS
// preference and stamps data-theme, so there is no theme flash. Kept here (a
// server module) because client-module exports can't be inlined server-side.
// Must stay in sync with app/theme.tsx.
const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('7ei-theme');var t=(m==='light'||m==='dark')?m:(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.setAttribute('data-theme',t)}catch(e){}})()`

let ClerkProvider: any = null
try {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    ClerkProvider = require('@clerk/nextjs').ClerkProvider
  }
} catch {}

export const metadata = {
  title: '7Ei Mission Control',
  description: 'Your modular virtual office — manage AI agents from web or mobile',
  icons: { icon: '/android-chrome-512x512.png', apple: '/apple-touch-icon.png' },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: '7Ei MC', statusBarStyle: 'black-translucent' as const },
}

// MCA-DIST S5.2 — installable PWA + mobile viewport.
export const viewport = {
  themeColor: '#070707',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover' as const,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const inner = ClerkProvider
    ? <ClerkProvider><ThemeProvider>{children}</ThemeProvider></ClerkProvider>
    : <ThemeProvider>{children}</ThemeProvider>

  // MCA-86 — SSR defaults to dark (current look); the inline script re-stamps
  // data-theme from localStorage / prefers-color-scheme before first paint, so
  // there is no theme flash. suppressHydrationWarning covers the attribute the
  // script may change ahead of React.
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <style id="theme-tokens" dangerouslySetInnerHTML={{ __html: themeCss() }} />
        {inner}
      </body>
    </html>
  )
}
