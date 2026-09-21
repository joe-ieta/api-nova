"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module"), ts = require("typescript");
const { reactive, watch } = require("vue");
const filename = path.resolve(__dirname, "../src/services/mcp-publication.ts"), loaded = new Module(filename, module);
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const api = loaded.exports;
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const detail = { asset: { type: "mcp_server" }, managedServer: { id: "server-a", inboundAuthMode: "private_api_key", effectiveInboundAuthMode: "unknown", port: 9033, transport: "sse", endpointPath: "/team/events", status: "stopped", endpoint: "http://localhost:9033/old" } };
const preview = input => ({ ...input, inboundAuthMode: input.inboundAuthMode ?? "unknown", effectiveInboundAuthMode: "unknown", port: input.port ?? null, consumerUrl: input.port ? "http://127.0.0.1:" + input.port + input.endpointPath : null,
  messagesUrl: input.transport === "sse" && input.port ? "http://127.0.0.1:" + input.port + input.endpointPath + "/messages" : null,
  portMode: input.port ? "explicit" : "automatic", addressScope: "loopback", availability: "not_checked" });
function fixture(t, request) {
  const auth = reactive({ token: "token-a", id: "user-a" }), calls = [], state = reactive(api.mcpPublicationState());
  const form = new api.McpPublicationForm(state, () => auth.token && auth.id ? { key: auth.id + auth.token, token: auth.token } : null,
    async (...args) => { calls.push(args); return request ? request(...args) : args[1] === "detail" ? detail : preview(args[4]); });
  const stop = watch([() => auth.token, () => auth.id], () => form.close(), { flush: "sync" });
  t.after(() => { stop(); form.close(); }); return { form, state, auth, calls };
}
test("captured-token adapter uses exact authorized preview and deployment endpoints without retry", async t => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; }); const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; };
  const input = { port: 9033, transport: "sse", endpointPath: "/events" };
  await api.mcpPublicationRequest("asset", "preview", "captured", new AbortController().signal, input);
  await api.mcpPublicationRequest("asset", "deploy", "captured", new AbortController().signal, input);
  assert.equal(calls[0].url, "/api/v1/runtime-assets/asset/mcp-endpoint-preview");
  assert.equal(calls[1].url, "/api/v1/runtime-assets/asset/deploy-mcp");
  assert.equal(calls[1].options.headers.Authorization, "Bearer captured");
  assert.deepEqual(JSON.parse(calls[1].options.body), input); assert.equal(calls.length, 2);
});
test("saved SSE configuration fills actual form and submits all fields with waiver", async t => {
  const f = fixture(t); const done = f.form.open("asset", "authorized smoke waiver"); await tick();
  assert.equal(f.state.transport, "sse"); assert.equal(f.state.endpointPath, "/team/events");
  assert.equal(f.state.actualEndpoint, "http://localhost:9033/old");
  assert.equal(f.state.preview.consumerUrl, "http://127.0.0.1:9033/team/events");
  f.state.endpointPath = "/new"; await f.form.refresh(); await f.form.save(); assert.equal(await done, true);
  const deployment = f.calls.find(args => args[1] === "deploy");
  assert.deepEqual(deployment[4], { targetServerId: "server-a", inboundAuthMode: "private_api_key", transport: "sse", port: 9033, endpointPath: "/new", missingSmokeWaiverReason: "authorized smoke waiver" });
});
test("first deployment automatic port stays unassigned and is omitted from submitted body", async t => {
  const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ? { asset: { type: "mcp_server" } } : preview(input));
  f.form.open("asset"); await tick(); assert.equal(f.state.preview.consumerUrl, null); assert.equal(f.state.port, undefined);
  f.state.inboundAuthMode = "private_jwt"; await f.form.refresh();
  await f.form.save(); assert.equal(Object.hasOwn(f.calls.find(args => args[1] === "deploy")[4], "port"), false);
});
test("field changes and switching assets discard late preview responses", async t => {
  const old = deferred(); let reads = 0;
  const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ? detail : ++reads === 1 ? old.promise : preview(input));
  const first = f.form.open("first"); await tick(); f.state.endpointPath = "/latest"; await f.form.refresh();
  old.resolve(preview({ transport: "sse", port: 9033, endpointPath: "/old" })); await tick();
  assert.equal(f.state.preview.endpointPath, "/latest");
  f.form.open("second"); assert.equal(await first, false); await tick(); assert.equal(f.state.id, "second");
});
test("logout discards pending deployment completion and clears private draft", async t => {
  const waiting = deferred();
  const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ? detail : op === "deploy" ? waiting.promise : preview(input));
  const result = f.form.open("asset"); await tick(); const saving = f.form.save(); f.auth.token = null;
  assert.equal(await result, false); waiting.resolve({}); await saving;
  assert.equal(f.state.visible, false); assert.equal(f.state.id, ""); assert.equal(f.state.actualEndpoint, null);
});
test("uncertain deployment preserves draft, invalidates preview and never automatically resubmits", async t => {
  const f = fixture(t, async (_id, op, _token, _signal, input) => { if (op === "deploy") throw new Error("network"); return op === "detail" ? detail : preview(input); });
  f.form.open("asset"); await tick(); f.state.endpointPath = "/edited"; await f.form.refresh(); await f.form.save(); await f.form.save();
  assert.equal(f.state.endpointPath, "/edited"); assert.equal(f.state.error, "deploy"); assert.equal(f.state.preview, null);
  assert.equal(f.calls.filter(args => args[1] === "deploy").length, 1); assert.equal(f.state.saving, false);
});
test("preview timeout leaves no stale success and supports an explicit reread", async t => {
  const original = global.setTimeout; global.setTimeout = (fn, ms, ...args) => original(fn, ms === 10000 ? 5 : ms, ...args);
  t.after(() => { global.setTimeout = original; }); let fail = true;
  const f = fixture(t, async (_id, op, _token, signal, input) => op === "detail" ? detail : fail ? new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })) : preview(input));
  f.form.open("asset"); await new Promise(r => original(r, 30)); assert.equal(f.state.error, "preview"); assert.equal(f.state.preview, null);
  fail = false; await f.form.refresh(); assert.equal(f.state.error, null); assert.equal(f.state.preview.endpointPath, "/team/events");
});

