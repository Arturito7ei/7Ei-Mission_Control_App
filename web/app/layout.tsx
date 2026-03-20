import { ClerkProvider } from '@clerk/nextjs'

export const metadata = {
  title: '7Ei Mission Control',
  description: 'Your modular virtual office',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0a0a0a', color: '#ffffff', fontFamily: 'system-ui, sans-serif' }}>
        <ClerkProvider>
          {children}
        </ClerkProvider>
      </body>
    </html>
  )
}
