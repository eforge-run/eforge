import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';

export const metadata: Metadata = {
  title: 'eforge - agentic build system',
  description: 'eforge is an autonomous plan-build-review orchestration engine for agentic code generation.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="site-nav">
          <a href="/" className="nav-brand">
            <img
              src="https://avatars.githubusercontent.com/u/272340669?v=4"
              alt="eforge logo"
              style={{ width: '28px', height: '28px', borderRadius: '4px', marginRight: '0.5rem' }}
            />
            eforge
          </a>
          <ul className="nav-links">
            <li>
              <a href="/why">Why eforge</a>
            </li>
            <li>
              <a href="/docs">Docs</a>
            </li>
            <li>
              <a href="/reference">Reference</a>
            </li>
            <li>
              <a href="https://github.com/eforge-build/eforge" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
            </li>
            <li>
              <a href="https://www.npmjs.com/package/@eforge-build/eforge" target="_blank" rel="noopener noreferrer">
                npm
              </a>
            </li>
          </ul>
        </nav>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
