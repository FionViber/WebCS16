/* Static WebXash launcher. Identical relative-file layout for file:// and HTTP(S). */
(function () {
  'use strict';
  const VERSION = '1.4.0';
  const $ = id => document.getElementById(id);
  const uiText = key => globalThis.CSLauncherUI?.t?.(key) || key;
  const out = $('log');
  const logs = [];
  let engine = null, running = false, initializing = false;
  let nativeFailure = null;
  const assetBase = new URL('.', location.href);
  const supportedProtocol = /^(file|https?):$/.test(location.protocol);
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  function log(message) {
    const text = String(message);
    logs.push(text); if (logs.length > 500) logs.shift();
    out.textContent = logs.join('\n'); out.scrollTop = out.scrollHeight;
    if (/cannot|can.t|failed|error|Sys_Warn/i.test(text)) nativeFailure = text;
    console.log('[CS16]', text);
  }
  function status(text, value) {
    delete $('status').dataset.i18n;
    $('status').textContent = text;
    if (value !== undefined) $('progress').value = value;
  }
  function fail(error) {
    const raw = error && error.message ? error.message : String(error);
    const message = raw === 'Infinity' || raw === '-Infinity' ? 'Engine terminated. Last diagnostic: ' + (nativeFailure || 'See the full log.') : raw;
    log('Error: ' + message);
    $('status').classList.add('error');
    status(message);
    $('game-state').textContent = 'Error';
    $('console-panel').classList.add('open');
    if (!running) { $('start').disabled = true; $('start').dataset.i18n = 'failed'; $('start').textContent = uiText('failed'); }
  }
  function decodeBase64(text) {
    const str = atob(text);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes;
  }
  function loadScript(filename) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(filename) || filename.includes('..') || filename.startsWith('/')) return Promise.reject(new Error('Invalid resource script path.'));
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const scriptURL = new URL(filename, assetBase);
      scriptURL.searchParams.set('v', filename === 'engine.js' ? '1.5.0' : VERSION);
      script.src = scriptURL.href;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error('Unable to read ' + filename + '. Verify that the complete site is deployed.')); };
      document.head.appendChild(script);
    });
  }
  async function sha256(bytes) {
    if (!globalThis.crypto || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function getPack(manifest) {
    const parts = [];
    let expected = -1, received = null;
    globalThis.CSReceiveChunk = (index, encoded) => {
      if (index !== expected || received !== null) throw new Error('Resource chunk order is invalid.');
      received = decodeBase64(encoded);
    };
    try {
      for (let i = 0; i < manifest.chunks.length; i++) {
        expected = i; received = null;
        const entry = manifest.chunks[i];
        await loadScript(entry.file);
        if (!received || received.byteLength !== entry.bytes) throw new Error('Resource chunk is missing or has the wrong size: ' + entry.file);
        const digest = await sha256(received);
        if (digest && digest !== entry.sha256) throw new Error('Resource chunk verification failed: ' + entry.file);
        parts.push(received);
        status(uiText('loadingResources') + ' ' + (i + 1) + ' / ' + manifest.chunks.length, 5 + 38 * (i + 1) / manifest.chunks.length);
        await frame();
      }
      return new Blob(parts, { type: 'application/gzip' });
    } finally { delete globalThis.CSReceiveChunk; }
  }
  class StreamReader {
    constructor(stream) { this.reader = stream.getReader(); this.chunk = new Uint8Array(); this.position = 0; }
    async exact(size) {
      if (size < 0 || size > 134217728) throw new Error('Resource record is too large.');
      const result = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        if (this.position === this.chunk.length) {
          const step = await this.reader.read();
          if (step.done) throw new Error('Resource stream ended unexpectedly.');
          this.chunk = step.value; this.position = 0;
        }
        const length = Math.min(size - offset, this.chunk.length - this.position);
        result.set(this.chunk.subarray(this.position, this.position + length), offset);
        offset += length; this.position += length;
      }
      return result;
    }
    async finish() {
      if (this.position !== this.chunk.length) throw new Error('Unexpected data follows the resource terminator.');
      for (;;) { const r = await this.reader.read(); if (r.done) return; if (r.value.length) throw new Error('Invalid data after the resource stream.'); }
    }
  }
  function safePath(name) {
    return /^(valve|cstrike)\//.test(name) && !name.includes('\\') && !/[\x00-\x1f]/.test(name) && !name.split('/').some(s => s === '.' || s === '..');
  }
  function writeFile(FS, filename, bytes) {
    FS.mkdirTree(filename.slice(0, filename.lastIndexOf('/')));
    FS.writeFile(filename, bytes);
  }
  async function mountPack(blob, FS, manifest) {
    const stream = new StreamReader(blob.stream().pipeThrough(new DecompressionStream('gzip')));
    const text = new TextDecoder();
    if (text.decode(await stream.exact(8)) !== 'CSOF0001') throw new Error('This resource package is not supported by the launcher.');
    let count = 0, total = 0;
    const names = new Set();
    for (;;) {
      const header = await stream.exact(8);
      const view = new DataView(header.buffer, header.byteOffset, 8);
      const nameSize = view.getUint32(0, true), dataSize = view.getUint32(4, true);
      if (!nameSize && !dataSize) break;
      if (!nameSize || nameSize > 4096 || count >= 100000) throw new Error('Invalid resource package directory.');
      const name = text.decode(await stream.exact(nameSize));
      if (!safePath(name) || names.has(name.toLowerCase())) throw new Error('Invalid or duplicate resource path: ' + name);
      names.add(name.toLowerCase());
      const bytes = await stream.exact(dataSize);
      total += bytes.byteLength;
      if (total > manifest.uncompressedBytes) throw new Error('Resource total exceeds the manifest.');
      writeFile(FS, '/rodir/' + name, bytes);
      count++;
      if (count % 30 === 0) {
        status(uiText('preparingFiles') + ' ' + count + ' / ' + manifest.files, 55 + 40 * count / manifest.files);
        await frame();
      }
    }
    await stream.finish();
    if (count !== manifest.files || total !== manifest.uncompressedBytes) throw new Error('Unpacked resource count or size does not match the manifest.');
    log('Mounted ' + count + ' resource files.');
  }
  async function loadLibraries() {
    await loadScript('engine-manifest.js');
    const manifest = globalThis.CS_ENGINE_MANIFEST;
    if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.libraries)) throw new Error('Invalid engine manifest. Rebuild the ready package.');
    const files = new Map();
    let expectedName = '', expectedIndex = -1, received = null;
    globalThis.CSReceiveEngine = function (name, index, encoded) {
      if (name !== expectedName || index !== expectedIndex || received !== null) throw new Error('Engine chunk does not match the manifest.');
      received = decodeBase64(encoded);
    };
    try {
      for (let i = 0; i < manifest.libraries.length; i++) {
        const lib = manifest.libraries[i];
        if (!/^[a-zA-Z0-9_./-]+\.wasm$/.test(lib.name) || lib.name.includes('..') || !Number.isSafeInteger(lib.bytes) || lib.bytes < 8 || lib.bytes > 134217728) throw new Error('Invalid engine module manifest.');
        if (files.has(lib.name) || !Array.isArray(lib.chunks) || !lib.chunks.length) throw new Error('Duplicate or unchunked engine module.');
        const bytes = new Uint8Array(lib.bytes);
        let offset = 0;
        for (let n = 0; n < lib.chunks.length; n++) {
          expectedName = lib.name; expectedIndex = n; received = null;
          const part = lib.chunks[n];
          await loadScript(part.file);
          if (!received || received.length !== part.bytes || offset + received.length > bytes.length) throw new Error('Engine chunk has the wrong size: ' + part.file);
          const digest = await sha256(received);
          if (digest && digest !== part.sha256) throw new Error('Engine chunk verification failed: ' + part.file);
          bytes.set(received, offset); offset += received.length;
          received = null;
        }
        if (offset !== bytes.length) throw new Error('Engine module is incomplete: ' + lib.name);
        const digest = await sha256(bytes);
        if (digest && digest !== lib.sha256) throw new Error('Engine module verification failed: ' + lib.name);
        if (!WebAssembly.validate(bytes)) throw new Error('The browser cannot validate the module: ' + lib.name);
        files.set(lib.name, bytes);
        status(uiText('loadingEngine') + ' ' + (i + 1) + ' / ' + manifest.libraries.length, 43 + 10 * (i + 1) / manifest.libraries.length);
        await frame();
      }
    } finally { delete globalThis.CSReceiveEngine; }
    const hooks = globalThis.CSStaticLibraries.create(files);
    log('Engine modules verified. Using in-memory loading.');
    return { files, hooks };
  }
  function restrictConnections() {
    // Ordinary same-site static asset requests remain allowed by the HTML CSP.
    // Multiplayer transports are disabled independently of the page protocol.
    globalThis.WebSocket = class DisabledWebSocket {
      constructor() { throw new Error('This build only supports offline play.'); }
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    };
    const disabled = function () { throw new Error('WebRTC multiplayer is disabled in this build.'); };
    for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
      if (key in globalThis) { try { globalThis[key] = disabled; } catch { /* CSP still restricts connections. */ } }
    }
  }
  function command(value) {
    if (!engine || !running) { log('The game is not running.'); return; }
    if (typeof engine.ccall !== 'function') throw new Error('The engine does not expose the console interface.');
    engine.ccall('Cmd_ExecuteString', null, ['string'], [value]);
  }
  function remember() {
    try { localStorage.setItem('cs-offline-settings', JSON.stringify({ map: $('map').value, bots: $('bots').value, difficulty: $('difficulty').value, player: $('player').value })); } catch { /* File origins may not persist settings. */ }
  }
  async function start() {
    if (initializing || running) return;
    initializing = true; $('start').disabled = true; $('settings').disabled = true; $('language').disabled = true;
    try {
      if (typeof WebAssembly !== 'object') throw new Error('This browser does not support WebAssembly.');
      if (typeof DecompressionStream !== 'function') throw new Error('This browser lacks the required decompression API. Use current Chrome or Edge.');
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) throw new Error('Unable to create a WebGL 2 context. Check hardware acceleration.');
      const lose = probe.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      const manifest = globalThis.CS_OFFLINE_MANIFEST;
      const map = $('map').value;
      if (!manifest.maps.includes(map)) throw new Error('The selected map is not included in the resource package.');
      const bots = Math.max(0, Math.min(14, Number($('bots').value)));
      const difficulty = Math.max(0, Math.min(3, Number($('difficulty').value) || 0));
      const player = $('player').value.replace(/[^\w -]/g, '').slice(0, 24) || 'Player';
      remember();
      restrictConnections();
      const pack = await getPack(manifest);
      status(uiText('preparingEngine'), 45);
      const libs = await loadLibraries();
      await loadScript('engine.js');
      if (typeof globalThis.Xash3D !== 'function') throw new Error('The web engine did not load correctly.');
      const args = [
        '-windowed', '-game', 'cstrike', '-console', '-ref', 'webgl2', '-noip', '-nomaster',
        '-dll', '@yapb', '+_vgui_menus', '0', '+sv_lan', '1', '+maxplayers', '16',
        '+map', map, '+yb_quota', String(bots), '+yb_difficulty', String(difficulty),
      ];
      const result = await globalThis.Xash3D({
        canvas: $('canvas'), arguments: args, noInitialRun: true,
        wasmBinary: libs.files.get('xash.wasm'),
        csStaticLibraries: libs.hooks, csStaticOnly: true,
        locateFile: name => libs.hooks.resolve(name) || String(name),
        dynamicLibraries: [
          'filesystem_stdio.wasm', 'libref_webgl2.wasm',
          'cl_dlls/menu_emscripten_wasm32.wasm', 'dlls/cs_emscripten_wasm32.wasm',
          'cl_dlls/client_emscripten_wasm32.wasm', 'dlls/yapb_emscripten_wasm32.wasm',
        ],
        print: log, printErr: log, onAbort: reason => fail(new Error('Engine aborted: ' + reason)),
        onExit: code => { if (code) fail(new Error('Engine exited with status ' + code + '. ' + (nativeFailure || ''))); },
      });
      engine = result && result.Module ? result.Module : result;
      if (!engine || !engine.__csStaticReady || engine.__csRuntimeVersion !== VERSION) throw new Error('Engine files are incomplete. Rebuild the ready package.');
      const FS = (result && result.FS) || (engine && engine.FS);
      if (!FS || !engine || typeof engine.callMain !== 'function') throw new Error('The engine initialization interface is incompatible.');
      FS.mkdirTree('/rodir'); FS.mkdirTree('/rwdir'); FS.mkdirTree('/rwdir/cstrike');
      status(uiText('preparingResources'), 55);
      await mountPack(pack, FS, manifest);
      libs.hooks.mount(FS);
      const gameLibraryPath = libs.hooks.resolve('dlls/cs_emscripten_wasm32.wasm');
      const botLibraryPath = libs.hooks.resolve('dlls/yapb_emscripten_wasm32.wasm');
      if (!gameLibraryPath || gameLibraryPath === botLibraryPath || engine.__csGameLibraryPath !== gameLibraryPath) {
        throw new Error('Bot startup configuration is incomplete. Rebuild the ready package.');
      }
      if (FS.stat(gameLibraryPath).size !== libs.files.get('dlls/cs_emscripten_wasm32.wasm').length) {
        throw new Error('The CS game module was not mounted completely.');
      }
      log('Bot game module path set: ' + gameLibraryPath);

      // Remove platform-specific cached descriptors from the resource archive.
      try { FS.unlink('/rodir/cstrike/gameinfo.txt'); } catch { /* Optional file. */ }
      const cfg = `name "${player}"\nsv_lan 1\nvolume 0.35\nsensitivity 3\n_cl_autowepswitch 1\n_vgui_menus 0\nbind "w" "+forward"\nbind "s" "+back"\nbind "a" "+moveleft"\nbind "d" "+moveright"\nbind "MOUSE1" "+attack"\nbind "MOUSE2" "+attack2"\nbind "SPACE" "+jump"\nbind "CTRL" "+duck"\nbind "c" "+duck"\nbind "SHIFT" "+speed"\nbind "r" "+reload"\nbind "e" "+use"\nbind "b" "buy"\nbind "m" "chooseteam"\nbind "TAB" "+showscores"\nbind "q" "lastinv"\nbind "1" "slot1"\nbind "2" "slot2"\nbind "3" "slot3"\nbind "4" "slot4"\nbind "5" "slot5"\nbind "6" "slot6"\nbind "7" "slot7"\nbind "8" "slot8"\nbind "9" "slot9"\nbind "0" "slot10"\nyb_quota ${bots}\nyb_difficulty ${difficulty}\nyb_join_after_player 0\n`;
      const text = new TextEncoder();
      writeFile(FS, '/rodir/cstrike/config.cfg', text.encode(cfg));
      writeFile(FS, '/rodir/cstrike/autoexec.cfg', text.encode(cfg));
      writeFile(FS, '/rwdir/cstrike/config.cfg', text.encode(cfg));
      FS.chdir('/rodir');
      status(uiText('entering'), 100);
      document.body.classList.add('playing');
      await frame();
      globalThis.CS_STATIC_DIAGNOSTICS = { version: VERSION, engine, args, logs, runCommand: command, moduleNames: libs.hooks.names };
      running = true;
      try { engine.callMain(args); } catch (e) { if (e !== 'unwind') throw e; }
      $('game-state').textContent = map;
      $('canvas').focus();
      log('Game started. Click the game view and choose a team.');
      globalThis.CS_OFFLINE_DIAGNOSTICS = globalThis.CS_STATIC_DIAGNOSTICS;
    } catch (e) { fail(e); }
    finally { initializing = false; }
  }
  $('start').addEventListener('click', start);
  document.addEventListener('launcherlanguagechange', () => {
    if (!running && !initializing && !$('status').classList.contains('error')) status(uiText($('start').disabled ? 'checking' : 'ready'));
  });
  for (const button of document.querySelectorAll('.logs-button')) button.addEventListener('click', () => $('console-panel').classList.toggle('open'));
  $('close-console').addEventListener('click', () => { $('console-panel').classList.remove('open'); if (running) $('canvas').focus(); });
  $('restart').addEventListener('click', () => location.reload());
  $('fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('canvas').requestFullscreen(); $('canvas').focus(); }
    catch (e) { log('Unable to enter fullscreen: ' + e.message); }
  });
  $('command-form').addEventListener('submit', event => {
    event.preventDefault(); const text = $('command').value.trim(); if (!text) return;
    try { log('> ' + text); command(text); $('command').value = ''; } catch (e) { log(e.message); }
  });
  $('canvas').addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('unhandledrejection', e => fail(e.reason));
  window.addEventListener('error', e => { if (e.error) fail(e.error); });

  try {
    const saved = JSON.parse(localStorage.getItem('cs-offline-settings') || 'null');
    if (saved) for (const id of ['map', 'bots', 'difficulty', 'player']) if (saved[id] !== undefined) $(id).value = String(saved[id]);
  } catch { /* Settings persistence is optional. */ }
  (async () => {
    try {
      if (!supportedProtocol) throw new Error('This page protocol is not supported.');
      await loadScript('manifest.js');
      const manifest = globalThis.CS_OFFLINE_MANIFEST;
      if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.chunks) || !manifest.chunks.length) throw new Error('Resource manifest is missing or invalid.');
      $('start').disabled = false; $('start').textContent = uiText('start');
      status(uiText('ready'), 0);
      log('Launcher version: ' + VERSION);
      log('Resource manifest loaded. Offline mode enabled.');
    } catch (e) { fail(e); }
  })();
}());
