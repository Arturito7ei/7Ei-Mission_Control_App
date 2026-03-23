# 7Ei Mission Control — App Store Metadata

## iOS App Store

**App Name:** 7Ei Mission Control
**Bundle ID:** ai.7ei.missioncontrol
**SKU:** 7EI-MISSION-CONTROL-001
**Primary Category:** Productivity
**Secondary Category:** Business
**Age Rating:** 4+
**Price:** Free (with in-app usage costs)

---

### Short Description (30 chars)
```
Your AI-powered virtual office
```

### Full Description (4000 chars max)
```
7Ei Mission Control is your modular virtual office. Spin up a full AI organisation
from your phone — with a Chief of Staff, department heads, and a Silver Board of advisors.

Each agent is powered by Claude (Anthropic), GPT-4o (OpenAI), or Gemini (Google) —
your choice per agent. Every conversation streams in real-time.

WHAT YOU CAN DO
• Create your org and spin up Arturito — your AI Chief of Staff
• Add department heads: Dev, Marketing, Finance, Ops, R&D
• Build a Silver Board of advisor personas (Steve Jobs, Marcus Aurelius, domain experts)
• Chat with any agent, get streaming Claude responses
• Delegate complex tasks: Arturito routes work to the right specialist automatically
• Track every task, token used, and cost in real-time
• Schedule agents to run on a cron — daily briefings, weekly reports, anything
• Connect Jira and sync issues bidirectionally
• Semantic search across your Google Drive knowledge base
• Set up outbound webhooks to trigger Slack, Zapier, or any external service

AGENT MEMORY
Agents remember context across conversations. They learn your preferences, your org’s
terminology, and your working style — and apply it automatically.

COST TRANSPARENCY
Every token, every dollar is tracked. Set daily budgets and rate limits.
A full cost breakdown by agent, day, and project is always visible.

SECURE & PRIVATE
All data stored in your own infrastructure. API keys stay on your backend.
Authentication via Google OAuth (Clerk). No data sold.

REQUIRES
• Your own Anthropic API key (set up on your 7Ei backend)
• A deployed 7Ei backend (see docs at github.com/Arturito7ei/7Ei-Mission_Control_App)
```

### Keywords (100 chars)
```
AI agent,virtual office,Claude,GPT-4o,Gemini,productivity,automation,Jira,chatbot,workflow
```

### What’s New (version 0.9.0)
```
• Agent orchestration: Arturito now delegates tasks to specialist agents automatically
• Scheduled tasks: run agents on a cron (daily briefings, weekly reports)
• Outbound webhooks: agents can trigger Slack, Zapier, and external APIs
• Gmail OAuth: read and send email directly from Mission Control
• Multi-model: switch between Claude, GPT-4o, and Gemini per agent
• Semantic knowledge search (Pinecone)
• 7Ei design system: full dark + light mode, color-blind safe
```

### Support URL
https://github.com/Arturito7ei/7Ei-Mission_Control_App/issues

### Marketing URL
https://7ei.ai

### Privacy Policy URL
https://7ei.ai/privacy

---

## Screenshots guide

### Required sizes
- iPhone 6.9" (1320 × 2868 @3x): iPhone 16 Pro Max
- iPhone 6.5" (1284 × 2778 @3x): iPhone 14 Plus / 15 Plus
- iPad Pro 13" (2064 × 2752 @2x)

### Recommended 5 screenshots
1. **Home screen** — agent squad grid, cost stat, org name
2. **Agent chat** — streaming response from Arturito, purple accent bubbles
3. **Kanban board** — project tasks in 4 columns
4. **Cost Centre** — bar chart by agent, $spent stat
5. **Org Chart** — hierarchical hexagon layout, Silver Board section

### Screenshot tips
- Use dark mode for all screenshots (black #070707 background, purple accents)
- Add subtle device frames in Figma or Canva
- Consistent font overlay: use Helvetica Neue 700, white, no shadows

---

## Google Play Store

**Package:** ai.ei7.missioncontrol
**Category:** Productivity
**Content Rating:** Everyone
**Target SDK:** 34

**Short Description (80 chars):**
```
Your AI-powered virtual office. Claude • GPT-4o • Gemini • Jira • Google Drive
```

**Full Description:** (same as iOS, re-formatted to 4000 chars)

---

## TestFlight / Internal Testing

```bash
# Build for internal testing
cd app
eas build --platform ios --profile preview

# Share TestFlight link with testers
eas submit --platform ios --profile preview
```
