import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Native window-controls diagnostic for the permanently hidden decorations requirement. The page owns
// the minimize, maximize/restore and close controls plus the drag region; this collector drives them
// through the driver (synthetic DOM events) and observes the result from outside the page: the driver's
// native window rectangle, the X11 window properties on Linux and the Win32 window on Windows. Where a
// platform has a reliable way to inject real pointer or keyboard input it is used (X11 here); the rest is
// listed under notRun instead of being claimed.
const base = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4460';
const TITLE = 'AFFiNE Window Controls Diagnostic';
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const linux = process.platform === 'linux';
const windows = process.platform === 'win32';
let sessionId;
let evidence = {
  scope:
    'Disposable custom window-controls diagnostic; hidden native decorations, no storage, no production frontend',
  checks: [],
  notRun: [],
};
const transientScriptTimeouts = [];

async function request(method, route, body) {
  const response = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45_000),
  });
  const value = await response.json();
  if (!response.ok || value.value?.error)
    throw new Error(JSON.stringify(value));
  return value.value;
}
const session = route => '/session/' + sessionId + route;
const execute = script =>
  request('POST', session('/execute/sync'), { script, args: [] });
// A script can time out while the window is being minimized or replaced. Only that exact timeout is
// retried, every occurrence is recorded and the page evidence is still required.
async function poll(script) {
  try {
    return await execute(script);
  } catch (error) {
    if (
      !String(error).includes('script timeout') ||
      transientScriptTimeouts.length >= 12
    )
      throw error;
    transientScriptTimeouts.push({
      at: new Date().toISOString(),
      script: script.slice(0, 60),
    });
    return undefined;
  }
}
const nativeRect = () => request('GET', session('/window/rect'));
const pageResults = () => poll('return window.__controlsResults');
const pageState = async () => (await pageResults())?.state;
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
function record(name, details = {}) {
  evidence.checks.push({ name, passed: true, ...details });
}
async function until(label, read, accept, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await read();
    if (accept(last)) return last;
    if (Date.now() > deadline)
      throw new Error(
        'Timed out waiting for ' + label + '; last=' + JSON.stringify(last)
      );
    await delay(100);
  }
}
function run(file, args, timeout = 15_000) {
  return new Promise(resolve =>
    execFile(
      file,
      args,
      { timeout, windowsHide: true },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: String(stdout),
          stderr: String(stderr),
          error: error ? String(error.message) : '',
        })
    )
  );
}
async function clickControl(id) {
  const clickable = await execute(
    'const e = document.getElementById("' +
      id +
      '"); const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width > 0 && r.height > 0 && (t === e || e.contains(t));'
  );
  assert.equal(clickable, true, id + ' is not clickable at its centre');
  const found = await request('POST', session('/element'), {
    using: 'css selector',
    value: '#' + id,
  });
  await request('POST', session('/element/' + found[ELEMENT] + '/click'), {});
}
const label = id =>
  execute(
    'return document.getElementById("' + id + '").getAttribute("aria-label")'
  );
async function report() {
  const before = (await pageResults()).reportSeq;
  await execute('window.__controls.fetchReport(); return true');
  const latest = await until(
    'native report',
    pageResults,
    value => value?.reportSeq > before
  );
  assert.equal(latest.reportError, '', 'report command failed');
  return latest.report;
}
async function tryInvoke(name, command, args) {
  await execute(
    'window.__controls.tryInvoke(' +
      JSON.stringify(name) +
      ', ' +
      JSON.stringify(command) +
      ', ' +
      JSON.stringify(args ?? {}) +
      '); return true'
  );
  const finished = await until(
    'outcome of ' + command,
    pageResults,
    value => value?.tries?.[name] !== undefined
  );
  return finished.tries[name];
}

