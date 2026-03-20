import { ClerkProvider } from '@clerk/nextjs'

export const metadata = {
  title: '7Ei Mission Control',
  description: 'Your modular virtual office — manage AI agents from web or mobile',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0a0a0a', color: '#fff', fontFamily: "system-ui, -apple-system, sans-serif", minHeight: '100vh' }}>
        <ClerkProvider>
          {children}
        </ClerkProvider>
      </body>
    </html>
  )
}
