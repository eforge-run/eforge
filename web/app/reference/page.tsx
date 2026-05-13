import { REFERENCE_NAV } from '@/lib/nav';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Reference - eforge',
  description: 'Generated reference documentation for eforge CLI, HTTP API, events, config, and MCP tools.',
};

export default function ReferenceIndexPage() {
  return (
    <article className="prose">
      <h1>Reference</h1>
      <p>
        Auto-generated reference documentation. All pages are generated from source and kept in sync via the{' '}
        <code>docs:check</code> CI step. Raw Markdown files are available under <code>/reference/*.md</code> for
        agent consumption.
      </p>

      <h2>Generated References</h2>
      <ul>
        {REFERENCE_NAV.map((item) => (
          <li key={item.slug}>
            <a href={`/reference/${item.slug}`}>{item.title}</a>
            {' - '}
            <a href={item.raw} style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>
              raw .md
            </a>
            {item.schema && (
              <>
                {' - '}
                <a href={item.schema} style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>
                  JSON schema
                </a>
              </>
            )}
          </li>
        ))}
      </ul>

      <h2>JSON Schemas</h2>
      <ul>
        <li>
          <a href="/schemas/events.schema.json">events.schema.json</a> - TypeBox-derived event wire schema
        </li>
        <li>
          <a href="/schemas/config.schema.json">config.schema.json</a> - eforge config file schema
        </li>
      </ul>

      <h2>Agent-Readable Files</h2>
      <ul>
        <li>
          <a href="/llms.txt">llms.txt</a> - Concise overview for AI agents
        </li>
        <li>
          <a href="/llms-full.txt">llms-full.txt</a> - Full reference content for AI agents
        </li>
      </ul>
    </article>
  );
}
