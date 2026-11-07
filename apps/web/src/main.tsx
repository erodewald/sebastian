import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import type { Source } from './source.ts';
import { workerSource } from './source.ts';
import './styles.css';

async function pick(): Promise<Source> {
  if (new URLSearchParams(location.search).has('demo')) {
    const { demoSource } = await import('./demo.ts');
    return demoSource();
  }
  return workerSource();
}

const theme = new URLSearchParams(location.search).get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

pick().then((source) => {
  const root = document.getElementById('root');
  if (root)
    createRoot(root).render(
      <StrictMode>
        <App source={source} />
      </StrictMode>,
    );
});
