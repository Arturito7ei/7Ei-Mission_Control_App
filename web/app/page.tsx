import { SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/nextjs'
import Link from 'next/link'

export default function HomePage() {
  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 24, padding: 24 }}>
      {/* Logo */}
      <div style={{ width: 80, height: 80, borderRadius: 20, background: '#FFB800', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 36, fontWeight: 800, color: '#000' }}>7Ei</span>
      </div>
      <h1 style={{ fontSize: 40, fontWeight: 800, margin: 0, letterSpacing: -1 }}>Mission Control</h1>
      <p style={{ color: '#888', fontSize: 18, margin: 0 }}>Your modular virtual office</p>

      <SignedOut>
        <SignInButton mode="modal">
          <button style={{ background: '#fff', color: '#000', padding: '14px 32px', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#4285F4', fontWeight: 800 }}>G</span>
            Continue with Google
          </button>
        </SignInButton>
      </SignedOut>

      <SignedIn>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <UserButton />
          <Link href="/dashboard" style={{ background: '#FFB800', color: '#000', padding: '12px 24px', borderRadius: 10, textDecoration: 'none', fontWeight: 700, fontSize: 15 }}>
            Open Dashboard →
          </Link>
        </div>
      </SignedIn>
    </main>
  )
}
