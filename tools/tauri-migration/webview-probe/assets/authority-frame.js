// Disposable adversarial frame fixture, not an application bridge.
(async () => {
  const outcome = {
    kind: 'authority-frame',
    tag: new URLSearchParams(location.search).get('tag'),
    origin: location.origin,
  };
  try {
    outcome.parentAccessible = !!parent.document;
    outcome.parentTicketCallback =
      typeof parent.__acceptAuthorityTicket === 'function';
  } catch {
    outcome.parentAccessible = false;
    outcome.parentTicketCallback = false;
  }
  outcome.ticketCallback = typeof window.__acceptAuthorityTicket === 'function';
  outcome.nativeGlobals =
    typeof window.__TAURI_INTERNALS__?.invoke === 'function';
  // Same-origin code can reach the parent's JS realm. This is not an isolation boundary.
  const invoke =
    window.__TAURI_INTERNALS__?.invoke ??
    (outcome.parentAccessible ? parent.__TAURI_INTERNALS__?.invoke : undefined);
  outcome.invokeSource = outcome.nativeGlobals
    ? 'frame'
    : invoke
      ? 'parent'
      : 'none';
  if (invoke) {
    try {
      await invoke('authority_ping', {
        request: {
          ticket: '00000000-0000-4000-8000-000000000000',
          challenge: 'untrusted-frame',
        },
      });
      outcome.authorized = true;
    } catch (error) {
      outcome.authorized = false;
      outcome.denial = String(error);
    }
  } else {
    outcome.authorized = false;
    outcome.denial = 'native-invoke-unavailable';
  }
  window.__frameAuthorityOutcome = outcome;
  parent.postMessage(outcome, '*');
})();