// ---- platform native observation -------------------------------------------------------------
async function x11WindowId() {
  const found = await run('xdotool', ['search', '--name', TITLE]);
  assert.ok(found.ok, 'xdotool search failed: ' + found.error);
  const candidates = found.stdout.split(/\s+/).filter(Boolean);
  for (const id of candidates) {
    const pid = await run('xprop', ['-id', id, '_NET_WM_PID']);
    if (pid.ok && /_NET_WM_PID\(CARDINAL\) = \d+/.test(pid.stdout)) return id;
  }
  throw new Error(
    'No top-level X11 window titled ' + TITLE + ': ' + found.stdout
  );
}
const numbers = text => (text.match(/0x[0-9a-f]+|-?\d+/gi) ?? []).map(Number);
async function x11Properties(id) {
  const result = await run('xprop', [
    '-id',
    id,
    '_MOTIF_WM_HINTS',
    '_NET_FRAME_EXTENTS',
    '_NET_WM_STATE',
  ]);
  assert.ok(result.ok, 'xprop failed: ' + result.error);
  const line = name =>
    result.stdout.split('\n').find(value => value.startsWith(name)) ?? '';
  const motif = line('_MOTIF_WM_HINTS');
  const frame = line('_NET_FRAME_EXTENTS');
  const state = line('_NET_WM_STATE');
  return {
    motif: numbers(motif.split('=')[1] ?? ''),
    frameExtents: numbers(frame.split('=')[1] ?? ''),
    states: (state.split('=')[1] ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    raw: result.stdout.trim().split('\n'),
  };
}
async function x11Geometry(id) {
  const result = await run('xdotool', ['getwindowgeometry', '--shell', id]);
  assert.ok(result.ok, 'xdotool getwindowgeometry failed: ' + result.error);
  const value = {};
  for (const row of result.stdout.split('\n')) {
    const [key, number] = row.split('=');
    if (key && number !== undefined) value[key.trim()] = Number(number);
  }
  return value;
}
let powershellScript;
async function win32() {
  if (!powershellScript) {
    const directory = await mkdtemp(path.join(tmpdir(), 'controls-'));
    powershellScript = path.join(directory, 'window.ps1');
    await writeFile(
      powershellScript,
      [
        "Add-Type -TypeDefinition @'",
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class NativeWindow {',
        '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
        '  [DllImport("user32.dll")] public static extern long GetWindowLongPtrW(IntPtr h, int i);',
        '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
        '  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);',
        '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }',
        '  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);',
        '  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);',
        '  public static long Hit(IntPtr h, int x, int y) {',
        '    long lparam = ((long)(ushort)y << 16) | (long)(ushort)x;',
        '    return SendMessageW(h, 0x84, IntPtr.Zero, new IntPtr(lparam)).ToInt64();',
        '  }',
        '}',
        "'@",
        '$title = $args[0]',
        '$process = Get-Process | Where-Object { $_.MainWindowTitle -eq $title } | Select-Object -First 1',
        'if (-not $process) { Write-Output "{}"; exit 0 }',
        '$h = $process.MainWindowHandle',
        '$r = New-Object NativeWindow+RECT',
        '[void][NativeWindow]::GetWindowRect($h, [ref]$r)',
        '$c = New-Object NativeWindow+RECT',
        '[void][NativeWindow]::GetClientRect($h, [ref]$c)',
        '$o = New-Object NativeWindow+POINT',
        '[void][NativeWindow]::ClientToScreen($h, [ref]$o)',
        '$w = $r.Right - $r.Left; $t = $r.Bottom - $r.Top',
        '$midX = $r.Left + [int]($w / 2); $midY = $r.Top + [int]($t / 2)',
        '$hits = [ordered]@{',
        '  right = [NativeWindow]::Hit($h, $r.Right - 2, $midY)',
        '  left = [NativeWindow]::Hit($h, $r.Left + 2, $midY)',
        '  bottom = [NativeWindow]::Hit($h, $midX, $r.Bottom - 2)',
        '  top = [NativeWindow]::Hit($h, $midX, $r.Top + 2)',
        '  bottomRight = [NativeWindow]::Hit($h, $r.Right - 2, $r.Bottom - 2)',
        '  centre = [NativeWindow]::Hit($h, $midX, $midY)',
        '}',
        '[pscustomobject]@{',
        '  pid = $process.Id',
        '  style = [NativeWindow]::GetWindowLongPtrW($h, -16)',
        '  exStyle = [NativeWindow]::GetWindowLongPtrW($h, -20)',
        '  iconic = [NativeWindow]::IsIconic($h)',
        '  zoomed = [NativeWindow]::IsZoomed($h)',
        '  rect = [pscustomobject]@{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }',
        '  frame = [pscustomobject]@{ left = $o.X - $r.Left; top = $o.Y - $r.Top; right = $r.Right - ($o.X + $c.Right); bottom = $r.Bottom - ($o.Y + $c.Bottom) }',
        '  hits = $hits',
        '} | ConvertTo-Json -Compress -Depth 4',
      ].join('\r\n') + '\r\n'
    );
  }
  const result = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      powershellScript,
      TITLE,
    ],
    60_000
  );
  assert.ok(result.ok, 'PowerShell failed: ' + result.error + result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

try {
  sessionId = (
    await request('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'tauri:options': { application: process.env.PROBE_BINARY },
        },
      },
    })
  ).sessionId;
  evidence.transientScriptTimeouts = transientScriptTimeouts;
  await request('POST', session('/timeouts'), { script: 5_000 });

  let x11Window;
  if (linux) {
    const root = await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']);
    const managerId = root.stdout.match(/window id # (0x[0-9a-f]+)/i)?.[1];
    assert.ok(managerId, 'no EWMH window manager is running: ' + root.stdout);
    const name = await run('xprop', ['-id', managerId, '_NET_WM_NAME']);
    evidence.windowManager = name.stdout.trim();
    const versions = {
      xdotool: await run('xdotool', ['version']),
      xprop: await run('xprop', ['-version']),
    };
    for (const [tool, result] of Object.entries(versions))
      assert.ok(result.ok, tool + ' is required on Linux: ' + result.error);
    evidence.x11Tools = Object.fromEntries(
      Object.entries(versions).map(([tool, result]) => [
        tool,
        (result.stdout + result.stderr).trim().split('\n')[0],
      ])
    );
  }

  await until(
    'page ready',
    pageResults,
    value => value?.ready === true && value.listening.length === 2,
    30_000
  );
  const initial = await pageResults();
  evidence.origin = initial.origin;
  evidence.initialRect = await nativeRect();
  // The application asks for a large window, which can exceed a small runner screen. Operating system
  // behaviour for a window larger than its screen (for example macOS clamping it when leaving full
  // screen) would then be measured instead of the controls, so the checks start from a window that fits.
  {
    const available = await execute(
      'return [screen.availWidth, screen.availHeight]'
    );
    const target = {
      x: 40,
      y: 40,
      width: Math.min(1000, available[0] - 160),
      height: Math.min(600, available[1] - 160),
    };
    await request('POST', session('/window/rect'), target);
    const fitted = await until(
      'window resized to fit the screen',
      nativeRect,
      value =>
        near(value.width, target.width, 24) &&
        near(value.height, target.height, 24)
    );
    evidence.available = available;
    evidence.fittedRect = fitted;
  }
  const dpr = await execute('return window.devicePixelRatio');
  evidence.devicePixelRatio = dpr;
  if (linux) x11Window = await x11WindowId();

  // 1. No native decorations from construction, observed by the toolkit and by the window system.
  {
    assert.equal(initial.state.decorated, false);
    assert.equal(initial.ipcRecorded, true, 'command recorder not installed');
    // The recorder must really see Tauri's own traffic, otherwise later "no call" checks would be vacuous.
    assert.ok(
      initial.calls.filter(
        call => call.command === 'plugin:event|listen' && call.ok === true
      ).length >= 2,
      'the recorder did not observe the event subscriptions: ' +
        JSON.stringify(initial.calls)
    );
    const details = { toolkitDecorated: initial.state.decorated };
    if (linux) {
      const properties = await x11Properties(x11Window);
      details.x11 = properties;
      assert.ok(
        properties.motif.length >= 3 && (properties.motif[0] & 2) !== 0,
        'no _MOTIF_WM_HINTS decorations hint: ' + properties.raw.join(' | ')
      );
      assert.equal(properties.motif[2], 0, 'window system draws decorations');
      assert.deepEqual(
        properties.frameExtents,
        [0, 0, 0, 0],
        'window manager reports a frame around the window'
      );
    } else if (windows) {
      const native = await win32();
      details.win32 = { style: native.style, exStyle: native.exStyle };
      assert.ok(native.style, 'Win32 window not found by title');
      // tao keeps WS_CAPTION on undecorated windows and removes the caption in WM_NCCALCSIZE, so the style
      // bit proves nothing. What counts is the measured non-client frame.
      // The window keeps tao's undecorated shadow, which makes DWM reserve a thin invisible resize border
      // (about 8 px at 100% scale on the sides and bottom, 1 px at the top). A title bar would be 30 px or
      // more at the top, so the top inset is what proves it is gone; the exact insets are recorded.
      details.win32.frame = native.frame;
      assert.ok(
        native.frame.top >= 0 && native.frame.top <= 2,
        'Windows reserves a title bar: ' + JSON.stringify(native.frame)
      );
      for (const side of ['left', 'right', 'bottom'])
        assert.ok(
          native.frame[side] >= 0 && native.frame[side] <= 12,
          'Windows reserves a wide ' +
            side +
            ' border: ' +
            JSON.stringify(native.frame)
        );
    } else {
      evidence.notRun.push({
        name: 'window-system-decoration-query',
        reason:
          'macOS exposes no unprivileged way to read the NSWindow style mask of another process; only the toolkit report is available',
      });
    }
    record('undecorated-at-construction', details);
  }

  // 2. Accessible, reachable controls.
  {
    const controls = await execute('return window.__controls.describe()');
    const byId = Object.fromEntries(
      controls.map(control => [control.id, control])
    );
    const expected = {
      minimize: 'Minimize window',
      maximize: 'Maximize window',
      close: 'Close window',
    };
    for (const [id, name] of Object.entries(expected)) {
      const control = byId[id];
      assert.equal(control.tag, 'BUTTON', id + ' is not a native button');
      assert.equal(control.type, 'button');
      assert.equal(control.label, name);
      assert.equal(control.disabled, false);
      assert.equal(control.tabIndex, 0, id + ' is not in the tab order');
      assert.ok(
        control.rect.width >= 24 && control.rect.height >= 24,
        id + ' is smaller than 24 CSS px'
      );
    }
    for (const id of ['tab-one', 'tab-two']) assert.equal(byId[id].role, 'tab');
    const viewport = await execute('return window.innerWidth');
    assert.ok(
      byId.minimize.rect.x < byId.maximize.rect.x &&
        byId.maximize.rect.x < byId.close.rect.x,
      'controls are not ordered minimize, maximize, close'
    );
    assert.ok(
      near(byId.close.rect.x + byId.close.rect.width, viewport, 1),
      'close is not at the right edge'
    );
    const group = await execute(
      'const g = document.getElementById("minimize").parentElement; return [g.getAttribute("role"), g.getAttribute("aria-label")]'
    );
    assert.deepEqual(group, ['group', 'Window controls']);
    const drag = await execute(
      'return document.getElementById("drag").getAttribute("data-tauri-drag-region")'
    );
    assert.equal(drag, '');
    record('window-controls-accessible', { controls, viewport });
  }

  // 3. The page must not be able to bring decorations back or do anything else outside its capability.
  {
    const denied = {};
    const attempts = [
      ['set-decorations', 'plugin:window|set_decorations', { value: true }],
      ['set-title', 'plugin:window|set_title', { value: 'hijacked' }],
      ['destroy', 'plugin:window|destroy', {}],
      ['hide', 'plugin:window|hide', {}],
      ['always-on-top', 'plugin:window|set_always_on_top', { value: true }],
      ['skip-taskbar', 'plugin:window|set_skip_taskbar', { value: true }],
      ['closable', 'plugin:window|set_closable', { value: false }],
      ['shadow', 'plugin:window|set_shadow', { value: false }],
    ];
    for (const [name, command, args] of attempts) {
      const outcome = await tryInvoke(name, command, args);
      assert.equal(outcome.ok, false, command + ' was allowed');
      assert.match(outcome.error, /not allowed/, command);
      denied[name] = outcome.error;
    }
    const state = await pageState();
    assert.equal(state.decorated, false);
    record('ungranted-window-commands-denied', { denied });
  }

  // 4. Tauri's own drag-region logic: drag from the empty region only, never from controls or tabs. The
  // native move itself is suppressed here (a synthetic press has no pointer grab) and exercised below
  // with real pointer events where the platform allows it.
  {
    await execute('window.__controls.suppressDrag(true); return true');
    const start = await execute('return window.__controls.callCount()');
    await execute('window.__controls.press("drag"); return true');
    const afterDrag = await execute(
      'return window.__controls.callsSince(' + start + ')'
    );
    assert.ok(
      afterDrag.some(
        call =>
          call.command === 'plugin:window|start_dragging' && call.suppressed
      ),
      'pressing the drag region did not request a drag'
    );
    const beforeOthers = await execute('return window.__controls.callCount()');
    for (const id of ['minimize', 'maximize', 'close', 'tab-one', 'tab-two'])
      await execute('window.__controls.press("' + id + '"); return true');
    await execute('window.__controls.doubleClick("tab-one"); return true');
    await execute('window.__controls.doubleClick("minimize"); return true');
    const others = await execute(
      'return window.__controls.callsSince(' + beforeOthers + ')'
    );
    assert.deepEqual(
      others.filter(call =>
        /start_dragging|toggle_maximize/.test(call.command)
      ),
      [],
      'a control or tab started a drag or toggled maximization'
    );
    await execute('window.__controls.suppressDrag(false); return true');
    record('drag-region-excludes-interactive-controls', {
      dragCalls: afterDrag.filter(call => call.command.includes('dragging')),
      controlCalls: others,
    });
  }

  // 5. Maximize / restore from the control, with the label following native window events.
  const restoredTolerance = 4;
  {
    const before = await nativeRect();
    const screen = await execute(
      'return [screen.availWidth, screen.availHeight]'
    );
    await clickControl('maximize');
    const maximized = await until(
      'maximized state',
      pageState,
      state => state?.maximized === true
    );
    // The initial window can be larger than a small runner screen, so maximization is judged against the
    // available screen area, not against the previous size: the native rectangle must change (unless it
    // already fitted) and must now fill most of the available area without exceeding it.
    const fitted =
      before.width <= screen[0] + 2 && before.height <= screen[1] + 2;
    const rect = await until(
      'maximized window rectangle',
      nativeRect,
      value =>
        value.width <= screen[0] + 2 &&
        value.height <= screen[1] + 2 &&
        value.width >= screen[0] * 0.8 &&
        value.height >= screen[1] * 0.8 &&
        (!fitted ||
          Math.abs(value.width - before.width) > 2 ||
          Math.abs(value.height - before.height) > 2)
    );
    const alreadyFull = !fitted
      ? false
      : before.width >= screen[0] - 2 && before.height >= screen[1] - 2;
    assert.equal(
      await until(
        'restore label',
        () => label('maximize'),
        value => value === 'Restore window'
      ),
      'Restore window'
    );
    assert.equal(maximized.decorated, false);
    await clickControl('maximize');
    const restored = await until(
      'restored window rectangle',
      nativeRect,
      value =>
        near(value.width, before.width, restoredTolerance) &&
        near(value.height, before.height, restoredTolerance)
    );
    await until(
      'unmaximized state',
      pageState,
      state => state?.maximized === false
    );
    assert.equal(
      await until(
        'maximize label',
        () => label('maximize'),
        value => value === 'Maximize window'
      ),
      'Maximize window'
    );
    const page = await pageResults();
    assert.ok(
      page.events['tauri://resize'] >= 2,
      'no native resize events reached the page'
    );
    assert.equal((await pageState()).decorated, false);
    record('maximize-and-restore-controls', {
      before,
      maximized: rect,
      restored,
      screen,
      alreadyFullScreen: alreadyFull,
      pageEvents: page.events,
    });
  }

  // 6. The maximize control leaves full screen first (reference handleMaximizeApp).
  {
    const before = await nativeRect();
    await request('POST', session('/window/fullscreen'), {});
    const full = await until(
      'full screen state',
      pageState,
      state => state?.fullscreen === true,
      15_000
    );
    assert.equal(full.decorated, false, 'full screen brought decorations back');
    assert.equal(
      await until(
        'full screen label',
        () => label('maximize'),
        value => value === 'Restore window'
      ),
      'Restore window'
    );
    await clickControl('maximize');
    await until(
      'left full screen',
      pageState,
      state => state?.fullscreen === false && state?.maximized === false,
      15_000
    );
    const restored = await until(
      'rectangle after full screen',
      nativeRect,
      value =>
        near(value.width, before.width, restoredTolerance) &&
        near(value.height, before.height, restoredTolerance),
      15_000
    );
    assert.equal((await pageState()).decorated, false);
    record('maximize-control-leaves-full-screen', { before, restored });
  }

  // 7. Minimize from the control, observed natively as well, then restored.
  {
    const nativeMinimized = async () => {
      if (linux)
        return (await x11Properties(x11Window)).states.includes(
          '_NET_WM_STATE_HIDDEN'
        );
      if (windows) return (await win32()).iconic === true;
      return undefined;
    };
    await clickControl('minimize');
    const minimized = await until(
      'minimized state',
      pageState,
      state => state?.minimized === true
    );
    const details = { toolkitMinimized: minimized.minimized };
    if (linux || windows) {
      details.nativeMinimized = await until(
        'native minimized',
        nativeMinimized,
        value => value === true
      );
    } else {
      evidence.notRun.push({
        name: 'native-minimized-query',
        reason: 'macOS minimization is only observed through the toolkit',
      });
    }
    await execute('window.__controls.unminimize(); return true');
    await until(
      'restored from minimize',
      pageState,
      state => state?.minimized === false
    );
    if (linux || windows)
      details.nativeRestored = await until(
        'native restored',
        nativeMinimized,
        value => value === false
      );
    assert.equal((await pageState()).decorated, false);
    record('minimize-control', details);
  }

  // 8. Double click on the empty drag region toggles maximization through Tauri's own script.
  {
    const before = await nativeRect();
    const calls = await execute('return window.__controls.callCount()');
    await execute('window.__controls.doubleClick("drag"); return true');
    await until(
      'double click maximized',
      pageState,
      state => state?.maximized === true
    );
    await execute('window.__controls.doubleClick("drag"); return true');
    await until(
      'double click restored',
      pageState,
      state => state?.maximized === false
    );
    const restored = await until(
      'rectangle after double click',
      nativeRect,
      value =>
        near(value.width, before.width, restoredTolerance) &&
        near(value.height, before.height, restoredTolerance)
    );
    const toggles = (
      await execute('return window.__controls.callsSince(' + calls + ')')
    ).filter(call => call.command === 'plugin:window|internal_toggle_maximize');
    assert.equal(toggles.length, 2);
    assert.ok(
      toggles.every(call => call.ok === true),
      JSON.stringify(toggles)
    );
    record('drag-region-double-click-toggles-maximize', {
      before,
      restored,
      toggles,
    });
  }

  // 9. Real input. Only X11 can inject trusted pointer and keyboard events here without extra
  // privileges; Windows gets a native hit-test instead and macOS has nothing equivalent.
  if (linux) {
    const point = (geometry, dx, dy) => [
      String(Math.round(geometry.X + dx)),
      String(Math.round(geometry.Y + dy)),
    ];
    const drag = async (start, steps) => {
      const args = [
        'mousemove',
        start[0],
        start[1],
        'sleep',
        '0.4',
        'mousedown',
        '1',
        'sleep',
        '0.4',
      ];
      for (const [x, y] of steps)
        args.push(
          'mousemove_relative',
          '--',
          String(x),
          String(y),
          'sleep',
          '0.25'
        );
      args.push('mouseup', '1');
      const result = await run('xdotool', args);
      assert.ok(result.ok, 'xdotool drag failed: ' + result.error);
      await delay(400);
    };
    assert.equal(
      dpr,
      1,
      'the real-pointer geometry assumes one device pixel per CSS pixel'
    );

    // Real drag of the window by the empty region.
    {
      const before = await nativeRect();
      const geometry = await x11Geometry(x11Window);
      const box = await execute('return window.__controls.dragRect()');
      const start = point(
        geometry,
        box.x + box.width / 2,
        box.y + box.height / 2
      );
      const calls = await execute('return window.__controls.callCount()');
      await drag(start, [
        [20, 10],
        [40, 25],
        [40, 25],
      ]);
      const moved = await until(
        'window moved by a real drag',
        nativeRect,
        value => value.x - before.x >= 60 && value.y - before.y >= 30
      );
      const issued = (
        await execute('return window.__controls.callsSince(' + calls + ')')
      ).filter(call => call.command === 'plugin:window|start_dragging');
      assert.ok(
        issued.length >= 1 &&
          issued.every(call => call.ok === true && !call.suppressed),
        JSON.stringify(issued)
      );
      assert.equal(moved.width, before.width);
      assert.equal(moved.height, before.height);
      assert.equal((await pageState()).decorated, false);
      record('real-pointer-drags-window', {
        before,
        moved,
        issued,
        delta: [moved.x - before.x, moved.y - before.y],
      });
    }

    // Real edge and corner resizing of an undecorated window.
    {
      const before = await nativeRect();
      const geometry = await x11Geometry(x11Window);
      await drag(point(geometry, geometry.WIDTH - 2, geometry.HEIGHT / 2), [
        [30, 0],
        [40, 0],
        [30, 0],
      ]);
      const edge = await until(
        'right edge resize',
        nativeRect,
        value => value.width - before.width >= 30
      );
      assert.ok(
        edge.width - before.width <= 140,
        'right edge grew by an unexpected amount'
      );
      assert.equal(edge.height, before.height);
      const second = await x11Geometry(x11Window);
      await drag(point(second, second.WIDTH - 2, second.HEIGHT - 2), [
        [-30, -20],
        [-30, -20],
      ]);
      const corner = await until(
        'corner resize',
        nativeRect,
        value =>
          edge.width - value.width >= 30 && edge.height - value.height >= 20
      );
      assert.equal((await pageState()).decorated, false);
      assert.equal((await pageState()).maximized, false);
      record('real-pointer-resizes-from-edge-and-corner', {
        before,
        edge,
        corner,
      });
    }

    // Real keyboard: Tab order reaches the controls and Enter / Space operate them.
    {
      const active = await run('xdotool', [
        'windowactivate',
        '--sync',
        x11Window,
      ]);
      const focusedWindow = await run('xdotool', ['getwindowfocus']);
      await execute('window.__controls.focus("tab-two"); return true');
      assert.equal(
        await until(
          'page focus',
          () => execute('return document.hasFocus()'),
          value => value === true
        ),
        true
      );
      const order = [];
      for (let step = 0; step < 3; step += 1) {
        const key = await run('xdotool', ['key', 'Tab']);
        assert.ok(key.ok, key.error);
        order.push(
          await until(
            'focus after Tab',
            () => execute('return window.__controls.focusedId()'),
            value => value !== (order.at(-1) ?? 'tab-two'),
            4_000
          )
        );
      }
      assert.deepEqual(order, ['minimize', 'maximize', 'close']);
      assert.ok((await run('xdotool', ['key', 'shift+Tab'])).ok);
      await until(
        'focus after Shift+Tab',
        () => execute('return window.__controls.focusedId()'),
        value => value === 'maximize',
        4_000
      );
      assert.ok((await run('xdotool', ['key', 'Return'])).ok);
      await until(
        'maximized by Enter',
        pageState,
        state => state?.maximized === true
      );
      assert.ok((await run('xdotool', ['key', 'space'])).ok);
      await until(
        'restored by Space',
        pageState,
        state => state?.maximized === false
      );
      assert.equal((await pageState()).decorated, false);
      record('real-keyboard-reaches-and-operates-controls', {
        activate: active.ok,
        focusedWindow: focusedWindow.stdout.trim(),
        order,
      });
    }
  } else {
    evidence.notRun.push(
      {
        name: 'real-pointer-drags-window',
        reason:
          'no unprivileged real pointer injection is wired for this platform yet',
      },
      {
        name: 'real-keyboard-reaches-and-operates-controls',
        reason:
          'the driver only dispatches untrusted key events, which never activate native buttons',
      }
    );
    if (windows) {
      const native = await win32();
      const codes = native.hits;
      // HTCLIENT 1, HTLEFT 10, HTRIGHT 11, HTTOP 12, HTBOTTOM 15, HTBOTTOMRIGHT 17
      assert.deepEqual(codes, {
        right: 11,
        left: 10,
        bottom: 15,
        top: 12,
        bottomRight: 17,
        centre: 1,
      });
      record('native-edge-hit-test-resizes-undecorated-window', {
        hits: codes,
        rect: native.rect,
      });
    } else {
      evidence.notRun.push({
        name: 'edge-resize',
        reason:
          'tao reports drag_resize_window as unsupported on macOS and no unprivileged real pointer is wired; edge resizing there is unverified',
      });
    }
  }

  // 10. The close control is intercepted by the host, then really closes once permitted.
  {
    const first = await report();
    await clickControl('close');
    const intercepted = await until(
      'intercepted close request',
      report,
      value => value.closeRequests > first.closeRequests
    );
    assert.ok(intercepted.preventedCloses >= 1);
    const handles = await request('GET', session('/window/handles'));
    assert.equal(
      handles.length,
      1,
      'the window was closed despite the safeguard'
    );
    assert.equal(await execute('return 1'), 1);
    record('close-is-intercepted-by-the-host', {
      closeRequests: intercepted.closeRequests,
      preventedCloses: intercepted.preventedCloses,
    });
  }

  // 11. Whatever the transition, no native window event ever observed decorations.
  {
    const final = await report();
    const total = Object.entries(final.events)
      .filter(([name]) => name !== 'destroyed')
      .reduce((sum, [, count]) => sum + count, 0);
    assert.equal(
      final.decoratedViolations,
      0,
      'decorations appeared during a transition'
    );
    assert.equal(final.decoratedObservations, total);
    assert.ok(final.events.resized >= 4, JSON.stringify(final.events));
    evidence.nativeReport = final;
    record('decorations-never-observed-on-any-window-event', {
      observations: final.decoratedObservations,
      events: final.events,
    });
  }

  // 12. Once permitted, the same control really closes the window.
  {
    await execute('window.__controls.permitClose(); return true');
    await until(
      'close permitted',
      pageResults,
      value => value?.closePermitted === true
    );
    await clickControl('close');
    const gone = await until(
      'window closed',
      async () => {
        try {
          return (await request('GET', session('/window/handles'))).length;
        } catch {
          return 'session-ended';
        }
      },
      value => value === 0 || value === 'session-ended',
      15_000
    );
    evidence.windowClosedByControl = true;
    record('close-control-closes-the-window-when-permitted', {
      observed: gone,
    });
  }
  evidence.passed = true;
} catch (error) {
  evidence.failure ??= String(error);
  evidence.collectorFailure = String(error);
  process.exitCode = 1;
  // Best effort: what the page saw when the check failed.
  if (sessionId)
    evidence.pageAtFailure = await execute(
      'return window.__controlsResults'
    ).catch(pageError => ({ unavailable: String(pageError) }));
} finally {
  evidence = {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    ...evidence,
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (process.env.PROBE_EVIDENCE_FILE)
    await writeFile(
      process.env.PROBE_EVIDENCE_FILE,
      JSON.stringify(evidence, null, 2) + '\n'
    );
  if (sessionId)
    await request('DELETE', session('')).catch(error => {
      // The window was closed on purpose, so the driver may already have ended the session.
      evidence.deleteSessionAfterClose = String(error);
      if (!evidence.windowClosedByControl) {
        console.error(error);
        process.exitCode = 1;
      }
    });
}
