'use strict';
// Compile actual merged locale messages with the installed production compiler,
// then render JSON examples through the real production vue-i18n runtime.
process.env.NODE_ENV = 'production';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {baseCompile} = require('@intlify/message-compiler');
const {createI18n} = require('vue-i18n');
const root = path.resolve(__dirname,'../packages/api-nova-ui/src/locales/messages');
const oldLoader = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  assert.ok(path.resolve(filename).startsWith(root + path.sep),'Locale fixture loader must stay in locale source');
  const code = ts.transpileModule(fs.readFileSync(filename,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},fileName:filename,
  }).outputText;
  module._compile(code,filename);
};
try {
  const messages = Object.fromEntries(['zh-CN','en-US'].map(locale=>[locale,require(path.join(root,locale,'index.ts')).default]));
  let checked = 0;
  for (const [locale,catalog] of Object.entries(messages)) {
    const visit = (value,key) => {
      if(typeof value==='string') {
        const errors=[];
        baseCompile(value,{onError:error=>errors.push(error)});
        assert.equal(errors.length,0,`${locale}.${key}: ${errors.map(error=>error.message).join('; ')}`);
        checked++;
      } else if(value && typeof value==='object') {
        for(const [name,child]of Object.entries(value))visit(child,`${key}.${name}`);
      }
    };
    // The accepted browser journey: registration/testing, publication, runtime,
    // upstream binding and monitoring. Other product surfaces are out of scope.
    for(const scope of ['endpointRegistry','monitoring','runtimeUpstreamBinding','servers'])visit(catalog[scope],scope);
  }
  const i18n=createI18n({legacy:false,locale:'zh-CN',fallbackLocale:'en-US',messages});
  for(const [locale,prefix]of [['zh-CN','请输入用于该 Endpoint 测试的 JSON 对象，例如 '],['en-US','Enter JSON object parameters for this endpoint test, for example ']]) {
    i18n.global.locale.value=locale;
    const rendered=i18n.global.t('endpointRegistry.testDialog.parametersPlaceholder');
    assert.equal(rendered,prefix+'{"id": 1}');
    assert.deepEqual(JSON.parse(rendered.slice(prefix.length)),{id:1});
    assert.equal(i18n.global.t('servers.messages.startSuccess',{name:'fixture'}),locale==='zh-CN'?'服务“fixture”启动成功':'Server "fixture" started successfully');
  }
  console.log(`OPS_BROWSER_I18N_PRODUCTION_OK ${checked} messages; zh/en JSON examples and named interpolation rendered`);
} finally {
  if(oldLoader)require.extensions['.ts']=oldLoader;else delete require.extensions['.ts'];
}
