import { notFound } from 'next/navigation';
import { loadDocPage } from '@/lib/content';
import { DOCS_NAV } from '@/lib/nav';
import type { Metadata } from 'next';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return DOCS_NAV.map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const navItem = DOCS_NAV.find((item) => item.slug === slug);
  return {
    title: navItem ? `${navItem.title} - eforge Docs` : 'Docs - eforge',
  };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;

  let page;
  try {
    page = await loadDocPage(slug);
  } catch {
    notFound();
  }

  const title = (page.frontmatter.title as string | undefined) ?? slug;

  return (
    <article className="prose">
      <h1>{title}</h1>
      <div dangerouslySetInnerHTML={{ __html: page.html }} />
    </article>
  );
}