test("redeploy form submits the same edited contract to the existing redeploy action", async t => {
  const f = fixture(t); const result = f.form.open("asset", undefined, "redeploy"); await tick();
  f.state.port = 9044; await f.form.refresh(); await f.form.save(); assert.equal(await result, true);
  assert.equal(f.calls.filter(args => args[1] === "deploy").length, 0);
  assert.equal(f.calls.find(args => args[1] === "redeploy")[4].port, 9044);
});

for (const mode of ["private_jwt", "private_api_key", "anonymous"]) {
  test(`explicit ${mode} selection saves and refills without claiming effective mode`, async t => {
    let saved;
    const f = fixture(t, async (_id, op, _token, _signal, input) => {
      if (op === "detail") return { asset: { type: "mcp_server" }, ...(saved ? { managedServer: { ...detail.managedServer, inboundAuthMode: saved } } : {}) };
      if (op === "deploy") { saved = input.inboundAuthMode; return {}; }
      return preview(input);
    });
    f.form.open("new"); await tick(); await f.form.save();
    assert.equal(f.state.inboundAuthMode, undefined); assert.equal(f.state.error, "authRequired");
    assert.equal(f.calls.filter(c => c[1] === "deploy").length, 0);
    f.state.inboundAuthMode = mode; await f.form.refresh();
    assert.equal(f.state.preview.inboundAuthMode, mode); assert.equal(f.state.preview.effectiveInboundAuthMode, "unknown");
    await f.form.save(); f.form.open("new"); await tick();
    assert.equal(f.state.inboundAuthMode, mode); assert.equal(f.state.savedInboundAuthMode, mode);
  });
}
test("legacy unknown and unsupported modes never silently become anonymous", async t => {
  for (const mode of [undefined, "unknown", "oauth2"]) {
    const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ?
      { ...detail, managedServer: { ...detail.managedServer, inboundAuthMode: mode } } : preview(input));
    f.form.open("legacy"); await tick(); await f.form.save();
    assert.equal(f.state.inboundAuthMode, undefined); assert.equal(f.form.authBlock(), "authRequired");
    assert.equal(f.calls.filter(c => c[1] === "deploy").length, 0);
  }
});
test("mode changes invalidate previously accepted preview before submission", async t => {
  const f = fixture(t); f.form.open("asset"); await tick();
  f.state.inboundAuthMode = "anonymous"; await f.form.save();
  assert.equal(f.state.preview, null); assert.equal(f.calls.filter(c => c[1] === "deploy").length, 0);
  await f.form.refresh(); await f.form.save(); assert.equal(f.calls.find(c => c[1] === "deploy")[4].inboundAuthMode, "anonymous");
});
test("running server mode changes block submission while unchanged mode remains allowed", async t => {
  const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ?
    { ...detail, managedServer: { ...detail.managedServer, status: "running" } } : preview(input));
  f.form.open("running"); await tick(); assert.equal(f.form.authBlock(), null);
  f.state.inboundAuthMode = "private_jwt"; await f.form.refresh(); await f.form.save();
  assert.equal(f.state.error, "authStop"); assert.equal(f.calls.filter(c => c[1] === "deploy").length, 0);
});
test("server-side running-state race preserves draft and renders actionable conflict", async t => {
  const f = fixture(t, async (_id, op, _token, _signal, input) => {
    if (op === "deploy") throw new Error("MCP_INBOUND_AUTH_MODE_CHANGE_REQUIRES_STOP");
    return op === "detail" ? detail : preview(input);
  });
  f.form.open("asset"); await tick(); await f.form.save();
  assert.equal(f.state.error, "authStop"); assert.equal(f.state.inboundAuthMode, "private_api_key"); assert.equal(f.state.preview, null);
});
test("preview cannot present configured mode as verified effective mode", async t => {
  const f = fixture(t, async (_id, op, _token, _signal, input) => op === "detail" ? detail :
    { ...preview(input), effectiveInboundAuthMode: "private_api_key" });
  f.form.open("asset"); await tick(); assert.equal(f.state.error, "preview"); assert.equal(f.state.preview, null);
});
test("HTTP conflict adapter retains only approved actionable error codes", async t => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; });
  for (const code of ["MCP_INBOUND_AUTH_MODE_REQUIRED", "MCP_INBOUND_AUTH_MODE_CHANGE_REQUIRES_STOP", "private-details"]) {
    global.fetch = async () => ({ ok: false, json: async () => ({ code }) });
    await assert.rejects(api.mcpPublicationRequest("asset", "deploy", "token", new AbortController().signal, {}),
      { message: code === "private-details" ? "MCP_PUBLICATION_FAILED" : code });
  }
});
test("actual dialog template renders unknown effective mode and disabled unknown-mode deployment", async t => {
  const { parse, compileTemplate } = require("@vue/compiler-sfc");
  const { createSSRApp, defineComponent, h } = require("vue");
  const { renderToString } = require("@vue/server-renderer");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/modules/runtime-assets/McpPublicationDialog.vue"), "utf8");
  const compiled = compileTemplate({ source: parse(source).descriptor.template.content, filename: "McpPublicationDialog.vue", id: "test", ssr: true, ssrCssVars: [] });
  assert.deepEqual(compiled.errors, []);
  const templateModule = new Module(filename + ".template", module); templateModule.paths = loaded.paths;
  templateModule._compile(ts.transpileModule(compiled.code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename + ".template");
  const f = fixture(t); f.form.open("asset"); await tick();
  async function render() {
    const app = createSSRApp(defineComponent({ setup: () => ({ state: f.state, form: f.form, t: key => key.split(".").pop() }), ssrRender: templateModule.exports.ssrRender }));
    for (const name of ["TemporaryAnonymousEditor", "ElDialog", "ElForm", "ElFormItem", "ElSelect", "ElOption", "ElInputNumber", "ElInput", "ElAlert", "ElButton"]) {
      app.component(name, defineComponent({ inheritAttrs: false, setup: (_, { slots, attrs }) => () =>
        h(name === "ElButton" ? "button" : "section", { disabled: attrs.disabled || undefined, title: attrs.title }, [slots.default?.(), slots.footer?.()]) }));
    }
    return renderToString(app);
  }
  let html = await render(); assert.match(html, /previewAuth: private_api_key/); assert.match(html, /effectiveAuth: unknown/);
  f.state.inboundAuthMode = undefined; await f.form.refresh(); html = (await render()).replace(/<!--.*?-->/g, "");
  assert.match(html, /title="authRequiredError"/); assert.match(html, /<button disabled>deploy<\/button>/);
});

test("actual runtime detail summary handles undeployed MCP and excludes auth labels for Gateway", async () => {
  const { parse, compileTemplate } = require("@vue/compiler-sfc");
  const { createSSRApp, defineComponent, h } = require("vue");
  const { renderToString } = require("@vue/server-renderer");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/modules/runtime-assets/RuntimeAssetDetail.vue"), "utf8");
  const descriptor = parse(source).descriptor;
  // Compile the real summary-card subtree, including its conditional branches.
  const ast = require("@vue/compiler-dom").parse(descriptor.template.content);
  function findSummary(node) {
    if (node.tag === "el-card" && node.loc.source.includes('detail.runtimeSummary')) return node.loc.source;
    for (const child of node.children || []) { const found = findSummary(child); if (found) return found; }
  }
  const card = findSummary(ast); assert.ok(card);
  const compiled = compileTemplate({ source: card, filename: "RuntimeAssetDetail.vue", id: "detail-test", ssr: true, ssrCssVars: [] });
  assert.deepEqual(compiled.errors, []);
  const templateModule = new Module(filename + ".detail-template", module); templateModule.paths = loaded.paths;
  templateModule._compile(ts.transpileModule(compiled.code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, filename + ".detail-template");
  for (const [asset, managedServer, expected] of [
    [null, null, null],
    [{ type: "mcp_server" }, null, "unknown"],
    [{ type: "mcp_server" }, { inboundAuthMode: "private_jwt" }, "private_jwt"],
    [{ type: "gateway_service" }, null, null],
  ]) {
    const app = createSSRApp(defineComponent({ setup: () => ({ asset, managedServer, runtimeSummary: null, observabilityState: null,
      configuredMcpMode: api.configuredMcpMode, t: key => key.split(".").pop() }), ssrRender: templateModule.exports.ssrRender }));
    for (const name of ["ElCard", "ElDescriptions", "ElDescriptionsItem"]) app.component(name, defineComponent({
      inheritAttrs: false, setup: (_, { slots, attrs }) => () => h("section", { title: attrs.label }, [slots.header?.(), slots.default?.()]) }));
    const html = (await renderToString(app)).replace(/<!--.*?-->/g, "");
    if (expected) {
      assert.match(html, new RegExp('title="authMode">' + expected));
      assert.match(html, /title="effectiveAuth">unknown/);
    } else { assert.doesNotMatch(html, /authMode|effectiveAuth/); }
  }
});

test("temporary grant saves and refills exact policy without submitting actor", async t => {
  let stored = { ...detail.managedServer, inboundAuthMode: "anonymous", temporaryAnonymous: { reason: "review", expiresAt: new Date(Date.now()+3600000).toISOString(), allowProduction: false, actor: "operator-original" } };
  const f=fixture(t, async (_id,op,_token,_signal,input) => { if(op==='detail') return {asset:detail.asset,managedServer:stored}; if(op==='deploy'){ assert.equal(input.temporaryAnonymous.actor,undefined); stored={...stored,temporaryAnonymous:{...input.temporaryAnonymous,actor:'operator-current'}};return {}; }return preview(input); });
  f.form.open('asset');await tick();assert.equal(f.state.temporaryAnonymous.locked,true);assert.equal(f.state.temporaryAnonymous.actor,'operator-original');
  f.state.temporaryAnonymous.reason='renewed';await f.form.save();f.form.open('asset');await tick();assert.equal(f.state.temporaryAnonymous.reason,'renewed');assert.equal(f.state.temporaryAnonymous.actor,'operator-current');
});
test("expired, cleared, unzoned and missing reason grants block before deployment", async t => {
  const f=fixture(t);f.form.open('asset');await tick();f.state.inboundAuthMode='anonymous';f.state.temporaryAnonymous=api.temporaryAnonymousDraft({reason:'review',expiresAt:new Date(Date.now()-1000).toISOString()});await f.form.refresh();
  await f.form.save();assert.equal(f.state.error,'anonymousExpiry');assert.equal(f.calls.filter(x=>x[1]==='deploy').length,0);
  for(const expiry of [null,'','2035-01-01T12:00:00']) {f.state.temporaryAnonymous.expiresAt=expiry;assert.equal(f.form.authBlock(),'anonymousExpiry');}
  f.state.temporaryAnonymous.expiresAt=new Date(Date.now()+60000).toISOString();f.state.temporaryAnonymous.reason=' ';assert.equal(f.form.authBlock(),'anonymousReason');
  f.state.temporaryAnonymous.enabled=false;assert.equal(f.form.authBlock(),'anonymousReason');
});
test("temporary production rejection preserves editable draft and requires new preview", async t => {
  const f=fixture(t,async (_id,op,_token,_signal,input)=> {if(op==='deploy')throw new Error('TEMPORARY_ANONYMOUS_REJECTED');return op==='detail'?detail:preview(input)});
  f.form.open('asset');await tick();f.state.inboundAuthMode='anonymous';f.state.temporaryAnonymous=api.temporaryAnonymousDraft({reason:'production check',expiresAt:new Date(Date.now()+60000).toISOString(),allowProduction:true});await f.form.refresh();await f.form.save();assert.equal(f.state.error,'anonymousRejected');assert.equal(f.state.temporaryAnonymous.allowProduction,true);assert.equal(f.state.visible,true);assert.equal(f.state.preview,null);
});
test("HTTP adapter maps temporary grant refusal without exposing raw server error",async t=>{const original=global.fetch;t.after(()=>global.fetch=original);global.fetch=async()=>({ok:false,json:async()=>({message:'Temporary anonymous grant is invalid, expired or not allowed'})});await assert.rejects(api.mcpPublicationRequest('a','deploy','token',new AbortController().signal,{}),/TEMPORARY_ANONYMOUS_REJECTED/);});
test("Gateway grant merge preserves upstream settings and permanent/protected semantics",()=>{
 const form={routeVisibility:'external',authPolicyRef:'anonymous-team',upstreamConfig:{timeout:10},temporaryAnonymous:api.temporaryAnonymousDraft({reason:'review',expiresAt:new Date(Date.now()+60000).toISOString(),actor:'trusted'})};
 const saved=api.gatewayTemporaryAnonymousConfig(form);assert.equal(saved.upstreamConfig.timeout,10);assert.equal(saved.upstreamConfig.temporaryAnonymous.actor,undefined);
 const reopened=api.temporaryAnonymousDraft({...saved.upstreamConfig.temporaryAnonymous,actor:'server-actor'});assert.equal(reopened.reason,'review');assert.equal(reopened.locked,true);
 assert.deepEqual(api.gatewayTemporaryAnonymousConfig({...form,routeVisibility:'internal'}),{});assert.deepEqual(api.gatewayTemporaryAnonymousConfig({...form,authPolicyRef:'jwt'}),{});assert.deepEqual(api.gatewayTemporaryAnonymousConfig({...form,temporaryAnonymous:api.temporaryAnonymousDraft()}),{});
 assert.throws(()=>api.gatewayTemporaryAnonymousConfig({...form,temporaryAnonymous:{...reopened,expiresAt:'2000-01-01T00:00:00Z'}}),/anonymousExpiry/);
});

test("actual anonymous editor renders saved actor, expiry errors and production warning",async()=>{
 const {parse,compileTemplate}=require('@vue/compiler-sfc'),{createSSRApp,defineComponent,h}=require('vue'),{renderToString}=require('@vue/server-renderer');
 const source=fs.readFileSync(path.resolve(__dirname,'../src/modules/runtime-assets/TemporaryAnonymousEditor.vue'),'utf8');
 const compiled=compileTemplate({source:parse(source).descriptor.template.content,filename:'TemporaryAnonymousEditor.vue',id:'grant-editor-test',ssr:true,ssrCssVars:[]});assert.deepEqual(compiled.errors,[]);
 const templateModule=new Module(filename+'.grant-template',module);templateModule.paths=loaded.paths;templateModule._compile(ts.transpileModule(compiled.code,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,filename+'.grant-template');
 for(const enabled of [true,false]) {
  const draft=enabled?api.temporaryAnonymousDraft({reason:'test',expiresAt:'2000-01-01T00:00:00Z',actor:'saved-operator'}):api.temporaryAnonymousDraft();
  const app=createSSRApp(defineComponent({setup:()=>({draft,temporaryAnonymousError:api.temporaryAnonymousError,t:key=>key.split('.').pop()}),ssrRender:templateModule.exports.ssrRender}));
  for(const name of ['ElAlert','ElCheckbox','ElFormItem','ElInput','ElDatePicker'])app.component(name,defineComponent({inheritAttrs:false,setup:(_, {slots,attrs})=>()=>h('section',{title:attrs.title,disabled:attrs.disabled||undefined},slots.default?.())}));
  const html=await renderToString(app);assert.match(html,/anonymousRisk/);if(enabled){assert.match(html,/anonymousExpiryError/);assert.match(html,/productionHint/);assert.match(html,/saved-operator/);assert.match(html,/disabled/);}else assert.match(html,/permanentHint/);
 }
});

test('temporary refusal adapter accepts textual and structured-code formats',async t=>{const original=global.fetch;t.after(()=>global.fetch=original);for(const message of ['Temporary anonymous grant is invalid, expired or not allowed','temporary_anonymous_expired','temporary_anonymous_production_forbidden']){global.fetch=async()=>({ok:false,json:async()=>({message})});await assert.rejects(api.mcpPublicationRequest('a','deploy','token',new AbortController().signal,{}),/TEMPORARY_ANONYMOUS_REJECTED/);}});
