import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

let clerkMiddleware: any = null
let createRouteMatcher: any = null

try {
  if (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    const clerk = require('@clerk/nextjs/server')
    clerkMiddleware = clerk.clerkMiddleware
    createRouteMatcher = clerk.createRouteMatcher
  }
} catch {}

const isProtectedRoute = createRouteMatcher
  ? createRouteMatcher(['/dashboard(.*)', '/api(.*)'])
  : null

export default clerkMiddleware
  ? clerkMiddleware(async (auth: any, req: NextRequest) => {
      if (isProtectedRoute?.(req)) {
        await auth.protect()
      }
    })
  : function middleware(_req: NextRequest) {
      return NextResponse.next()
    }

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
