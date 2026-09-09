import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Patch global fetch to always include credentials (cookies) for same-origin
// API calls. Without this, the HttpOnly session cookie set by /api/auth/login
// is never sent back on subsequent requests, causing 401 "Vui lòng đăng nhập".
const _nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
  const isSameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);
  if (isSameOrigin && !init.credentials) {
    init = { ...init, credentials: 'include' };
  }
  return _nativeFetch(input, init);
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
