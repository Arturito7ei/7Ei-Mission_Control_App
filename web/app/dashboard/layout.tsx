import { redirect } from 'next/navigation'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    try {
      const { auth } = await import('@clerk/nextjs/server')
      const { userId } = await auth()
      if (!userId) redirect('/')
    } catch {}
  }
  return <>{children}</>
}
