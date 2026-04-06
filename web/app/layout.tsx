import './globals.css'

let ClerkProvider: any = null
try {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    ClerkProvider = require('@clerk/nextjs').ClerkProvider
  }
} catch {}

export const metadata = {
  title: '7Ei Mission Control',
  description: 'Your modular virtual office — manage AI agents from web or mobile',
  icons: { icon: '/android-chrome-512x512.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  if (ClerkProvider) {
    return (
      <html lang="en" data-theme="dark">
        <body>
          <ClerkProvider>
            {children}
          </ClerkProvider>
        </body>
      </html>
    )
  }

  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  )
}
