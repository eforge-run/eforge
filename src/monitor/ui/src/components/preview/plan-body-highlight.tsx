import { useEffect, useState } from 'react';
import type { Highlighter } from 'shiki';
import { Marked, Renderer } from 'marked';
import { splitPlanContent } from '@/lib/plan-content';
import { getHighlighter } from '@/lib/shiki';

interface PlanBodyHighlightProps {
  content: string;
}

export function PlanBodyHighlight({ content }: PlanBodyHighlightProps) {
  const [loading, setLoading] = useState(true);
  const [highlightedHtml, setHighlightedHtml] = useState<string>('');

  const { frontmatter, body } = splitPlanContent(content);

  useEffect(() => {
    let cancelled = false;

    async function initHighlighter() {
      try {
        const highlighter = await getHighlighter();

        if (cancelled) return;
        render(highlighter);
      } catch (err) {
        console.error('Failed to initialize shiki:', err);
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    function render(highlighter: Highlighter) {
      let html = '';

      if (frontmatter) {
        html += highlighter.codeToHtml(frontmatter, {
          lang: 'yaml',
          theme: 'github-dark',
        });
      }

      if (body) {
        const loadedLangs = highlighter.getLoadedLanguages();

        const renderer = new Renderer();
        renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
          const language = lang?.trim().toLowerCase() ?? '';
          if (language && loadedLangs.includes(language)) {
            return highlighter.codeToHtml(text, {
              lang: language,
              theme: 'github-dark',
            });
          }
          const escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          return `<pre><code>${escaped}</code></pre>`;
        };

        const marked = new Marked({ gfm: true, renderer });
        html += `<div class="plan-prose">${marked.parse(body, { async: false })}</div>`;
      }

      if (!cancelled) {
        setHighlightedHtml(html);
        setLoading(false);
      }
    }

    initHighlighter();

    return () => {
      cancelled = true;
    };
  }, [content]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-dim text-xs py-4">
        <div className="w-4 h-4 border-2 border-text-dim border-t-transparent rounded-full animate-spin" />
        Loading syntax highlighter...
      </div>
    );
  }

  if (!highlightedHtml) {
    // Fallback: render as plain preformatted text
    return (
      <pre className="text-xs text-foreground whitespace-pre-wrap break-words overflow-x-auto">
        {content}
      </pre>
    );
  }

  return (
    <div
      className="text-xs overflow-x-auto [&_pre]:!bg-transparent [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:overflow-x-auto [&_code]:text-xs"
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
    />
  );
}
