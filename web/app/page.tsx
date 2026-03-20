import { SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/nextjs'

export default function HomePage() {
  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <h1>7Ei Mission Control</h1>
      <p style={{ color: '#888' }}>Sprint 0 — Web skeleton ✅</p>
      <SignedOut>
        <SignInButton mode="modal">
          <button style={{ background: '#fff', color: '#000', padding: '12px 24px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 16 }}>
            Sign in with Google
          </button>
        </SignInButton>
      </SignedOut>
      <SignedIn>
        <UserButton />
        <p style={{ color: '#888', marginTop: 16 }}>Dashboard coming in Sprint 1</p>
      </SignedIn>
    </main>
  )
}
