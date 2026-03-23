#!/usr/bin/env bash
# Run after deploy: bash scripts/add-custom-domain.sh
# Adds api.7ei.ai → Fly.io and app.7ei.ai → Vercel
set -e

echo ""
echo "7Ei — Custom Domain Setup"
echo ""

echo "=== Backend: api.7ei.ai → Fly.io ==="
flyctl certs add api.7ei.ai --app 7ei-backend
echo ""
echo "DNS records to add at your registrar:"
flyctl ips list --app 7ei-backend
echo ""
echo "  A     api.7ei.ai  →  [IPv4 from above]"
echo "  AAAA  api.7ei.ai  →  [IPv6 from above]"
echo ""

echo "=== Web: app.7ei.ai → Vercel ==="
cd web
vercel domains add app.7ei.ai --prod
cd ..
echo ""
echo "  CNAME  app.7ei.ai  →  cname.vercel-dns.com"
echo ""
echo "After adding DNS records, run:"
echo "  flyctl certs check api.7ei.ai"
echo "  vercel domains inspect app.7ei.ai"
echo ""
