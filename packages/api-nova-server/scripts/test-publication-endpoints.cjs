const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const childSource = `
process.env.API_NOVA_RUNTIME_AUTH_MODE = 'anonymous';
const { once } = require('node:events');
const { createMcpServer, startSseMcpServer, startStreamableMcpServer } = require(process.env.SERVER_DIST);
(async () => {
 const spec = { openapi:'3.0.3', info:{title:'isolated fixture',version:'1'}, paths:{} };
 const factory = () => createMcpServer({openApiData:spec}, {registerSignalHandlers:false});
 const start = process.env.MODE === 'sse' ? startSseMcpServer : startStreamableMcpServer;
 const server = await start(factory, process.env.ENDPOINT, Number(process.env.PORT), {host:'127.0.0.1'});
 try { if (!server.listening) await once(server,'listening'); }
 catch (error) { process.send({failed:error.code}); process.exit(2); }
 process.send({ready:true,port:server.address().port});
 process.on('message', message => { if (message === 'stop') { server.close(() => { process.send({closed:true}); process.disconnect(); }); server.closeAllConnections(); } });
})().catch(error => { process.send({failed:error.code || error.message}); process.exit(2); });
`;
async function freePort() { const server = net.createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening'); const port=server.address().port; await new Promise(r=>server.close(r)); return port; }
function child(mode, endpoint, port) {
 const proc=spawn(process.execPath,['-e',childSource],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,MODE:mode,ENDPOINT:endpoint,PORT:String(port),SERVER_DIST:path.resolve(__dirname,'../dist/index.js')}});
 let log=''; proc.stdout.on('data',v=>{log=(log+v).slice(-6000);}); proc.stderr.on('data',v=>{log=(log+v).slice(-6000);});
 return {proc,log:()=>log};
}
const request = (url, options={}) => fetch(url,{...options,signal:AbortSignal.timeout(4000)});
async function jsonRpc(response) { const text=await response.text(); if(response.headers.get('content-type')?.includes('application/json')) return JSON.parse(text); return JSON.parse(text.split(/\r?\n/).find(line=>line.startsWith('data:') && line.slice(5).trim().startsWith('{')).slice(5)); }
for (const mode of ['streamable','sse']) test(mode+' custom publication endpoint, health, old path rejection and child cleanup', {timeout:15000}, async t => {
 const port=await freePort(), endpoint='/publication/'+mode, instance=child(mode,endpoint,port), proc=instance.proc;
 t.after(()=>{if(proc.exitCode===null)proc.kill();}); const exited=once(proc,'exit');
 const [ready]=await once(proc,'message'); assert.equal(ready.ready,true,instance.log()); assert.equal(ready.port,port);
 const base='http://127.0.0.1:'+port;
 assert.equal((await request(base+'/health')).status,200);
 assert.equal((await request(base+(mode==='sse'?'/sse':'/mcp'))).status,404);
 if(mode==='streamable') {
  const initialized=await request(base+endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})});
  assert.equal(initialized.status,200); assert.ok((await jsonRpc(initialized)).result);
  const session=initialized.headers.get('mcp-session-id'); assert.ok(session);
  const headers={'mcp-session-id':session,'mcp-protocol-version':'2025-11-25',accept:'text/event-stream'};
  const stream=await request(base+endpoint,{headers}); assert.equal(stream.status,200); await stream.body.cancel();
  assert.equal((await request(base+endpoint,{method:'DELETE',headers})).status,200);
 } else {
  const stream=await request(base+endpoint,{headers:{accept:'text/event-stream'}}); assert.equal(stream.status,200);
  const reader=stream.body.getReader(); let raw='';
  while(!raw.includes('event: endpoint') || !raw.match(/data: .*sessionId=.*\n/)) raw+=new TextDecoder().decode((await reader.read()).value);
  const relative=raw.split(/\r?\n/).find(line=>line.startsWith('data: ')&&line.includes('sessionId=')).slice(6);
  assert.equal(new URL(relative,base).pathname,endpoint+'/messages');
  const initialized=await request(new URL(relative,base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}})});
  assert.equal(initialized.status,202);
  assert.equal((await request(base+'/messages',{method:'POST'})).status,404);
  await reader.cancel();
 }
 const closed=once(proc,'message'); proc.send('stop'); assert.equal((await closed)[0].closed,true);
 assert.deepEqual(await exited,[0,null]);
 const probe=net.createServer(); probe.listen(port,'127.0.0.1'); await once(probe,'listening'); await new Promise(r=>probe.close(r));
});
test('occupied requested port fails without ready or fallback port', {timeout:10000}, async t=>{
 const held=net.createServer(); held.listen(0,'127.0.0.1'); await once(held,'listening'); t.after(()=>new Promise(r=>held.close(r)));
 const instance=child('streamable','/publication/bind',held.address().port), proc=instance.proc;
 t.after(()=>{if(proc.exitCode===null)proc.kill();}); const exited=once(proc,'exit'), messages=[]; proc.on('message',v=>messages.push(v));
 const [code]=await exited; assert.notEqual(code,0,instance.log()); assert.equal(messages.some(v=>v.ready),false); assert.ok(messages.some(v=>v.failed==='EADDRINUSE') || instance.log().includes('EADDRINUSE')); assert.ok(instance.log().includes(String(held.address().port)) || messages[0]?.failed==='EADDRINUSE');
});
