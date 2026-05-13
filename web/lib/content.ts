import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkHtml from 'remark-html';
import { DOCS_CONTENT_DIR, REFERENCE_CONTENT_DIR } from './paths';

export interface DocPage {
  frontmatter: Record<string, unknown>;
  html: string;
}

export interface ReferencePage {
  frontmatter: Record<string, unknown>;
  html: string;
  provenance?: string;
}

const PROVENANCE_RE = /^(?:<!--[^>]*-->\s*\n?)+/;

async function renderMarkdown(content: string): Promise<string> {
  const result = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(content);
  return result.toString();
}

export async function loadDocPage(slug: string): Promise<DocPage> {
  let raw: string;
  try {
    raw = readFileSync(join(DOCS_CONTENT_DIR, `${slug}.md`), 'utf-8');
  } catch {
    throw new Error(`Page not found: ${slug}`);
  }

  const { data: frontmatter, content } = matter(raw);
  const html = await renderMarkdown(content);
  return { frontmatter, html };
}

export async function loadReferencePage(slug: string): Promise<ReferencePage> {
  let raw: string;
  try {
    raw = readFileSync(join(REFERENCE_CONTENT_DIR, `${slug}.md`), 'utf-8');
  } catch {
    throw new Error(`Page not found: ${slug}`);
  }

  const { data: frontmatter, content } = matter(raw);

  // Extract provenance comments from the top of the content
  const provenanceMatch = content.match(PROVENANCE_RE);
  const provenance = provenanceMatch ? provenanceMatch[0].trim() : undefined;
  const bodyContent = provenanceMatch ? content.slice(provenanceMatch[0].length) : content;

  const html = await renderMarkdown(bodyContent);
  return { frontmatter, html, provenance };
}
