import type { Highlighter } from 'shiki';

const CODE_LANGS = [
  'yaml',
  'markdown',
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'bash',
  'sql',
  'css',
  'html',
  'go',
  'python',
  'diff',
];

let cachedPromise: Promise<Highlighter> | null = null;

export async function getHighlighter(): Promise<Highlighter> {
  if (!cachedPromise) {
    cachedPromise = (async () => {
      const { createHighlighter } = await import('shiki');
      return createHighlighter({
        themes: ['github-dark'],
        langs: CODE_LANGS,
      });
    })();
  }

  return cachedPromise;
}
