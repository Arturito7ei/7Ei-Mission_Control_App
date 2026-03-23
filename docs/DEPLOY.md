# 7Ei Mission Control — Production Deployment Guide

## Architecture

```
Mobile (Expo EAS)  ────┬────────────────────────────────┬─ Fly.io (fra region)
                         │                                │
Web (Vercel, fra1) ───┴─ Backend (Node/Fastify) ───┤
                                 │            │          │
                           Turso DB     Pinecone    Upstash Redis
```

---

## 1. Backend → Fly.io

```bash
cd backend

# Install flyctl
brew install flyctl
flyctl auth login

# Create app (first time)
flyctl launch --name 7ei-backend --region fra --no-deploy

# Set secrets
flyctl secrets set \
  CLERK_SECRET_KEY=sk_live_... \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-... \
  GEMINI_API_KEY=AIza... \
  DATABASE_URL=libsql://... \
  DATABASE_AUTH_TOKEN=... \
  PINECONE_API_KEY=... \
  PINECONE_PROJECT_ID=... \
  REDIS_URL=rediss://... \
  PUBLIC_URL=https://api.7ei.ai

# Deploy
flyctl deploy

# Check health
curl https://7ei-backend.fly.dev/health
```

---

## 2. Database → Turso

```bash
# Install turso CLI
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login

# Create database
turso db create 7ei-production --location fra

# Get connection URL + token
turso db show 7ei-production
turso db tokens create 7ei-production

# Add to Fly.io secrets
flyctl secrets set \
  DATABASE_URL=libsql://7ei-production-[hash].turso.io \
  DATABASE_AUTH_TOKEN=eyJ...
```

---

## 3. Redis → Upstash

1. Go to https://console.upstash.com
2. Create a Redis database in **eu-central-1** (Frankfurt)
3. Copy the **TLS URL**: `rediss://default:...@...upstash.io:6379`
4. `flyctl secrets set REDIS_URL=rediss://...`

---

## 4. Pinecone

1. Go to https://console.pinecone.io
2. Create a Serverless index:
   - Name: `7ei-knowledge`
   - Dimensions: `1536`
   - Metric: `cosine`
   - Cloud: AWS, Region: `us-east-1`
3. Copy API key, Project ID
4. Set secrets on Fly.io

---

## 5. Web → Vercel

```bash
cd web
npm install -g vercel
vercel login

# Link project
vercel link

# Set environment variables
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production
vercel env add CLERK_SECRET_KEY production
vercel env add NEXT_PUBLIC_API_URL production  # https://api.7ei.ai

# Deploy
vercel --prod
```

### Custom domain
```bash
vercel domains add app.7ei.ai
# Add CNAME record: app.7ei.ai → cname.vercel-dns.com
```

---

## 6. Mobile → EAS + App Store

```bash
cd app
npm install -g eas-cli
eas login

# Configure project (fills in EAS_PROJECT_ID)
eas init

# Update eas.json with your APPLE_TEAM_ID
# Get it from: https://developer.apple.com/account

# Build production
eas build --platform ios --profile production
eas build --platform android --profile production

# Submit to stores
eas submit --platform ios --profile production
eas submit --platform android --profile production
```

---

## 7. CI/CD (GitHub Actions)

Add these secrets to your GitHub repo settings:

| Secret | Where to get it |
|--------|----------------|
| `FLY_API_TOKEN` | `flyctl auth token` |
| `VERCEL_TOKEN` | Vercel dashboard → Account Settings → Tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` after `vercel link` |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` after `vercel link` |

After setting these, every push to `main` auto-deploys backend (Fly.io) and web (Vercel).

---

## 8. Custom domain for backend

```bash
# Add certificate on Fly.io
flyctl certs add api.7ei.ai

# Add DNS record at your registrar:
# A     api.7ei.ai → [Fly.io IP from flyctl ips list]
# AAAA  api.7ei.ai → [Fly.io IPv6]
```

---

## 9. Jira webhook setup

After deploying backend, get the webhook URL:
```
GET https://api.7ei.ai/api/orgs/:orgId/jira/webhook-url
```
Paste it into Jira: Settings → System → Webhooks → Create.

---

## Monitoring

```bash
# Live backend logs
flyctl logs --app 7ei-backend

# Health check
curl https://api.7ei.ai/health

# Usage stats
curl https://api.7ei.ai/api/orgs/:orgId/usage -H 'Authorization: Bearer ...'
```
