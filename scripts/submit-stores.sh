#!/usr/bin/env bash
# Run AFTER eas build completes: bash scripts/submit-stores.sh
# Submits to both App Store and Google Play
set -e
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

cd app

echo ""
echo "7Ei Mission Control — App Store Submission"
echo ""

echo -e "${YELLOW}App Store Connect (iOS):"
echo "  Requires: Apple ID, App Store Connect app created at appstoreconnect.apple.com"
echo "  Bundle ID: ai.7ei.missioncontrol"
echo -e "  Submitting…${NC}"
eas submit --platform ios --profile production --non-interactive

echo ""
echo -e "${YELLOW}Google Play (Android):"
echo "  Requires: google-services.json service account key"
echo "  Package: ai.ei7.missioncontrol"
echo -e "  Submitting…${NC}"
eas submit --platform android --profile production --non-interactive

echo ""
echo -e "${GREEN}✓ Submission complete!${NC}"
echo "  iOS:     appstoreconnect.apple.com → check TestFlight / App Review"
echo "  Android: play.google.com/console    → check Internal Testing / Review"
echo ""
