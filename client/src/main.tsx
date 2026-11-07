import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';
import App from './App';
import './style.css';

const connectionBuilder = DbConnection.builder()
  .withUri(import.meta.env.VITE_SPACETIMEDB_URI ?? 'ws://127.0.0.1:3000')
  .withDatabaseName(import.meta.env.VITE_SPACETIMEDB_NAME ?? 'kittune')
  .withAutomaticReconnect()
  .onConnect((_connection, identity) => {
    console.info('Connected to Kittune as', identity.toHexString());
  })
  .onConnectError((_context, error) => console.error('SpacetimeDB connection failed:', error));

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </StrictMode>,
);
