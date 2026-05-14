import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypePrettyCode from 'rehype-pretty-code';
import rehypeStringify from 'rehype-stringify';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let processorPromise: Promise<Processor<any, any, any, any, string>> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getProcessor(): Promise<Processor<any, any, any, any, string>> {
  if (!processorPromise) {
    processorPromise = Promise.resolve(
      unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypePrettyCode, {
          theme: { light: 'github-light', dark: 'github-dark' },
          keepBackground: false,
        })
        .use(rehypeStringify, { allowDangerousHtml: true }),
    );
  }
  return processorPromise;
}

async function renderMarkdown(content: string): Promise<string> {
  const processor = await getProcessor();
  const result = await processor.process(content);
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
