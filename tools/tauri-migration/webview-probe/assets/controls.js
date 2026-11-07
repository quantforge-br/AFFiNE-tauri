// Disposable window-controls fixture. The controls are ordinary buttons that call the window plugin,
// the drag region uses Tauri's own data-tauri-drag-region handling, and native decorations stay hidden.
(() => {
  const internals = window.__TAURI_INTERNALS__;
  const results = (window.__controlsResults = {
    ready: false,
    origin: location.origin,
    timeOrigin: performance.timeOrigin,
    state: null,
    stateSeq: 0,
    stateError: '',
    events: {},
    listening: [],
    ipcRecorded: false,
    suppressDrag: false,
    tries: {},
    report: null,
    reportError: '',
    reportSeq: 0,
    closePermitted: false,
    calls: [],
    actionErrors: [],
    violations: [],
  });
  window.addEventListener('securitypolicyviolation', event =>
    results.violations.push({
      directive: event.effectiveDirective,
      blockedURI: event.blockedURI,
    })
  );
  // __TAURI_INTERNALS__.invoke is defined non-writable and non-configurable, so commands are observed
  // where Tauri sends them: the custom-protocol fetch. This records every command the page or Tauri's own
  // drag script issues, with its outcome, and can swallow only the native start_dragging of a synthetic
  // press (which has no pointer grab) to observe Tauri's drag-region decision.
  try {
    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      let command = '';
      try {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.protocol === 'ipc:' || url.hostname === 'ipc.localhost')
          command = decodeURIComponent(url.pathname.slice(1));
      } catch {
        command = '';
      }
      if (!command) return originalFetch(input, init);
      const record = { command, ok: null, error: '' };
      if (
        !/^plugin:window\|(is_|scale_factor|inner_size|outer_position)/.test(
          command
        )
      )
        results.calls.push(record);
      if (command === 'plugin:window|start_dragging' && results.suppressDrag) {
        record.ok = true;
        record.suppressed = true;
        return Promise.resolve(
          new Response('null', {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Tauri-Response': 'ok',
            },
          })
        );
      }
      const pending = originalFetch(input, init);
      pending.then(
        response => {
          record.ok = response.headers.get('Tauri-Response') === 'ok';
          record.status = response.status;
          if (!record.ok)
            response
              .clone()
              .text()
              .then(body => {
                record.error = body.slice(0, 200);
              });
        },
        error => {
          record.ok = false;
          record.error = String(error).slice(0, 200);
        }
      );
      return pending;
    };
    results.ipcRecorded = true;
  } catch (error) {
    results.ipcRecorded = false;
    results.recorderError = String(error).slice(0, 200);
  }
  const win = (name, args) => internals.invoke('plugin:window|' + name, args);
  async function readState() {
    const [
      maximized,
      minimized,
      decorated,
      resizable,
      fullscreen,
      inner,
      position,
      scale,
    ] = await Promise.all([
      win('is_maximized'),
      win('is_minimized'),
      win('is_decorated'),
      win('is_resizable'),
      win('is_fullscreen'),
      win('inner_size'),
      win('outer_position'),
      win('scale_factor'),
    ]);
    return {
      maximized,
      minimized,
      decorated,
      resizable,
      fullscreen,
      inner,
      position,
      scale,
    };
  }
  const maximize = document.getElementById('maximize');
  let refreshing = false;
  let dirty = false;
  // Reads are coalesced: an event that arrives while a read is in flight schedules exactly one more read,
  // so the last observed state is never older than the last native event.
  async function refresh() {
    if (refreshing) {
      dirty = true;
      return;
    }
    refreshing = true;
    try {
      do {
        dirty = false;
        const state = await readState();
        results.state = state;
        results.stateSeq += 1;
        results.stateError = '';
        // The accessible name always describes what the button will do next.
        maximize.setAttribute(
          'aria-label',
          state.maximized || state.fullscreen
            ? 'Restore window'
            : 'Maximize window'
        );
      } while (dirty);
    } catch (error) {
      results.stateError = String(error).slice(0, 200);
    } finally {
      refreshing = false;
    }
  }
  // The label follows native window events only; there is no polling, so a state change made by the
  // window system or by the host (not by these buttons) is still reflected.
  for (const name of ['tauri://resize', 'tauri://move']) {
    internals
      .invoke('plugin:event|listen', {
        event: name,
        target: { kind: 'Any' },
        handler: internals.transformCallback(() => {
          results.events[name] = (results.events[name] ?? 0) + 1;
          refresh();
        }),
      })
      .then(
        () => results.listening.push(name),
        error =>
          results.actionErrors.push({
            id: 'listen ' + name,
            error: String(error).slice(0, 200),
          })
      );
  }
  function action(id, run) {
    document.getElementById(id).addEventListener('click', () => {
      run().then(refresh, error =>
        results.actionErrors.push({ id, error: String(error).slice(0, 200) })
      );
    });
  }
  action('minimize', () => win('minimize'));
  // Same decision table as the reference handleMaximizeApp: full screen leaves full screen first.
  action('maximize', async () => {
    const state = await readState();
    if (state.fullscreen) {
      await win('set_fullscreen', { value: false });
      await win('unmaximize');
    } else if (state.maximized) {
      await win('unmaximize');
    } else {
      await win('maximize');
    }
  });
  action('close', () => win('close'));
  for (const id of ['tab-one', 'tab-two'])
    document.getElementById(id).addEventListener('click', () => {
      for (const tab of document.querySelectorAll('[role=tab]'))
        tab.setAttribute('aria-selected', String(tab.id === id));
    });

  function mouse(target, type, detail) {
    const box = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
        detail,
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2),
      })
    );
  }
  const rect = id => {
    const box = document.getElementById(id).getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  window.__controls = {
    describe() {
      return ['tab-one', 'tab-two', 'minimize', 'maximize', 'close'].map(id => {
        const element = document.getElementById(id);
        return {
          id,
          tag: element.tagName,
          role: element.getAttribute('role'),
          label:
            element.getAttribute('aria-label') ?? element.textContent.trim(),
          type: element.getAttribute('type'),
          disabled: element.disabled,
          tabIndex: element.tabIndex,
          rect: rect(id),
        };
      });
    },
    dragRect: () => rect('drag'),
    rect,
    // A synthetic double click on an element, exactly as Tauri's drag script sees a real one.
    doubleClick(id) {
      const target = document.getElementById(id);
      mouse(target, 'mousedown', 2);
      mouse(target, 'mouseup', 2);
    },
    // A synthetic single press, which must not start a drag when the element is interactive.
    press(id) {
      const target = document.getElementById(id);
      mouse(target, 'mousedown', 1);
      mouse(target, 'mouseup', 1);
    },
    focusedId: () => document.activeElement?.id ?? '',
    focus: id => document.getElementById(id).focus(),
    callsSince: index => results.calls.slice(index),
    callCount: () => results.calls.length,
    unminimize: () => win('unminimize').then(refresh),
    suppressDrag: value => {
      results.suppressDrag = value;
    },
    // Used to prove that commands outside the capability are rejected for this page. The outcome is
    // stored on the page because a synchronous WebDriver script cannot await it.
    tryInvoke(label, command, args) {
      return internals.invoke(command, args).then(
        () => {
          results.tries[label] = { ok: true, error: '' };
        },
        error => {
          results.tries[label] = {
            ok: false,
            error: String(error).slice(0, 300),
          };
        }
      );
    },
    fetchReport() {
      return internals.invoke('controls_report').then(
        report => {
          results.report = report;
          results.reportError = '';
          results.reportSeq += 1;
        },
        error => {
          results.reportError = String(error).slice(0, 200);
          results.reportSeq += 1;
        }
      );
    },
    permitClose() {
      return internals.invoke('controls_allow_close').then(
        () => {
          results.closePermitted = true;
        },
        error => {
          results.actionErrors.push({
            id: 'permit-close',
            error: String(error).slice(0, 200),
          });
        }
      );
    },
    refresh,
  };
  refresh().then(() => {
    results.ready = results.state !== null;
  });
})();
