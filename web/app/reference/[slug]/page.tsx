import { notFound } from 'next/navigation';
import { loadReferencePage } from '@/lib/content';
import { REFERENCE_NAV } from '@/lib/nav';
import type { Metadata } from 'next';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return REFERENCE_NAV.map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const navItem = REFERENCE_NAV.find((item) => item.slug === slug);
  return {
    title: navItem ? `${navItem.title} - eforge Reference` : 'Reference - eforge',
  };
}

export default async function ReferencePage({ params }: Props) {
  const { slug } = await params;

  // Validate slug is one of the known reference slugs
  const navItem = REFERENCE_NAV.find((item) => item.slug === slug);
  if (!navItem) {
    notFound();
  }

  let page;
  try {
    page = await loadReferencePage(slug);
  } catch {
    notFound();
  }

  return (
    <article className="prose">
      {page.provenance && (
        <div className="provenance-callout">
          Generated reference - {page.provenance.replace(/<!--\s*|\s*-->/g, ' ').replace(/\s+/g, ' ').trim()}
        </div>
      )}
      <div dangerouslySetInnerHTML={{ __html: page.html }} />
      <hr />
      <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
        Raw Markdown:{' '}
        <a href={navItem.raw} target="_blank" rel="noopener noreferrer">
          {navItem.raw}
        </a>
        {navItem.schema && (
          <>
            {' | '}JSON Schema:{' '}
            <a href={navItem.schema} target="_blank" rel="noopener noreferrer">
              {navItem.schema}
            </a>
          </>
        )}
      </p>
    </article>
  );
}
