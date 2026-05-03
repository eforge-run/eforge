import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { SWRConfigProvider } from './lib/swr-config';
import './globals.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SWRConfigProvider>
      <App />
    </SWRConfigProvider>
  </StrictMode>,
);
