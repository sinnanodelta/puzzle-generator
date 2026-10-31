import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { errorMessage, initWasm } from './wasm';

// The service worker caches the built app, so it is downloaded once per deployment (SPEC §9.2).
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const root = createRoot(document.getElementById('root')!);

initWasm().then(
  () =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  (e) => root.render(<pre className="fatal">Could not load the solver: {errorMessage(e)}</pre>),
);
