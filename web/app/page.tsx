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
            background: 'linear-gradient(135deg, var(--color-accent), #7c3aed)',
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
          Autonomous plan-build-review orchestration for agentic code generation.
        </p>
        <div style={{ display: 'flex', gap: 'var(--spacing-md)', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a
            href="/docs/getting-started"
            style={{
              display: 'inline-block',
              padding: '0.75rem 1.5rem',
              background: 'var(--color-accent)',
              color: '#ffffff',
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

      {/* Feature highlights */}
      <section style={{ marginBottom: 'var(--spacing-2xl)' }}>
        <h2 style={{ textAlign: 'center', marginBottom: 'var(--spacing-xl)' }}>How it works</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 'var(--spacing-lg)',
          }}
        >
          {[
            {
              title: 'Plan',
              description: 'Decomposes your PRD or issue into parallelizable build plans with dependency graphs.',
              icon: '1',
            },
            {
              title: 'Build',
              description:
                'Each plan runs in an isolated git worktree with a scoped AI agent, producing a real commit.',
              icon: '2',
            },
            {
              title: 'Review',
              description: 'An independent review agent validates the output against acceptance criteria.',
              icon: '3',
            },
            {
              title: 'Merge',
              description: 'Passing builds are merged back automatically, with conflict resolution when needed.',
              icon: '4',
            },
          ].map((step) => (
            <div
              key={step.icon}
              style={{
                padding: 'var(--spacing-lg)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--border-radius)',
              }}
            >
              <div
                style={{
                  width: '2rem',
                  height: '2rem',
                  background: 'var(--color-accent)',
                  color: '#fff',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  marginBottom: 'var(--spacing-sm)',
                }}
              >
                {step.icon}
              </div>
              <h3 style={{ margin: '0 0 var(--spacing-sm)' }}>{step.title}</h3>
              <p style={{ margin: 0, color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>{step.description}</p>
            </div>
          ))}
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
