/* Static WebXash launcher. Identical relative-file layout for file:// and HTTP(S). */
(function () {
  'use strict';
  const VERSION = '1.4.0';
  const $ = id => document.getElementById(id);
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
    $('status').textContent = text;
    if (value !== undefined) $('progress').value = value;
  }
  function fail(error) {
    const raw = error && error.message ? error.message : String(error);
    const message = raw === 'Infinity' || raw === '-Infinity' ? '引擎终止。最后一条诊断：' + (nativeFailure || '请查看完整日志。') : raw;
    log('错误：' + message);
    $('status').classList.add('error');
    status(message);
    $('game-state').textContent = '运行错误，请查看日志';
    $('console-panel').classList.add('open');
    if (!running) { $('start').disabled = true; $('start').textContent = '未能启动'; }
  }
  function decodeBase64(text) {
    const str = atob(text);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes;
  }
  function loadScript(filename) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(filename) || filename.includes('..') || filename.startsWith('/')) return Promise.reject(new Error('无效的资源脚本路径。'));
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const scriptURL = new URL(filename, assetBase);
      scriptURL.searchParams.set('v', VERSION);
      script.src = scriptURL.href;
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error('无法读取 ' + filename + '。请确认整个站点目录完整，且资源位于 index.html 所在目录下。')); };
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
      if (index !== expected || received !== null) throw new Error('资源分片顺序错误。');
      received = decodeBase64(encoded);
    };
    try {
      for (let i = 0; i < manifest.chunks.length; i++) {
        expected = i; received = null;
        const entry = manifest.chunks[i];
        await loadScript(entry.file);
        if (!received || received.byteLength !== entry.bytes) throw new Error('资源分片缺失或大小不符：' + entry.file);
        const digest = await sha256(received);
        if (digest && digest !== entry.sha256) throw new Error('资源分片校验失败：' + entry.file);
        parts.push(received);
        status('加载游戏资源 ' + (i + 1) + ' / ' + manifest.chunks.length, 5 + 38 * (i + 1) / manifest.chunks.length);
        await frame();
      }
      return new Blob(parts, { type: 'application/gzip' });
    } finally { delete globalThis.CSReceiveChunk; }
  }
  class StreamReader {
    constructor(stream) { this.reader = stream.getReader(); this.chunk = new Uint8Array(); this.position = 0; }
    async exact(size) {
      if (size < 0 || size > 134217728) throw new Error('资源记录大小超出限制。');
      const result = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        if (this.position === this.chunk.length) {
          const step = await this.reader.read();
          if (step.done) throw new Error('资源流意外结束。');
          this.chunk = step.value; this.position = 0;
        }
        const length = Math.min(size - offset, this.chunk.length - this.position);
        result.set(this.chunk.subarray(this.position, this.position + length), offset);
        offset += length; this.position += length;
      }
      return result;
    }
    async finish() {
      if (this.position !== this.chunk.length) throw new Error('资源结束标记后存在额外数据。');
      for (;;) { const r = await this.reader.read(); if (r.done) return; if (r.value.length) throw new Error('资源流尾部无效。'); }
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
    if (text.decode(await stream.exact(8)) !== 'CSOF0001') throw new Error('不是本启动器支持的资源包。');
    let count = 0, total = 0;
    const names = new Set();
    for (;;) {
      const header = await stream.exact(8);
      const view = new DataView(header.buffer, header.byteOffset, 8);
      const nameSize = view.getUint32(0, true), dataSize = view.getUint32(4, true);
      if (!nameSize && !dataSize) break;
      if (!nameSize || nameSize > 4096 || count >= 100000) throw new Error('资源包目录无效。');
      const name = text.decode(await stream.exact(nameSize));
      if (!safePath(name) || names.has(name.toLowerCase())) throw new Error('资源路径无效或重复：' + name);
      names.add(name.toLowerCase());
      const bytes = await stream.exact(dataSize);
      total += bytes.byteLength;
      if (total > manifest.uncompressedBytes) throw new Error('资源总大小超过清单。');
      writeFile(FS, '/rodir/' + name, bytes);
      count++;
      if (count % 30 === 0) {
        status('准备游戏文件 ' + count + ' / ' + manifest.files, 55 + 40 * count / manifest.files);
        await frame();
      }
    }
    await stream.finish();
    if (count !== manifest.files || total !== manifest.uncompressedBytes) throw new Error('解包后的资源总数或大小与清单不一致。');
    log('已挂载 ' + count + ' 个资源文件。');
  }
  async function loadLibraries() {
    await loadScript('engine-manifest.js');
    const manifest = globalThis.CS_ENGINE_MANIFEST;
    if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.libraries)) throw new Error('引擎清单无效。请重新应用修复文件。');
    const files = new Map();
    let expectedName = '', expectedIndex = -1, received = null;
    globalThis.CSReceiveEngine = function (name, index, encoded) {
      if (name !== expectedName || index !== expectedIndex || received !== null) throw new Error('引擎分片与清单不符。');
      received = decodeBase64(encoded);
    };
    try {
      for (let i = 0; i < manifest.libraries.length; i++) {
        const lib = manifest.libraries[i];
        if (!/^[a-zA-Z0-9_./-]+\.wasm$/.test(lib.name) || lib.name.includes('..') || !Number.isSafeInteger(lib.bytes) || lib.bytes < 8 || lib.bytes > 134217728) throw new Error('引擎模块清单无效。');
        if (files.has(lib.name) || !Array.isArray(lib.chunks) || !lib.chunks.length) throw new Error('引擎模块重复或未分片。');
        const bytes = new Uint8Array(lib.bytes);
        let offset = 0;
        for (let n = 0; n < lib.chunks.length; n++) {
          expectedName = lib.name; expectedIndex = n; received = null;
          const part = lib.chunks[n];
          await loadScript(part.file);
          if (!received || received.length !== part.bytes || offset + received.length > bytes.length) throw new Error('引擎分片大小不符：' + part.file);
          const digest = await sha256(received);
          if (digest && digest !== part.sha256) throw new Error('引擎分片校验失败：' + part.file);
          bytes.set(received, offset); offset += received.length;
          received = null;
        }
        if (offset !== bytes.length) throw new Error('引擎模块不完整：' + lib.name);
        const digest = await sha256(bytes);
        if (digest && digest !== lib.sha256) throw new Error('引擎模块校验失败：' + lib.name);
        if (!WebAssembly.validate(bytes)) throw new Error('浏览器不能识别模块：' + lib.name);
        files.set(lib.name, bytes);
        status('加载引擎模块 ' + (i + 1) + ' / ' + manifest.libraries.length, 43 + 10 * (i + 1) / manifest.libraries.length);
        await frame();
      }
    } finally { delete globalThis.CSReceiveEngine; }
    const hooks = globalThis.CSStaticLibraries.create(files);
    log('引擎模块已校验。使用内存加载，不使用 blob 模块地址。');
    return { files, hooks };
  }
  function restrictConnections() {
    // Ordinary same-site static asset requests remain allowed by the HTML CSP.
    // Multiplayer transports are disabled independently of the page protocol.
    globalThis.WebSocket = class DisabledWebSocket {
      constructor() { throw new Error('此版本只运行单机对战，不连接联机服务器。'); }
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    };
    const disabled = function () { throw new Error('此版本未启用 WebRTC 联机。'); };
    for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
      if (key in globalThis) { try { globalThis[key] = disabled; } catch { /* CSP still restricts connections. */ } }
    }
  }
  function command(value) {
    if (!engine || !running) { log('游戏尚未启动。'); return; }
    if (typeof engine.ccall !== 'function') throw new Error('此引擎未导出控制台调用接口。');
    engine.ccall('Cmd_ExecuteString', null, ['string'], [value]);
  }
  function remember() {
    try { localStorage.setItem('cs-offline-settings', JSON.stringify({ map: $('map').value, bots: $('bots').value, difficulty: $('difficulty').value, player: $('player').value })); } catch { /* File origins may not persist settings. */ }
  }
  async function start() {
    if (initializing || running) return;
    initializing = true; $('start').disabled = true; $('settings').disabled = true;
    try {
      if (typeof WebAssembly !== 'object') throw new Error('浏览器不支持 WebAssembly。');
      if (typeof DecompressionStream !== 'function') throw new Error('浏览器缺少资源解压功能，请使用桌面版 Chrome 或 Edge。');
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) throw new Error('无法创建 WebGL 2 图形上下文，请检查浏览器硬件加速。');
      const lose = probe.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      const manifest = globalThis.CS_OFFLINE_MANIFEST;
      const map = $('map').value;
      if (!manifest.maps.includes(map)) throw new Error('所选地图未包含在资源包内。');
      const bots = Math.max(0, Math.min(14, Number($('bots').value)));
      const difficulty = Math.max(0, Math.min(3, Number($('difficulty').value) || 0));
      const player = $('player').value.replace(/[^\w -]/g, '').slice(0, 24) || 'Player';
      remember();
      restrictConnections();
      const pack = await getPack(manifest);
      status('准备网页引擎', 45);
      const libs = await loadLibraries();
      await loadScript('engine.js');
      if (typeof globalThis.Xash3D !== 'function') throw new Error('网页引擎没有正确加载。');
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
        print: log, printErr: log, onAbort: reason => fail(new Error('引擎启动中止：' + reason)),
        onExit: code => { if (code) fail(new Error('引擎退出，状态码 ' + code + '。' + (nativeFailure || ''))); },
      });
      engine = result && result.Module ? result.Module : result;
      if (!engine || !engine.__csStaticReady || engine.__csRuntimeVersion !== VERSION) throw new Error('引擎文件不完整。请重新运行 CS16_OneClick.cmd 后打开 CS16-Ready。');
      const FS = (result && result.FS) || (engine && engine.FS);
      if (!FS || !engine || typeof engine.callMain !== 'function') throw new Error('引擎初始化接口不匹配，无法继续启动。');
      FS.mkdirTree('/rodir'); FS.mkdirTree('/rwdir'); FS.mkdirTree('/rwdir/cstrike');
      status('准备游戏资源', 55);
      await mountPack(pack, FS, manifest);
      libs.hooks.mount(FS);
      const gameLibraryPath = libs.hooks.resolve('dlls/cs_emscripten_wasm32.wasm');
      const botLibraryPath = libs.hooks.resolve('dlls/yapb_emscripten_wasm32.wasm');
      if (!gameLibraryPath || gameLibraryPath === botLibraryPath || engine.__csGameLibraryPath !== gameLibraryPath) {
        throw new Error('机器人启动配置不完整。请重新运行最新版一键 CMD。');
      }
      if (FS.stat(gameLibraryPath).size !== libs.files.get('dlls/cs_emscripten_wasm32.wasm').length) {
        throw new Error('机器人的 CS 游戏模块未完整挂载。');
      }
      log('机器人游戏模块路径已设置：' + gameLibraryPath);

      // Remove platform-specific cached descriptors from the resource archive.
      try { FS.unlink('/rodir/cstrike/gameinfo.txt'); } catch { /* Optional file. */ }
      const cfg = `name "${player}"\nsv_lan 1\nvolume 0.35\nsensitivity 3\n_cl_autowepswitch 1\n_vgui_menus 0\nbind "w" "+forward"\nbind "s" "+back"\nbind "a" "+moveleft"\nbind "d" "+moveright"\nbind "MOUSE1" "+attack"\nbind "MOUSE2" "+attack2"\nbind "SPACE" "+jump"\nbind "CTRL" "+duck"\nbind "c" "+duck"\nbind "SHIFT" "+speed"\nbind "r" "+reload"\nbind "e" "+use"\nbind "b" "buy"\nbind "m" "chooseteam"\nbind "TAB" "+showscores"\nbind "q" "lastinv"\nbind "1" "slot1"\nbind "2" "slot2"\nbind "3" "slot3"\nbind "4" "slot4"\nbind "5" "slot5"\nbind "6" "slot6"\nbind "7" "slot7"\nbind "8" "slot8"\nbind "9" "slot9"\nbind "0" "slot10"\nyb_quota ${bots}\nyb_difficulty ${difficulty}\nyb_join_after_player 0\n`;
      const text = new TextEncoder();
      writeFile(FS, '/rodir/cstrike/config.cfg', text.encode(cfg));
      writeFile(FS, '/rodir/cstrike/autoexec.cfg', text.encode(cfg));
      writeFile(FS, '/rwdir/cstrike/config.cfg', text.encode(cfg));
      FS.chdir('/rodir');
      status('进入游戏', 100);
      document.body.classList.add('playing');
      await frame();
      globalThis.CS_STATIC_DIAGNOSTICS = { version: VERSION, engine, args, logs, runCommand: command, moduleNames: libs.hooks.names };
      running = true;
      try { engine.callMain(args); } catch (e) { if (e !== 'unwind') throw e; }
      $('game-state').textContent = '单机模式 · ' + map;
      $('canvas').focus();
      log('游戏入口已启动。请点击游戏画面并选择队伍。');
      globalThis.CS_OFFLINE_DIAGNOSTICS = globalThis.CS_STATIC_DIAGNOSTICS;
    } catch (e) { fail(e); }
    finally { initializing = false; }
  }
  $('start').addEventListener('click', start);
  for (const button of document.querySelectorAll('.logs-button')) button.addEventListener('click', () => $('console-panel').classList.toggle('open'));
  $('close-console').addEventListener('click', () => { $('console-panel').classList.remove('open'); if (running) $('canvas').focus(); });
  $('restart').addEventListener('click', () => location.reload());
  $('fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('canvas').requestFullscreen(); $('canvas').focus(); }
    catch (e) { log('无法进入全屏：' + e.message); }
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
      if (!supportedProtocol) throw new Error('不支持当前页面协议。');
      await loadScript('manifest.js');
      const manifest = globalThis.CS_OFFLINE_MANIFEST;
      if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.chunks) || !manifest.chunks.length) throw new Error('资源清单未生成或格式无效。');
      $('start').disabled = false; $('start').textContent = '开始单机游戏';
      status('游戏包已就绪，资源 ' + (manifest.compressedBytes / 1048576).toFixed(1) + ' MiB。点击开始自动加载。', 0);
      $('mode').textContent = location.protocol === 'file:' ? '当前：本地文件运行' : '当前：静态网站运行';
      log('启动器版本：' + VERSION);
      log('资源清单已读取。模式：' + (location.protocol === 'file:' ? '本地文件' : '静态网站') + '。未启用联机功能。');
    } catch (e) { fail(e); }
  })();
}());
