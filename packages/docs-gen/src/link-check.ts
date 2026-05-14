import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import GithubSlugger from 'github-slugger';
import { findRepoRoot } from './output-paths.js';

export interface LinkCheckIssue {
  sourceFile: string;
  href: string;
  reason: string;
}

export interface LinkCheckResult {
  ok: boolean;
  issues: LinkCheckIssue[];
}

export interface LinkCheckOptions {
  repoRoot?: string;
  files?: string[];
}

const SELECTED_REPO_DOCS = [
  'docs/config.md',
  'docs/hooks.md',
  'docs/extensions.md',
  'docs/extensions-api.md',
  'packages/extension-sdk/README.md',
];

const SKILL_DIRS = ['eforge-plugin/skills', 'packages/pi-eforge/skills'];
const CONTENT_DIRS = ['web/content/docs', 'web/content/reference'];
const PUBLIC_DIRS = ['web/public/docs', 'web/public/reference'];
const KNOWN_ROUTES = new Set(['/', '/docs', '/reference', '/why']);
const IGNORED_PROTOCOL_RE = /^(?:mailto|tel):/i;
const HTTP_RE = /^https?:\/\//i;

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function repoRelative(repoRoot: string, path: string): string {
  return toPosix(relative(repoRoot, path));
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(full));
    } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function defaultScanFiles(repoRoot: string): string[] {
  return [
    ...CONTENT_DIRS.flatMap((dir) => walkMarkdownFiles(join(repoRoot, dir))),
    ...PUBLIC_DIRS.flatMap((dir) => walkMarkdownFiles(join(repoRoot, dir))),
    ...SELECTED_REPO_DOCS.map((file) => join(repoRoot, file)).filter(existsSync),
    ...SKILL_DIRS.flatMap((dir) => walkMarkdownFiles(join(repoRoot, dir))),
  ].sort();
}

function stripCodeFences(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/^~~~[\s\S]*?^~~~/gm, '');
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

function extractLinks(markdown: string): string[] {
  const content = stripCodeFences(markdown);
  const links: string[] = [];
  const markdownLinkRe = /(?<!!)\[[^\]\n]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const hrefRe = /href=["']([^"']+)["']/g;
  for (const match of content.matchAll(markdownLinkRe)) links.push(match[1]);
  for (const match of content.matchAll(hrefRe)) links.push(match[1]);
  return links;
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function markdownAnchors(file: string): Set<string> {
  const raw = stripFrontmatter(readFileSync(file, 'utf-8'));
  const content = stripCodeFences(raw);
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      anchors.add(slugger.slug(normalizeHeadingText(atx[2])));
      continue;
    }
    // Minimal support for raw HTML headings in Markdown files.
    const html = /^<h[1-6][^>]*>(.*?)<\/h[1-6]>$/i.exec(line.trim());
    if (html) anchors.add(slugger.slug(normalizeHeadingText(html[1])));
  }
  return anchors;
}

function splitHref(href: string): { pathPart: string; fragment?: string } {
  const hashIndex = href.indexOf('#');
  if (hashIndex === -1) return { pathPart: href };
  return { pathPart: href.slice(0, hashIndex), fragment: href.slice(hashIndex + 1) };
}

function cleanPath(pathPart: string): string {
  return decodeURI(pathPart.split('?')[0]);
}

