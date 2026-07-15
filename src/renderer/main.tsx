import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './highlight-themes/omp-light.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
