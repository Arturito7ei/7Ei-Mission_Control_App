'use client'
import { useEffect, useRef } from 'react'
import Link from 'next/link'

const HEX_POSITIONS = [
  { x: 192, y: 48, delay: 0 },
  { x: 96,  y: 100, delay: 0.1 },
  { x: 288, y: 100, delay: 0.2 },
  { x: 192, y: 152, delay: 0.05 },
  { x: 96,  y: 204, delay: 0.15 },
  { x: 288, y: 204, delay: 0.25 },
  { x: 192, y: 256, delay: 0.3 },
]

const FEATURES = [
  { emoji: '🤖', title: 'AI Agent Squad', body: 'Spin up Arturito your Chief of Staff, plus Dev, Marketing, Finance, Ops, and R&D heads. Each agent runs on Claude, GPT-4o, or Gemini.' },
  { emoji: '🧠', title: 'Persistent Memory', body: 'Agents remember context across every conversation. They learn your preferences, terminology, and working style automatically.' },
  { emoji: '⏰', title: 'Scheduled Tasks', body: 'Set agents to run on a cron — daily briefings, weekly reports, automated research. Your org keeps running while you sleep.' },
  { emoji: '🔗', title: 'Jira + Google Drive', body: 'Bidirectional Jira sync. Semantic search over Drive docs via Pinecone. Push completed tasks to Jira issues in one tap.' },
  { emoji: '🎯', title: 'Orchestration', body: 'Arturito delegates to specialist agents automatically. One prompt fans out to Dev, Maya, and Finance in parallel.' },
  { emoji: '📊', title: 'Cost Transparency', body: 'Every token, every dollar tracked in real-time. Set daily budgets. A full breakdown by agent and project, always visible.' },
  { emoji: '🔔', title: 'Outbound Webhooks', body: 'Agents can trigger Slack, Zapier, or any external API directly from their response using the WEBHOOK protocol.' },
  { emoji: '🌗', title: 'Dark + Light Mode', body: 'Sober, minimalist design (Notion-inspired + glassmorphism). Fully color-blind safe. Black, silver, and Aztec Purple.' },
]

const MODELS = [
  { name: 'Claude Sonnet 4', provider: 'Anthropic', tag: 'balanced' },
  { name: 'Claude Opus 4',   provider: 'Anthropic', tag: 'power' },
  { name: 'GPT-4o',          provider: 'OpenAI',    tag: 'power' },
  { name: 'GPT-4o Mini',     provider: 'OpenAI',    tag: 'fast' },
  { name: 'Gemini 2.0 Flash',provider: 'Google',    tag: 'fast' },
  { name: 'Gemini 1.5 Pro',  provider: 'Google',    tag: 'power' },
]