function resolveInternalAbsolute(repoRoot: string, pathPart: string): string | null {
  const path = cleanPath(pathPart);
  const docsMd = /^\/docs\/([^/]+)\.md$/.exec(path);
  if (docsMd) return join(repoRoot, 'web/public/docs', `${docsMd[1]}.md`);
  const docsPage = /^\/docs\/([^/.]+)\/?$/.exec(path);
  if (docsPage) return join(repoRoot, 'web/content/docs', `${docsPage[1]}.md`);

  const refMd = /^\/reference\/([^/]+)\.md$/.exec(path);
  if (refMd) return join(repoRoot, 'web/public/reference', `${refMd[1]}.md`);
  const refPage = /^\/reference\/([^/.]+)\/?$/.exec(path);
  if (refPage) return join(repoRoot, 'web/content/reference', `${refPage[1]}.md`);

  const schema = /^\/schemas\/(.+)$/.exec(path);
  if (schema) return join(repoRoot, 'web/public/schemas', schema[1]);

  if (KNOWN_ROUTES.has(path.replace(/\/$/, '') || '/')) return null;
  return join(repoRoot, 'web/public', path.replace(/^\//, ''));
}

function resolveRelative(repoRoot: string, sourceFile: string, pathPart: string): string {
  const base = resolve(dirname(sourceFile), cleanPath(pathPart));
  if (existsSync(base)) return base;
  if (!extname(base) && existsSync(`${base}.md`)) return `${base}.md`;
  return base;
}

function parseHref(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

function isMarkdownFile(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

function readDocsNavSlugs(repoRoot: string): string[] {
  const nav = readFileSync(join(repoRoot, 'web/lib/nav.ts'), 'utf-8');
  const docsNavBody = /export const DOCS_NAV:[\s\S]*?= \[([\s\S]*?)\];/.exec(nav)?.[1] ?? '';
  return [...docsNavBody.matchAll(/slug:\s*'([^']+)'/g)].map((match) => match[1]);
}

function addIssue(issues: LinkCheckIssue[], repoRoot: string, sourceFile: string, href: string, reason: string): void {
  issues.push({ sourceFile: repoRelative(repoRoot, sourceFile), href, reason });
}

export async function runLinkCheck(options: LinkCheckOptions = {}): Promise<LinkCheckResult> {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const files = (options.files ?? defaultScanFiles(repoRoot)).map((file) => resolve(file));
  const issues: LinkCheckIssue[] = [];
  const anchorCache = new Map<string, Set<string>>();

  for (const slug of readDocsNavSlugs(repoRoot)) {
    for (const mirror of [`web/content/docs/${slug}.md`, `web/public/docs/${slug}.md`]) {
      if (!existsSync(join(repoRoot, mirror))) {
        issues.push({ sourceFile: 'web/lib/nav.ts', href: mirror, reason: `Missing DOCS_NAV mirror for slug "${slug}"` });
      }
    }
  }

  for (const sourceFile of files) {
    if (!existsSync(sourceFile)) continue;
    const markdown = readFileSync(sourceFile, 'utf-8');
    const sourceRel = repoRelative(repoRoot, sourceFile);
    const sourceIsPublicDoc = sourceRel.startsWith('web/public/docs/') || sourceRel.startsWith('web/public/reference/');

    for (const rawHref of extractLinks(markdown)) {
      const href = rawHref.trim();
      if (!href || IGNORED_PROTOCOL_RE.test(href)) continue;

      try {
        let effectiveHref = href;
        if (HTTP_RE.test(href)) {
          const url = parseHref(href);
          if (!url || url.hostname !== 'eforge.build') continue;
          effectiveHref = `${url.pathname}${url.search}${url.hash}`;
        }

        const { pathPart, fragment } = splitHref(effectiveHref);
        if (sourceIsPublicDoc && /^(?:\.\.\/)*?(?:web\/content|docs\/prd)(?:\/|$)/.test(cleanPath(pathPart))) {
          addIssue(issues, repoRoot, sourceFile, href, 'Public docs link to an unpublished repo-only path');
          continue;
        }

        let target: string | null;
        if (!pathPart) {
          target = sourceFile;
        } else if (pathPart.startsWith('/')) {
          target = resolveInternalAbsolute(repoRoot, pathPart);
        } else {
          target = resolveRelative(repoRoot, sourceFile, pathPart);
        }

        if (target === null) {
          if (fragment) {
            addIssue(issues, repoRoot, sourceFile, href, 'Fragments are not validated for non-Markdown route targets');
          }
          continue;
        }

        if (!existsSync(target)) {
          addIssue(issues, repoRoot, sourceFile, href, `Missing target: ${repoRelative(repoRoot, target)}`);
          continue;
        }
        if (statSync(target).isDirectory()) continue;

        if (fragment && isMarkdownFile(target)) {
          const decodedFragment = decodeURIComponent(fragment);
          const anchors = anchorCache.get(target) ?? markdownAnchors(target);
          anchorCache.set(target, anchors);
          if (!anchors.has(decodedFragment)) {
            addIssue(issues, repoRoot, sourceFile, href, `Missing fragment "#${decodedFragment}" in ${repoRelative(repoRoot, target)}`);
          }
        }
      } catch (error) {
        if (error instanceof URIError) {
          addIssue(issues, repoRoot, sourceFile, href, 'Malformed percent-encoding in link');
          continue;
        }
        throw error;
      }
    }
  }

  return { ok: issues.length === 0, issues };
}
