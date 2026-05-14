import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Why eforge - asynchronous engineering for planned work',
  description:
    'The argument behind eforge: keep engineering judgment in human hands while implementation runs asynchronously in a provider-flexible agent loop.',
};

const cardStyle = {
  padding: 'var(--spacing-lg)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--border-radius)',
  background: 'var(--color-bg-secondary)',
};

export default function WhyPage() {
  return (
    <main style={{ maxWidth: '960px', margin: '0 auto', padding: 'var(--spacing-2xl) var(--spacing-xl)' }}>
      <article className="prose" style={{ maxWidth: '78ch' }}>
        <p
          style={{
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-accent)',
            fontSize: '0.85rem',
            marginBottom: 'var(--spacing-sm)',
          }}
        >
          Why eforge
        </p>
        <h1 style={{ fontSize: '2.8rem', marginTop: 0, marginBottom: 'var(--spacing-md)' }}>
          Agentic coding made implementation faster. eforge makes implementation asynchronous.
        </h1>
        <p style={{ fontSize: '1.2rem', color: 'var(--color-text-muted)' }}>
          Most AI coding tools still assume the engineer stays in the loop moment by moment. eforge assumes the
          engineer should define the work, hand it off, and come back to review finished artifacts.
        </p>

        <h2>Foreground agents do not change the shape of work enough</h2>
        <p>
          A chat agent can be extremely capable and still keep implementation in the foreground. You ask for a change,
          watch it think, correct it every few minutes, accept edits, rerun tests, and turn the result into a commit.
          The loop is faster, but it is still a loop you sit inside.
        </p>
        <p>
          That is useful. It is not the full shape of agentic engineering. If using an agent still means watching the
          agent, the agent has become a very capable pair programmer. eforge is for the next step: a background
          engineering loop that can run without constant babysitting.
        </p>

        <h2>Planning and building are different jobs</h2>
        <p>
          eforge separates the work you should keep from the work that can run asynchronously. You keep the judgment:
          deciding what should exist, specifying the change, naming constraints, reviewing the result, and steering when
          tradeoffs appear. eforge takes the implementation loop: operational planning, isolated execution, blind review,
          retries, conflict handling, merge flow, and validation.
        </p>
        <p>
          There are two planning layers. You plan the change: goal, context, constraints, and acceptance criteria. eforge
          plans the build: decomposition, dependency order, agent roles, review cycles, and validation. You return at
          artifact boundaries, not token boundaries.
        </p>

        <h2>Why the product looks this way</h2>
        <div style={{ display: 'grid', gap: 'var(--spacing-md)' }}>
          {[
            {
              title: 'Session plans clarify intent before execution starts.',
              body:
                'The human-facing planning loop captures scope, architecture, risks, and acceptance criteria before work enters the build pipeline.',
            },
            {
              title: 'Build plans give agents operational structure.',
              body:
                'The engine turns intent into concrete plan files, dependencies, and stage assignments instead of handing a vague prompt to one agent.',
            },
            {
              title: 'Worktrees make background work safe.',
              body:
                'Delegated plans run in isolated git worktrees so parallel builds do not block your branch or trample each other.',
            },
            {
              title: 'Profiles make runtime choice explicit.',
              body:
                'Agent runtimes, providers, models, and effort levels are engineering decisions. eforge keeps them visible and swappable.',
            },
            {
              title: 'Playbooks turn repeated workflows into artifacts.',
              body:
                'The second time you perform a recurring workflow, it should become reusable process rather than another bespoke prompt.',
            },
            {
              title: 'Commits are the output.',
              body:
                'You review code, history, logs, costs, and build decisions. Chat transcripts are context, not the deliverable.',
            },
          ].map((item) => (
            <section key={item.title} style={cardStyle}>
              <h3 style={{ marginTop: 0 }}>{item.title}</h3>
              <p style={{ marginBottom: 0, color: 'var(--color-text-muted)' }}>{item.body}</p>
            </section>
          ))}
        </div>

        <h2>Built for API economics</h2>
        <p>
          eforge is an engine, not a single chat surface. It can run from Pi, Claude Code, or the CLI, but its direction
          is deliberately Pi-centric: a local, provider-flexible agent environment where cost, context, planning, and
          execution are visible parts of the engineering system.
        </p>
        <p>
          As agent execution moves toward explicit API-priced inference, token efficiency, provider choice, and local
          orchestration matter more. You should be able to choose the runtime, understand the tradeoffs, and route work
          through the system that gives you the best result for the cost. That is why eforge has profiles, why the engine
          is separate from any one host, and why Pi is becoming the primary surface.
        </p>
        <p>
          Bring your own credentials. Use the providers and models that fit the work. Keep the loop durable as the model
          market changes.
        </p>

        <h2>What eforge is not</h2>
        <ul>
          <li>It is not a chat coding assistant.</li>
          <li>It is not autocomplete.</li>
          <li>It is not “one prompt to build my startup.”</li>
          <li>It is not a replacement for engineering judgment; it is built around preserving that judgment.</li>
          <li>
            It is not ideal when you do not yet understand the change you want. eforge can help structure a plan, but it
            cannot decide what your product should be.
          </li>
          <li>It is not finished. eforge is early, used in real work, and still moving quickly.</li>
        </ul>

        <h2>Who should try it</h2>
        <p>
          eforge is for engineers who already think in changes, plans, commits, and review. If you want a chat assistant,
          use one. If you want to hand off implementation and come back to a reviewable result, try eforge.
        </p>

        <h2>Start here</h2>
        <div style={{ ...cardStyle, marginBottom: 'var(--spacing-lg)' }}>
          <h3 style={{ marginTop: 0 }}>Recommended: Pi extension</h3>
          <p style={{ color: 'var(--color-text-muted)' }}>
            Start with the Pi extension if you want the direction eforge is heading: provider-flexible, local,
            inspectable agent orchestration. Use the Claude Code plugin if Claude Code is already your daily
            environment. Use the CLI if you want the engine directly.
          </p>
          <p style={{ marginBottom: 0 }}>
            <a href="/docs/getting-started">Read the setup guide</a> ·{' '}
            <a href="https://github.com/eforge-build/eforge" target="_blank" rel="noopener noreferrer">
              View the source
            </a>
          </p>
        </div>

        <hr />
        <p style={{ color: 'var(--color-text-muted)' }}>
          Built by{' '}
          <a href="https://schaake.solutions" target="_blank" rel="noopener noreferrer">
            Mark Schaake
          </a>
          .
        </p>
      </article>
    </main>
  );
}