export default function LandingPage() {
  return (
    <div style={s.page}>

      {/* Nav */}
      <nav style={s.nav}>
        <div style={s.navInner}>
          <div style={s.logo}>
            <svg width="28" height="28" viewBox="0 0 120 120" fill="none">
              {HEX_POSITIONS.map((h, i) => (
                <polygon key={i} points="20,0 40,0 50,17.3 40,34.6 20,34.6 10,17.3"
                  transform={`translate(${h.x - 30},${h.y - 17}) scale(0.95)`}
                  fill="#893BFF" opacity={0.7 + i * 0.04}
                />
              ))}
            </svg>
            <span style={s.logoText}>7Ei</span>
          </div>
          <div style={s.navLinks}>
            <a href="#features" style={s.navLink}>Features</a>
            <a href="#models"   style={s.navLink}>Models</a>
            <a href="#open-source" style={s.navLink}>Open Source</a>
            <Link href="/dashboard" style={s.navCta}>Open Dashboard →</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section style={s.hero}>
        <div style={s.heroBadge}>🇨🇭 Made in Zürich · Open Source</div>
        <h1 style={s.heroTitle}>
          Your modular<br />
          <span style={s.heroAccent}>virtual office</span><br />
          powered by AI agents.
        </h1>
        <p style={s.heroSub}>
          Spin up Arturito — your AI Chief of Staff — then add department heads
          and a Silver Board of advisors. Run the whole org from your phone.
        </p>
        <div style={s.heroCtas}>
          <Link href="/dashboard" style={s.ctaPrimary}>Get started free →</Link>
          <a href="https://github.com/Arturito7ei/7Ei-Mission_Control_App"
             target="_blank" rel="noopener" style={s.ctaSecondary}>
            ⭐ View on GitHub
          </a>
        </div>
        <p style={s.heroNote}>
          Bring your own API keys · Self-hosted backend · No data sold
        </p>

        {/* Hexagon mark */}
        <div style={s.heroHex}>
          <svg width="220" height="220" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            {HEX_POSITIONS.map((h, i) => (
              <polygon key={i}
                points="20,0 40,0 50,17.3 40,34.6 20,34.6 10,17.3"
                transform={`translate(${h.x - 30},${h.y - 17}) scale(0.94)`}
                fill="#893BFF" opacity={0.15 + i * 0.05}
                style={{ animation: `hexPulse ${1.8 + h.delay}s ease-in-out infinite alternate` }}
              />
            ))}
          </svg>
        </div>
      </section>

      {/* Social proof */}
      <div style={s.proof}>
        {['Claude · GPT-4o · Gemini', 'Jira · Google Drive', 'iOS · Android · Web', 'Open Source MIT'].map(t => (
          <span key={t} style={s.proofTag}>{t}</span>
        ))}
      </div>

      {/* Features */}
      <section id="features" style={s.section}>
        <div style={s.sectionLabel}>CAPABILITIES</div>
        <h2 style={s.sectionTitle}>Everything your AI org needs</h2>
        <div style={s.featureGrid}>
          {FEATURES.map(f => (
            <div key={f.title} style={s.featureCard}>
              <span style={s.featureEmoji}>{f.emoji}</span>
              <h3 style={s.featureTitle}>{f.title}</h3>
              <p style={s.featureBody}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Models */}
      <section id="models" style={s.section}>
        <div style={s.sectionLabel}>MODELS</div>
        <h2 style={s.sectionTitle}>Every top model. Per agent.</h2>
        <p style={s.sectionSub}>Assign a different model to each agent. Swap any time. New models added as they launch.</p>
        <div style={s.modelGrid}>
          {MODELS.map(m => (
            <div key={m.name} style={s.modelCard}>
              <div style={s.modelProvider}>{m.provider}</div>
              <div style={s.modelName}>{m.name}</div>
              <span style={{ ...s.modelTag, background: m.tag === 'power' ? 'rgba(137,59,255,0.15)' : m.tag === 'balanced' ? 'rgba(51,195,51,0.12)' : 'rgba(255,255,0,0.08)', color: m.tag === 'power' ? '#893BFF' : m.tag === 'balanced' ? '#33c333' : '#c9b800' }}>
                {m.tag}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section style={s.section}>
        <div style={s.sectionLabel}>HOW IT WORKS</div>
        <h2 style={s.sectionTitle}>Zero to AI org in minutes</h2>
        <div style={s.steps}>
          {[
            { n: '01', title: 'Create your org', body: 'Name it, describe it. Takes 10 seconds.' },
            { n: '02', title: 'Spawn Arturito',  body: 'Your Chief of Staff is ready instantly. Chat with him.' },
            { n: '03', title: 'Add your team',   body: 'Dev, Maya, Finance, Ops, R&D — or any custom agent you design.' },
            { n: '04', title: 'Delegate',         body: 'Give Arturito a goal. He routes work to the right agent automatically.' },
          ].map(step => (
            <div key={step.n} style={s.step}>
              <div style={s.stepNum}>{step.n}</div>
              <div>
                <div style={s.stepTitle}>{step.title}</div>
                <div style={s.stepBody}>{step.body}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Open source */}
      <section id="open-source" style={s.openSourceSection}>
        <div style={s.osInner}>
          <div style={s.sectionLabel}>OPEN SOURCE</div>
          <h2 style={{ ...s.sectionTitle, margin: '8px 0 16px' }}>Own your infrastructure</h2>
          <p style={s.sectionSub}>
            7Ei is fully open source (MIT). Your backend runs on Fly.io or Railway.
            Your data stays in your Turso database. Your API keys never leave your server.
          </p>
          <div style={s.osBadges}>
            {['MIT License', 'Self-hosted', 'No vendor lock-in', 'Bring your own keys'].map(b => (
              <span key={b} style={s.osBadge}>{b}</span>
            ))}
          </div>
          <a href="https://github.com/Arturito7ei/7Ei-Mission_Control_App"
             target="_blank" rel="noopener" style={s.ctaSecondary}>
            ⭐ Star on GitHub
          </a>
        </div>
      </section>

      {/* CTA */}
      <section style={s.ctaSection}>
        <h2 style={s.ctaTitle}>Ready to build your AI org?</h2>
        <p style={s.ctaSub}>Free to start. Bring your own API key. Deploy in minutes.</p>
        <div style={s.heroCtas}>
          <Link href="/dashboard" style={s.ctaPrimary}>Open Dashboard →</Link>
          <a href="https://github.com/Arturito7ei/7Ei-Mission_Control_App/blob/main/docs/DEPLOY.md"
             target="_blank" rel="noopener" style={s.ctaSecondary}>
            Deploy guide
          </a>
        </div>
      </section>

      {/* Footer */}
      <footer style={s.footer}>
        <div style={s.footerInner}>
          <div style={s.footerLeft}>
            <span style={s.logoText}>7Ei</span>
            <span style={{ color: '#555', fontSize: 13 }}>Mission Control · Made in Zürich</span>
          </div>
          <div style={s.footerLinks}>
            <a href="https://github.com/Arturito7ei/7Ei-Mission_Control_App" style={s.footerLink} target="_blank" rel="noopener">GitHub</a>
            <a href="/dashboard" style={s.footerLink}>Dashboard</a>
            <a href="https://7ei.ai/privacy" style={s.footerLink}>Privacy</a>
            <a href="https://github.com/Arturito7ei/7Ei-Mission_Control_App/blob/main/docs/DEPLOY.md" style={s.footerLink} target="_blank" rel="noopener">Deploy</a>
          </div>
        </div>
      </footer>

      <style>{`
        @keyframes hexPulse { from { opacity: 0.1; } to { opacity: 0.35; } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html { scroll-behavior: smooth; }
        a { text-decoration: none; }
        @media (max-width: 768px) {
          .nav-links { display: none !important; }
        }
      `}</style>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page:  { background: '#070707', color: '#fff', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', minHeight: '100vh', overflowX: 'hidden' },

  // Nav
  nav:      { position: 'sticky', top: 0, background: 'rgba(7,7,7,0.85)', backdropFilter: 'blur(16px)', borderBottom: '0.5px solid #1e1e1e', zIndex: 100 },
  navInner: { maxWidth: 1100, margin: '0 auto', padding: '0 24px', height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  logo:     { display: 'flex', alignItems: 'center', gap: 10 },
  logoText: { fontSize: 22, fontWeight: 800, letterSpacing: -0.5, color: '#fff' },
  navLinks: { display: 'flex', alignItems: 'center', gap: 28 },
  navLink:  { fontSize: 14, color: '#888', transition: 'color 0.15s' },
  navCta:   { fontSize: 14, fontWeight: 600, color: '#893BFF', background: 'rgba(137,59,255,0.10)', border: '0.5px solid rgba(137,59,255,0.25)', padding: '7px 16px', borderRadius: 8 },

  // Hero
  hero:      { maxWidth: 900, margin: '0 auto', padding: '96px 24px 80px', position: 'relative' },
  heroBadge: { display: 'inline-block', fontSize: 12, fontWeight: 600, color: '#555', background: '#111', border: '0.5px solid #2a2a2a', padding: '4px 12px', borderRadius: 20, marginBottom: 28, letterSpacing: 0.4 },
  heroTitle: { fontSize: 'clamp(36px, 6vw, 72px)', fontWeight: 800, lineHeight: 1.1, letterSpacing: -1.5, color: '#fff', marginBottom: 24 },
  heroAccent:{ color: '#893BFF' },
  heroSub:   { fontSize: 18, color: '#888', lineHeight: 1.7, maxWidth: 560, marginBottom: 40 },
  heroCtas:  { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 },
  ctaPrimary:  { background: '#893BFF', color: '#fff', padding: '13px 28px', borderRadius: 10, fontWeight: 700, fontSize: 16, display: 'inline-block' },
  ctaSecondary:{ background: 'transparent', color: '#c7c7c7', padding: '13px 28px', borderRadius: 10, fontWeight: 600, fontSize: 15, border: '0.5px solid #2a2a2a', display: 'inline-block' },
  heroNote:  { fontSize: 12, color: '#333' },
  heroHex:   { position: 'absolute', right: '-60px', top: '40px', opacity: 0.6, pointerEvents: 'none' },

  // Proof
  proof:    { maxWidth: 900, margin: '0 auto', padding: '0 24px 64px', display: 'flex', gap: 10, flexWrap: 'wrap' },
  proofTag: { fontSize: 12, color: '#555', background: '#111', border: '0.5px solid #1e1e1e', padding: '5px 12px', borderRadius: 20 },

  // Sections
  section:      { maxWidth: 1100, margin: '0 auto', padding: '80px 24px' },
  sectionLabel: { fontSize: 11, fontWeight: 700, letterSpacing: 1.4, color: '#893BFF', textTransform: 'uppercase', marginBottom: 12 },
  sectionTitle: { fontSize: 'clamp(24px, 3.5vw, 42px)', fontWeight: 800, letterSpacing: -0.8, color: '#fff', marginBottom: 16 },
  sectionSub:   { fontSize: 16, color: '#666', maxWidth: 560, lineHeight: 1.7, marginBottom: 40 },

  // Features
  featureGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16, marginTop: 40 },
  featureCard: { background: '#0f0f0f', border: '0.5px solid #1e1e1e', borderRadius: 12, padding: '24px 20px' },
  featureEmoji:{ fontSize: 28, display: 'block', marginBottom: 12 },
  featureTitle:{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 8 },
  featureBody: { fontSize: 14, color: '#666', lineHeight: 1.65 },

  // Models
  modelGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 },
  modelCard: { background: '#0f0f0f', border: '0.5px solid #1e1e1e', borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6 },
  modelProvider:{ fontSize: 11, color: '#555', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase' },
  modelName:  { fontSize: 15, fontWeight: 600, color: '#c7c7c7' },
  modelTag:   { display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, letterSpacing: 0.5, textTransform: 'uppercase', width: 'fit-content' },

  // Steps
  steps: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 24, marginTop: 40 },
  step:  { display: 'flex', gap: 16, alignItems: 'flex-start' },
  stepNum:  { fontSize: 28, fontWeight: 800, color: '#893BFF', opacity: 0.5, lineHeight: 1, minWidth: 36 },
  stepTitle:{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 6 },
  stepBody: { fontSize: 14, color: '#666', lineHeight: 1.6 },

  // Open source
  openSourceSection: { background: '#0a0a0a', borderTop: '0.5px solid #1e1e1e', borderBottom: '0.5px solid #1e1e1e' },
  osInner: { maxWidth: 700, margin: '0 auto', padding: '80px 24px', textAlign: 'center' },
  osBadges:{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', margin: '24px 0' },
  osBadge: { fontSize: 12, color: '#893BFF', background: 'rgba(137,59,255,0.08)', border: '0.5px solid rgba(137,59,255,0.22)', padding: '5px 14px', borderRadius: 20 },

  // CTA section
  ctaSection: { maxWidth: 700, margin: '0 auto', padding: '100px 24px', textAlign: 'center' },
  ctaTitle:   { fontSize: 'clamp(26px, 4vw, 48px)', fontWeight: 800, letterSpacing: -0.8, marginBottom: 16 },
  ctaSub:     { fontSize: 17, color: '#666', marginBottom: 36 },

  // Footer
  footer:      { borderTop: '0.5px solid #1e1e1e', padding: '28px 0' },
  footerInner: { maxWidth: 1100, margin: '0 auto', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 },
  footerLeft:  { display: 'flex', alignItems: 'center', gap: 12 },
  footerLinks: { display: 'flex', gap: 24 },
  footerLink:  { fontSize: 13, color: '#444', transition: 'color 0.15s' },
}
