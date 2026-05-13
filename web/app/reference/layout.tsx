import { REFERENCE_NAV } from '@/lib/nav';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Reference - eforge',
};

export default function ReferenceLayout({ children }: { children: React.ReactNode }) {
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
            Generated Reference
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {REFERENCE_NAV.map((item) => (
              <li key={item.slug} style={{ marginBottom: '0.25rem' }}>
                <a
                  href={`/reference/${item.slug}`}
                  style={{ fontSize: '0.9rem', color: 'var(--color-text)', display: 'block', padding: '0.2rem 0' }}
                >
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
    </div>
  );
}
