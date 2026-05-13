import { DOCS_NAV } from '@/lib/nav';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Docs - eforge',
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const groups = [...new Set(DOCS_NAV.map((item) => item.group))];

  return (
    <div
      style={{
        display: 'flex',
        maxWidth: 'var(--max-width)',
        margin: '0 auto',
        padding: 'var(--spacing-xl)',
        gap: 'var(--spacing-2xl)',
      }}
    >
      <aside
        style={{
          width: '220px',
          flexShrink: 0,
          position: 'sticky',
          top: '60px',
          alignSelf: 'flex-start',
          height: 'calc(100vh - 60px)',
          overflowY: 'auto',
        }}
      >
        <nav>
          {groups.map((group) => (
            <div key={group} style={{ marginBottom: 'var(--spacing-lg)' }}>
              <div
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--color-text-muted)',
                  marginBottom: 'var(--spacing-sm)',
                }}
              >
                {group}
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {DOCS_NAV.filter((item) => item.group === group).map((item) => (
                  <li key={item.slug} style={{ marginBottom: '0.25rem' }}>
                    <a
                      href={`/docs/${item.slug}`}
                      style={{ fontSize: '0.9rem', color: 'var(--color-text)', display: 'block', padding: '0.2rem 0' }}
                    >
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
    </div>
  );
}
