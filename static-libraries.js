/* WebXash static library transport. Shared by file:// and HTTP(S) launches. */
(function (global) {
  'use strict';
  const BASENAME_ALIASES = Object.freeze({
    'libmenu.wasm': 'menu_emscripten_wasm32.wasm',
    'menu.so': 'menu_emscripten_wasm32.wasm',
    'menu.dll': 'menu_emscripten_wasm32.wasm',
    'client.so': 'client_emscripten_wasm32.wasm',
    'client.dll': 'client_emscripten_wasm32.wasm',
    'mp.dll': 'cs_emscripten_wasm32.wasm',
    'mp.so': 'cs_emscripten_wasm32.wasm',
    'cs.so': 'cs_emscripten_wasm32.wasm',
    'cs.wasm': 'cs_emscripten_wasm32.wasm',
    'mp.wasm': 'cs_emscripten_wasm32.wasm',
    'cs_i386.so': 'cs_emscripten_wasm32.wasm',
    'mp_i386.so': 'cs_emscripten_wasm32.wasm',
    'cs_i386.wasm': 'cs_emscripten_wasm32.wasm',
    'mp_i386.wasm': 'cs_emscripten_wasm32.wasm',
    'mp_emscripten_wasm32.wasm': 'cs_emscripten_wasm32.wasm',
    'yapb.so': 'yapb_emscripten_wasm32.wasm',
    'yapb.dll': 'yapb_emscripten_wasm32.wasm',
    'libref_gles3compat.wasm': 'libref_webgl2.wasm',
  });
  function normalize(name) {
    if (typeof name !== 'string' || !name || /[?#\x00-\x1f]/.test(name)) return null;
    const plain = name.replace(/\\/g, '/');
    if (/^[a-z][a-z0-9+.-]*:/i.test(plain)) return null;
    let base = plain.split('/').pop().replace(/\.so$/i, '.wasm');
    // Legacy .dll/.so spellings and Emscripten .so builds are both handled.
    const original = plain.split('/').pop();
    base = BASENAME_ALIASES[original] || BASENAME_ALIASES[base] || base;
    return base;
  }
  function create(files) {
    const byName = new Map();
    const originalNames = new Map();
    for (const [name, bytes] of files) {
      if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109) {
        throw new Error('无效的 WebAssembly 模块：' + name);
      }
      const key = normalize(name);
      if (!key || byName.has(key)) throw new Error('模块名称重复或无效：' + name);
      byName.set(key, bytes);
      originalNames.set(key, name);
    }
    function resolve(name) {
      const key = normalize(String(name));
      return key && byName.has(key) ? '/__cs_modules__/' + key : null;
    }
    function read(name) {
      const key = normalize(String(name));
      return key ? byName.get(key) || null : null;
    }
    function mount(FS) {
      FS.mkdirTree('/__cs_modules__');
      FS.mkdirTree('/rodir/cstrike');
      FS.mkdirTree('/rodir/valve');
      FS.mkdirTree('/rwdir/cstrike');
      // Native Xash paths can be rooted at /cstrike even when the data is in /rodir.
      for (const game of ['cstrike', 'valve']) {
        try { FS.lookupPath('/' + game); }
        catch { FS.symlink('/rodir/' + game, '/' + game); }
      }
      const mounted = new Set();
      function alias(target, dest) {
        if (dest === target || mounted.has(dest)) return;
        FS.mkdirTree(dest.slice(0, dest.lastIndexOf('/')) || '/');
        try { FS.unlink(dest); } catch { /* No old alias exists. */ }
        FS.symlink(target, dest);
        mounted.add(dest);
      }
      for (const [base, bytes] of byName) {
        if (base === 'xash.wasm') continue;
        const target = '/__cs_modules__/' + base;
        FS.writeFile(target, bytes);
        const name = originalNames.get(base);
        const variants = new Set([name, base, name.replace(/\.wasm$/, '.so'), base.replace(/\.wasm$/, '.so')]);
        for (const [old, canonical] of Object.entries(BASENAME_ALIASES)) {
          if (canonical === base) {
            variants.add(old);
            if (/^(mp|cs|yapb)/.test(old)) variants.add('dlls/' + old);
            if (/^(menu|client)/.test(old)) variants.add('cl_dlls/' + old);
          }
        }
        for (const prefix of ['/', '/rodir/', '/rodir/cstrike/', '/rwdir/cstrike/']) {
          for (const variant of variants) alias(target, prefix + variant);
        }
      }
    }
    return { resolve, read, mount, names: [...originalNames.values()] };
  }
  global.CSStaticLibraries = Object.freeze({ create, normalize });
}(globalThis));
