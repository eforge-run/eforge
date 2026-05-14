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
            href="/why"
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
            Why eforge
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
            eforge is for work where the intent is clear enough to delegate. Define the goal, constraints, and acceptance criteria;
            eforge manages implementation, review, retries, conflict handling, and merge flow.
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
              title: 'Plan the change',
              description:
                'Use a PRD, issue, rough prompt, playbook, or structured session plan to make intent explicit before implementation starts.',
            },
            {
              title: 'Hand off execution',
              description:
                'eforge decomposes the work, schedules build plans, and runs implementation in isolated git worktrees.',
            },
            {
              title: 'Automate the engineering loop',
              description:
                'Implementation, blind review, retries, conflict handling, merge flow, and validation are managed without constant babysitting.',
            },
            {
              title: 'Review real outputs',
              description:
                'You stay focused on direction and final judgment with traceable commits, logs, costs, and build decisions.',
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
          <h2 style={{ marginBottom: 'var(--spacing-md)' }}>Built for repeatable, provider-flexible handoffs</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '1.1rem', margin: 0 }}>
            Standardize how work is delegated, which agent runtimes run it, and what cost/performance tradeoffs you want.
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
              title: 'Bring your own credentials',
              description:
                'Run against your chosen providers directly. No subscription wrapper, no hidden inference markup, and no single-runtime lock-in.',
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
              <h3 style={{ margin: '0 0 var(--spacing-sm)' }}>{item.title}</h3>
              <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Install paths */}
      <section style={{ marginBottom: 'var(--spacing-2xl)' }}>
        <div style={{ textAlign: 'center', maxWidth: '760px', margin: '0 auto var(--spacing-xl)' }}>
          <h2 style={{ marginBottom: 'var(--spacing-md)' }}>Choose your surface</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '1.1rem', margin: 0 }}>
            eforge is one engine with multiple host surfaces. Start with Pi for the direction eforge is heading; use Claude Code
            or the CLI when those fit your workflow better.
          </p>
        </div>
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
              border: '1px solid var(--color-accent)',
              borderRadius: 'var(--border-radius)',
              background: 'var(--color-bg-secondary)',
              boxShadow: '0 0 32px rgba(103, 245, 83, 0.08)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-sm)' }}>
              <h3 style={{ margin: 0 }}>Pi extension</h3>
              <span
                style={{
                  border: '1px solid var(--color-accent)',
                  borderRadius: '999px',
                  color: 'var(--color-accent)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.7rem',
                  padding: '0.1rem 0.4rem',
                }}
              >
                Recommended
              </span>
            </div>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
              Use eforge as a Pi extension for provider-flexible, local, inspectable agent orchestration with Pi&apos;s native UX.
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
            <h3 style={{ marginTop: 0 }}>Claude Code plugin</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
              Use eforge from Claude Code when that is already your daily environment. The engine and execution profile remain separate.
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
            <h3 style={{ marginTop: 0 }}>Standalone CLI</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
              Use eforge as a standalone CLI tool for scripting, automation, and direct engine usage.
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
          <a href="/why">Read why eforge exists</a> &nbsp;|&nbsp; <a href="/docs">Read the docs</a> &nbsp;|&nbsp;{' '}
          <a href="/reference">Browse the reference</a> &nbsp;|&nbsp;
          <a href="https://github.com/eforge-build/eforge" target="_blank" rel="noopener noreferrer">
            Contribute on GitHub
          </a>
        </p>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
          Built by{' '}
          <a href="https://schaake.solutions" target="_blank" rel="noopener noreferrer">
            Mark Schaake
          </a>
          .
        </p>
      </section>
    </main>
  );
}
