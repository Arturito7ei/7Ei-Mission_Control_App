import './globals.css'
import { ClerkProvider } from '@clerk/nextjs'

export const metadata = {
  title: '7Ei Mission Control',
  description: 'Your modular virtual office — manage AI agents from web or mobile',
  icons: { icon: '/android-chrome-512x512.png' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
