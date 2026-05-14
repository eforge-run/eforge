import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'eforge - agentic build system',
  description: 'eforge is an autonomous plan-build-review orchestration engine for agentic code generation.',
};

export default function HomePage() {
  return (
    <main style={{ maxWidth: 'var(--max-width)', margin: '0 auto', padding: 'var(--spacing-2xl) var(--spacing-xl)' }}>
      {/* Hero */}
      <section style={{ textAlign: 'center', paddingBottom: 'var(--spacing-2xl)' }}>
        <h1
          style={{
            fontSize: '3rem',
            fontWeight: 800,
            marginBottom: 'var(--spacing-md)',
            background: 'linear-gradient(135deg, var(--color-accent), var(--color-accent-hover))',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          eforge
        </h1>
        <p
          style={{
            fontSize: '1.35rem',
            color: 'var(--color-text-muted)',
            maxWidth: '50ch',
            margin: '0 auto var(--spacing-xl)',
          }}
        >
          Plan the work. Hand off implementation. Let eforge run the engineering loop in the background.
        </p>
        <div style={{ display: 'flex', gap: 'var(--spacing-md)', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a
            href="/docs/getting-started"
            style={{
              display: 'inline-block',
              padding: '0.75rem 1.5rem',
              background: 'var(--color-accent)',
              color: '#0a0a0a',
              borderRadius: 'var(--border-radius)',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Get Started
          </a>
          <a
            href="https://github.com/eforge-build/eforge"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '0.75rem 1.5rem',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--border-radius)',
              fontWeight: 600,
              textDecoration: 'none',
              color: 'var(--color-text)',
            }}
          >
            View on GitHub
          </a>
        </div>
      </section>

      {/* Product screenshot */}
      <section style={{ marginBottom: 'var(--spacing-2xl)' }}>
        <figure style={{ maxWidth: '980px', margin: '0 auto' }}>
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: '12px',
              background: 'var(--color-bg-secondary)',
              boxShadow: '0 0 48px rgba(74, 222, 128, 0.08)',
              overflow: 'hidden',
            }}
          >
            <img
              src="/screenshots/monitor-dashboard.png"
              alt="eforge monitor showing build history, plan timelines, agent activity, model usage, and review cycles"
              style={{ display: 'block', width: '100%', height: 'auto' }}
            />
          </div>
          <figcaption
            style={{
              color: 'var(--color-text-muted)',
              fontSize: '0.9rem',
              marginTop: 'var(--spacing-sm)',
              textAlign: 'center',
            }}
          >
            Track delegated builds, inspect agent activity, and follow review cycles while eforge runs engineering work in the background.
          </figcaption>
        </figure>
      </section>

      {/* Product positioning */}
      <section style={{ marginBottom: 'var(--spacing-2xl)' }}>
        <div style={{ textAlign: 'center', maxWidth: '760px', margin: '0 auto var(--spacing-xl)' }}>
          <h2 style={{ marginBottom: 'var(--spacing-md)' }}>Background engineering for planned work</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '1.1rem', margin: 0 }}>
            eforge picks up where planning leaves off. Define the intent and acceptance criteria, then let eforge
            manage implementation, review, retries, and merge flow.
          </p>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
            gap: 'var(--spacing-lg)',
          }}
        >
          {[
            {
              title: 'Hand off implementation',
              description:
                'Give eforge a PRD, issue, or structured session plan once the direction and acceptance criteria are clear.',
            },
            {
              title: 'Let execution run',
              description:
                'eforge decomposes the work, schedules build plans, and runs implementation in isolated git worktrees.',
            },
            {
              title: 'Trust the engineering loop',
              description:
                'Implementation, review, retries, conflict handling, and merge flow are managed without constant babysitting.',
            },
            {
              title: 'Review real outputs',
              description:
                'You stay focused on direction and final judgment with traceable commits, logs, and build decisions.',
            },
          ].map((item) => (
            <div
              key={item.title}
              style={{
                padding: 'var(--spacing-lg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--border-radius)',
                background: 'var(--color-bg-secondary)',
              }}
            >
              <div
                style={{
                  width: '2rem',
                  height: '0.25rem',
                  background: 'var(--color-accent)',
                  borderRadius: '999px',
                  marginBottom: 'var(--spacing-md)',
                }}
              />
              <h3 style={{ margin: '0 0 var(--spacing-sm)' }}>{item.title}</h3>
              <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Configurable handoffs */}
      <section style={{ marginBottom: 'var(--spacing-2xl)' }}>
        <div style={{ textAlign: 'center', maxWidth: '760px', margin: '0 auto var(--spacing-xl)' }}>
          <h2 style={{ marginBottom: 'var(--spacing-md)' }}>Built for repeatable engineering handoffs</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '1.1rem', margin: 0 }}>
            Standardize how work is delegated, which agents run it, and what tools they can use.
          </p>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            gap: 'var(--spacing-lg)',
          }}
        >
          {[
            {
              title: 'Build profiles',
              description:
                'Choose agent runtimes, model tiers, and execution defaults for planning, building, review, and validation.',
            },
            {
              title: 'Playbooks',
              description:
                'Capture recurring workflows as reusable templates so common engineering tasks start with the right structure.',
            },
            {
              title: 'Toolbelts',
              description:
                'Scope each agent to the MCP servers and tools it needs, keeping delegated work constrained and auditable.',
            },
            {
              title: 'Extensions',
              badge: 'Planned',
              description:
                'Native TypeScript hooks, policy gates, custom reviewers, and workflow integrations are on the roadmap.',
            },
          ].map((item) => (
            <div
              key={item.title}
              style={{
                padding: 'var(--spacing-lg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--border-radius)',
                background: 'var(--color-bg-secondary)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-sm)' }}>
                <h3 style={{ margin: 0 }}>{item.title}</h3>
                {'badge' in item ? (
                  <span
                    style={{
                      border: '1px solid var(--color-border)',
                      borderRadius: '999px',
                      color: 'var(--color-accent)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.7rem',
                      padding: '0.1rem 0.4rem',
                    }}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </div>
              <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Install paths */}
      <section style={{ marginBottom: 'var(--spacing-2xl)' }}>
        <h2 style={{ textAlign: 'center', marginBottom: 'var(--spacing-xl)' }}>Three ways to use eforge</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 'var(--spacing-lg)',
          }}
        >
          <div
            style={{
              padding: 'var(--spacing-lg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--border-radius)',
              background: 'var(--color-bg-secondary)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Claude Code plugin</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
              Install eforge as a Claude Code plugin for seamless integration with your AI-assisted workflow.
            </p>
            <pre
              style={{
                background: 'var(--color-code-bg)',
                padding: 'var(--spacing-sm)',
                borderRadius: '4px',
                fontSize: '0.8rem',
                overflow: 'auto',
              }}
            >
              <code>{`/plugin marketplace add eforge-build/eforge\n/plugin install eforge@eforge`}</code>
            </pre>
            <a href="/docs/getting-started" style={{ fontSize: '0.9rem' }}>
              Claude Code setup guide
            </a>
          </div>

          <div
            style={{
              padding: 'var(--spacing-lg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--border-radius)',
              background: 'var(--color-bg-secondary)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Pi extension</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
              Use eforge as a Pi extension for native, rich UX integration with Pi&apos;s agent runtime.
            </p>
            <pre
              style={{
                background: 'var(--color-code-bg)',
                padding: 'var(--spacing-sm)',
                borderRadius: '4px',
                fontSize: '0.8rem',
                overflow: 'auto',
              }}
            >
              <code>pi install npm:@eforge-build/pi-eforge</code>
            </pre>
            <a href="/docs/getting-started" style={{ fontSize: '0.9rem' }}>
              Pi setup guide
            </a>
          </div>

          <div
            style={{
              padding: 'var(--spacing-lg)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--border-radius)',
              background: 'var(--color-bg-secondary)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Standalone CLI</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
              Use eforge as a standalone CLI tool for scripting, CI/CD pipelines, and programmatic workflows.
            </p>
            <pre
              style={{
                background: 'var(--color-code-bg)',
                padding: 'var(--spacing-sm)',
                borderRadius: '4px',
                fontSize: '0.8rem',
                overflow: 'auto',
              }}
            >
              <code>npm install -g @eforge-build/eforge</code>
            </pre>
            <a href="/docs/getting-started" style={{ fontSize: '0.9rem' }}>
              CLI setup guide
            </a>
          </div>
        </div>
      </section>

      {/* Links */}
      <section style={{ textAlign: 'center', padding: 'var(--spacing-xl) 0' }}>
        <p style={{ color: 'var(--color-text-muted)' }}>
          <a href="/docs">Read the docs</a> &nbsp;|&nbsp; <a href="/reference">Browse the reference</a> &nbsp;|&nbsp;
          <a href="https://github.com/eforge-build/eforge" target="_blank" rel="noopener noreferrer">
            Contribute on GitHub
          </a>
        </p>
      </section>
    </main>
  );
}
