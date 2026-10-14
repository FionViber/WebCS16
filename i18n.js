(function () {
  'use strict';
  const messages = {
    en: {match:'New match',map:'Map',bots:'Bots',difficulty:'Difficulty',player:'Player name',none:'None',easy:'Easy',normal:'Normal',hard:'Hard',checking:'Checking files',ready:'Ready',start:'Start game',failed:'Unable to start',loadingResources:'Loading resources',preparingFiles:'Unpacking files',loadingEngine:'Loading engine',preparingEngine:'Preparing engine',preparingResources:'Preparing resources',entering:'Starting game'},
    'zh-CN': {match:'新建游戏',map:'地图',bots:'机器人',difficulty:'难度',player:'玩家名称',none:'无',easy:'简单',normal:'普通',hard:'困难',checking:'检查资源',ready:'准备就绪',start:'开始游戏',failed:'启动失败',loadingResources:'加载资源',preparingFiles:'解压文件',loadingEngine:'加载引擎',preparingEngine:'准备引擎',preparingResources:'准备资源',entering:'进入游戏'}
  };
  let language = 'en';
  try { const saved=localStorage.getItem('cs-launcher-language'); if (saved in messages) language=saved; } catch {}
  const t = key => messages[language][key] || messages.en[key] || key;
  function apply() {
    document.documentElement.lang=language;
    document.getElementById('language').value=language;
    document.querySelectorAll('#setup [data-i18n]').forEach(node => {node.textContent=t(node.dataset.i18n);});
    document.dispatchEvent(new Event('launcherlanguagechange'));
  }
  window.CSLauncherUI={t};
  document.getElementById('status').dataset.i18n='checking';
  document.getElementById('language').addEventListener('change',event=>{
    language=event.target.value;
    try {localStorage.setItem('cs-launcher-language',language);} catch {}
    apply();
  });
  apply();
}());
