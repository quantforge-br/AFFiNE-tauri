// Test-only page. Its one-shot native ticket is never included in evidence or window messages.
window.addEventListener('error', event =>
  console.error('AUTHORITY_PAGE_ERROR', event.message)
);
(() => {
  const previous = JSON.parse(
    sessionStorage.getItem('authority-reload-fixture') ?? 'null'
  );
  sessionStorage.removeItem('authority-reload-fixture');
  const result = {
    done: false,
    checks: previous?.checks ?? [],
    origin: location.origin,
    timeOrigin: performance.timeOrigin,
  };
  window.__authorityResults = result;
  const violations = [];
  window.addEventListener('securitypolicyviolation', event =>
    violations.push({
      directive: event.effectiveDirective,
      blockedURI: event.blockedURI,
    })
  );
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const record = (name, detail = {}) =>
    result.checks.push({ name, passed: true, ...detail });
  const invoke = (command, request) =>
    window.__TAURI_INTERNALS__.invoke(command, { request });
  const denied = async (command, request) => {
    try {
      await invoke(command, request);
    } catch (error) {
      return String(error);
    }
    throw new Error('Unauthorized command succeeded: ' + command);
  };
  async function frame(tag, sandbox) {
    const element = document.createElement('iframe');
    element.addEventListener('load', () => {
      (result.frameLoads ??= []).push(tag);
    });
    element.addEventListener('error', () => {
      (result.frameErrors ??= []).push(tag);
    });
    if (sandbox) element.setAttribute('sandbox', 'allow-scripts');
    const source =
      tag === 'same-origin'
        ? '/authority-frame.html'
        : 'http://127.0.0.1:8080/frame.html';
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(tag + ' frame did not report'));
      }, 12_000);
      const listener = event => {
        if (
          event.source !== element.contentWindow ||
          event.data?.kind !== 'authority-frame' ||
          event.data.tag !== tag
        )
          return;
        cleanup();
        resolve({ ...event.data, messageOrigin: event.origin });
      };
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', listener);
      }
      window.addEventListener('message', listener);
    });
    element.src = source + '?tag=' + tag;
    document.body.append(element);
    try {
      return await promise;
    } finally {
      element.remove();
    }
  }
  async function worker() {
    const instance = new Worker('/authority-worker.js');
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Worker did not report')),
          8000
        );
        instance.onmessage = event => {
          clearTimeout(timer);
          resolve(event.data);
        };
        instance.onerror = () => {
          clearTimeout(timer);
          reject(new Error('Worker failed'));
        };
      });
    } finally {
      instance.terminate();
    }
  }
  async function run(ticket, generation) {
    assert(window === window.top, 'Ticket reached a subframe');
    const current = await invoke('authority_ping', {
      ticket,
      challenge: previous ? 'after-reload' : 'main-document',
    });
    assert(current.generation === generation, 'Wrong document generation');
    assert(
      current.challenge === (previous ? 'after-reload' : 'main-document'),
      'Wrong response'
    );
    if (previous) {
      assert(
        performance.timeOrigin !== previous.timeOrigin,
        'Reload did not replace the document'
      );
      assert(
        generation > previous.generation,
        'Native generation did not advance'
      );
      const denial = await denied('authority_ping', {
        ticket: previous.ticket,
        challenge: 'stale-document',
      });
      assert(
        denial === 'UNAUTHORIZED',
        'Previous document ticket was not rejected by native authority'
      );
      const after = await invoke('authority_ping', {
        ticket,
        challenge: 'after-stale-denial',
      });
      assert(
        after.sequence === current.sequence + 1,
        'Rejected old ticket changed native acceptance count'
      );
      record('real-reload-revokes-previous-document', {
        generation,
        timeOriginChanged: true,
        denial,
      });
      assert(violations.length === 0, 'Unexpected CSP violation after reload');
      result.violations = violations;
      result.done = true;
      document.getElementById('results').textContent = JSON.stringify(
        result,
        null,
        2
      );
      return;
    }
    record('host-ticket-main-document', { generation });
    const forged = await denied('authority_ping', {
      ticket: '00000000-0000-4000-8000-000000000000',
      challenge: 'forged',
    });
    assert(forged === 'UNAUTHORIZED', 'Forged ticket not rejected');
    record('forged-ticket-denied', { denial: forged });
    for (const key of ['owner', 'path', 'handle', 'windowLabel']) {
      const error = await denied('authority_ping', {
        ticket,
        challenge: 'extra-authority',
        [key]: 'forged',
      });
      assert(
        error.includes('unknown field'),
        'Unknown authority field was not rejected: ' + key
      );
    }
    record('renderer-authority-fields-denied');
    const forbidden = await denied('authority_forbidden', {
      ticket,
      challenge: 'forbidden',
    });
    assert(
      forbidden.includes('not allowed'),
      'Command without capability was not ACL denied'
    );
    record('ungranted-app-command-denied', { denial: forbidden });
    for (const [tag, sandbox] of [
      ['same-origin', false],
      ['cross-origin', false],
      ['opaque-sandbox', true],
    ]) {
      const outcome = await frame(tag, sandbox);
      assert(
        !outcome.authorized &&
          !outcome.ticketCallback &&
          !outcome.parentTicketCallback,
        tag + ' obtained authority'
      );
      if (tag === 'same-origin') {
        assert(
          outcome.parentAccessible,
          'Same-origin fixture did not share the main document origin'
        );
        assert(
          outcome.messageOrigin === location.origin,
          'Same-origin fixture did not load'
        );
        assert(
          outcome.denial === 'UNAUTHORIZED',
          'Same-origin forged call was not rejected by the ticket check'
        );
      } else {
        assert(
          !outcome.parentAccessible,
          'Untrusted frame accessed parent DOM'
        );
        if (sandbox)
          assert(
            outcome.messageOrigin === 'null',
            'Sandbox frame was not opaque'
          );
        else
          assert(
            outcome.messageOrigin === 'http://127.0.0.1:8080',
            'Cross-origin frame did not load'
          );
      }
      record(
        tag === 'same-origin'
          ? 'same-origin-forged-ticket-denied'
          : 'untrusted-' + tag + '-denied',
        outcome
      );
    }
    const outcome = await worker();
    assert(
      outcome.nativeGlobals.length === 0 && !outcome.ticketCallback,
      'Worker received native authority'
    );
    record('worker-has-no-native-bootstrap', outcome);
    const after = await invoke('authority_ping', {
      ticket,
      challenge: 'after-negative-tests',
    });
    assert(
      after.sequence === current.sequence + 1,
      'A negative test reached the authorized command'
    );
    assert(
      violations.length === 0,
      'Unexpected CSP violation in authority diagnostic'
    );
    // Deliberate disposable stale-token fixture, never an application credential persistence design.
    sessionStorage.setItem(
      'authority-reload-fixture',
      JSON.stringify({
        ticket,
        generation,
        checks: result.checks,
        timeOrigin: performance.timeOrigin,
      })
    );
    setTimeout(() => location.reload(), 0);
  }
  Object.defineProperty(window, '__acceptAuthorityTicket', {
    configurable: true,
    value(ticket, generation) {
      delete window.__acceptAuthorityTicket;
      void run(ticket, generation).catch(error => {
        result.failure = String(error);
        result.violations = violations;
        result.done = true;
        document.getElementById('results').textContent = JSON.stringify(
          result,
          null,
          2
        );
      });
    },
  });
})();
