postMessage({
  kind: 'authority-worker',
  nativeGlobals: ['__TAURI__', '__TAURI_INTERNALS__'].filter(
    key => key in globalThis
  ),
  ticketCallback: typeof globalThis.__acceptAuthorityTicket === 'function',
});
