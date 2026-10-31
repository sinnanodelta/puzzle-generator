import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { errorMessage, initWasm } from './wasm';

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
