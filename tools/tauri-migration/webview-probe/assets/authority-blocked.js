(async () => {
  const result = { done: false, authorized: false };
  window.__blockedAuthority = result;
  try {
    await window.__TAURI_INTERNALS__.invoke('authority_ping', {
      request: {
        ticket: '00000000-0000-4000-8000-000000000000',
        challenge: 'blocked-window',
      },
    });
    result.authorized = true;
  } catch (error) {
    result.denial = String(error);
  }
  result.done = true;
})();
