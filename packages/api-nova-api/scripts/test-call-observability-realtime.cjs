'use strict';
process.env.DB_TYPE = 'sqlite';
require('reflect-metadata');
require('ts-node').register({ project: require('node:path').join(__dirname, '../tsconfig.json'), transpileOnly: true });
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataSource } = require('typeorm');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { Reflector } = require('@nestjs/core');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');
const { createServer } = require('node:http');
const base = '../src/modules/call-observability/';
const { CALL_OBSERVABILITY_ENTITIES } = require('../src/database/entities/runtime-call-observability.entity.ts');
const { RuntimeObservabilityEventEntity: Event } = require('../src/database/entities/runtime-observability-event.entity.ts');
const { CallObservabilityStore: Store } = require(base + 'call-observability.store.ts');
const { ObservabilityCursorService: Cursors } = require(base + 'call-observability-cursor.service.ts');
const { CallObservabilityEventsService: Events } = require(base + 'call-observability-events.service.ts');
const { CallObservabilityOverviewSnapshotAuthorizer: Grants } = require(base + 'call-observability-overview-snapshot-authorizer.service.ts');
const { ObservabilityAccessGuard: Guard } = require(base + 'call-observability-access.guard.ts');
const { CallObservabilityRealtimeService: Realtime } = require(base + 'call-observability-realtime.service.ts');
const { authorizeObservability } = require(base + 'call-observability-access.ts');
const tokenConstants = require('../src/modules/security/management-access-token.ts');
const filter = { origin: 'external' };
const until = async fn => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };
async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', entities: [...CALL_OBSERVABILITY_ENTITIES, Event], synchronize: true }).initialize();
  const store = new Store(db, {}), grants = new Grants(), secret = randomUUID() + randomUUID();
  const config = new ConfigService({ JWT_SECRET: secret, API_NOVA_OBSERVABILITY_CURSOR_SECRET: secret });
  const cursors = new Cursors(config), events = new Events(store, cursors, grants), jwt = new JwtService();
  const role = { name: 'reader', type: 'custom', enabled: true, permissions: [{ name: 'monitoring:read', enabled: true }],
    metadata: { observabilityScope: { mode: 'assets', runtimeAssetIds: ['a'] } } };
  const user = { id: 'reader', isActive: true, isLocked: false, roles: [role] };
  const guard = new Guard(new Reflector(), jwt, { findUserById: async () => user }, config);
  const realtime = new Realtime(events, guard), scope = authorizeObservability(user);
  const token = options => jwt.sign({ sub: user.id, tokenUse: tokenConstants.MANAGEMENT_TOKEN_USE, ...options }, {
    secret, algorithm: 'HS256', issuer: tokenConstants.MANAGEMENT_TOKEN_ISSUER, audience: tokenConstants.MANAGEMENT_TOKEN_AUDIENCE,
  });
  grants.issue('0', scope, filter);
  const socket = { id: randomUUID(), connected: true, handshake: { auth: { token: token({ exp: Math.floor(Date.now()/1000)+300 }) } },
    frames: [], messages: [], emit(name, payload) { this.messages.push({ name, payload }); },
    disconnect() { this.connected = false; realtime.unsubscribe(this); },
    timeout(ms) { assert.equal(ms, 5000); return { emitWithAck: async (name, payload) => {
      this.frames.push(payload); return this.ack ? this.ack(payload) : { nextCursor: payload.data.nextCursor };
    } }; } };
  async function insert(specs = [{}]) {
    return store.transaction(async tx => {
      const rows = specs.map(spec => ({ id: randomUUID(), sequence: tx.nextSequence(), schemaVersion: '1.0',
        eventName: 'invocation.completed', eventFamily: 'runtime.request', runtimeAssetId: 'a', severity: 'info',
        status: 'success', actorType: 'runtime', retentionClass: 'standard', dispatchState: 'pending',
        subjectId: randomUUID(), subjectVersion: 1, occurredAt: new Date(tx.now), createdAt: new Date(tx.now),
        expiresAt: new Date(Date.now()+600000), dimensions: { serverType: 'gateway' },
        details: { origin: 'external', spanKind: 'gateway_request', outcome: 'success', secret: 'never disclose' }, ...spec }));
      for (let i=0;i<rows.length;i+=50) await tx.manager.getRepository(Event).insert(rows.slice(i,i+50));
      return rows;
    });
  }
  t.after(async () => { realtime.onModuleDestroy(); await db.destroy(); });
  return { db, events, realtime, socket, user, role, insert, token, scope };
}
const start = { ...filter, afterSequence: '0' };
const code = socket => socket.messages.find(m => m.name === 'observability-error')?.payload.code;

test('durable pages pin catchup H, exclude hidden assets and recover without a gap after concurrent commit', async t => {
  const f=await fixture(t); await f.insert([...Array.from({length:51},()=>({})), { runtimeAssetId:'hidden' }]);
  f.socket.ack=async page=>{ if(f.socket.frames.length===1) await f.insert(); return {nextCursor:page.data.nextCursor}; };
  await f.realtime.subscribe(f.socket,start);
  await until(()=>f.socket.frames.length>=3);
  assert.deepEqual(f.socket.frames.slice(0,3).map(p=>[p.data.items.length,p.data.highWatermark]),[[50,'52'],[1,'52'],[1,'53']]);
  assert.equal(new Set(f.socket.frames.flatMap(p=>p.data.items.map(e=>e.eventId))).size,52);
  assert.ok(!JSON.stringify(f.socket.frames).includes('never disclose'));
  const cursor=f.socket.frames[0].data.nextCursor;
  f.realtime.unsubscribe(f.socket);
  f.socket.frames=[]; f.socket.ack=undefined;
  await f.realtime.subscribe(f.socket,{after:cursor});
  assert.deepEqual(f.socket.frames[0].data.items.map(e=>e.sequence),['51']);
});

test('missing/expired/wrong-purpose token and ungranted numeric snapshot fail closed', async t => {
  for(const kind of ['missing','expired','purpose','snapshot']) {
    const f=await fixture(t);
    if(kind==='missing') f.socket.handshake.auth.token='';
    if(kind==='expired') f.socket.handshake.auth.token=f.token({exp:Math.floor(Date.now()/1000)-1});
    if(kind==='purpose') f.socket.handshake.auth.token=f.token({exp:Math.floor(Date.now()/1000)+60,tokenUse:'refresh'});
    await f.realtime.subscribe(f.socket,kind==='snapshot'?{...start,afterSequence:'1'}:start);
    assert.equal(f.socket.frames.length,0); assert.equal(f.socket.connected,false);
    assert.equal(code(f.socket),kind==='snapshot'?'CURSOR_SCOPE_MISMATCH':'UNAUTHENTICATED');
  }
});

test('revocation during database read suppresses the frame before sending', async t => {
  const f=await fixture(t); await f.insert(); const list=f.events.list.bind(f.events);
  f.events.list=async(...args)=>{const page=await list(...args); f.role.metadata.observabilityScope.runtimeAssetIds=['other']; return page;};
  await f.realtime.subscribe(f.socket,start);
  assert.equal(f.socket.frames.length,0); assert.equal(code(f.socket),'CURSOR_SCOPE_MISMATCH');
});

test('idle clients are reauthorized and revoked on the next bounded poll', async t => {
  const f=await fixture(t); await f.realtime.subscribe(f.socket,start);
  f.user.isActive=false; await until(()=>!f.socket.connected);
  assert.equal(code(f.socket),'UNAUTHENTICATED'); assert.equal(f.socket.frames.length,1);
});

test('ACK failure or wrong checkpoint disconnects with no following page', async t => {
  for(const reject of [true,false]) {
    const f=await fixture(t); await f.insert(Array.from({length:51},()=>({})));
    f.socket.ack=()=>{if(reject) throw new Error('socket acknowledgement timeout'); return {nextCursor:'wrong'};};
    await f.realtime.subscribe(f.socket,start);
    assert.equal(code(f.socket),'SLOW_CONSUMER'); assert.equal(f.socket.frames.length,1); assert.equal(f.socket.connected,false);
  }
});

test('subscription single-flight rejects concurrent subscribe while a page is pending', async t => {
  const f=await fixture(t); let resolve; f.socket.ack=()=>new Promise(r=>resolve=r);
  const pending=f.realtime.subscribe(f.socket,start); await until(()=>resolve);
  await f.realtime.subscribe(f.socket,start);
  assert.equal(code(f.socket),'RATE_LIMITED'); resolve({nextCursor:f.socket.frames[0].data.nextCursor}); await pending;
  assert.equal(f.socket.frames.length,1);
});

test('catchup scan budget terminates selective backlog rather than unbounded polling', async t => {
  const f=await fixture(t); let reads=0;
  const list=f.events.list.bind(f.events);
  f.events.list=async(...args)=>{const page=await list(...args); reads++; page.data.hasMore=true; page.data.scannedEvents=1000; return page;};
  await f.realtime.subscribe(f.socket,start); await until(()=>!f.socket.connected);
  assert.equal(reads,11); assert.equal(f.socket.frames.length,10); assert.equal(code(f.socket),'QUERY_TOO_LARGE');
});

test('actual Socket.IO transport uses the same persisted page and client checkpoint ACK', async t => {
  const f=await fixture(t); await f.insert(); const http=createServer(), server=new Server(http);
  server.of('/monitoring').on('connection',socket=>{
    socket.on('subscribe-observability',query=>void f.realtime.subscribe(socket,query));
    socket.on('disconnect',()=>f.realtime.unsubscribe(socket));
  });
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  const client=io(`http://127.0.0.1:${http.address().port}/monitoring`, {autoConnect:false,transports:['websocket'],auth:f.socket.handshake.auth});
  t.after(async()=>{client.disconnect(); await new Promise(r=>server.close(r));});
  const received=new Promise((resolve,reject)=>{
    client.on('connect_error',reject); client.on('connect',()=>client.emit('subscribe-observability',start));
    client.on('observability-event',(page,ack)=>{ack({nextCursor:page.data.nextCursor}); resolve(page);});
  });
  client.connect(); const page=await received;
  assert.equal(page.data.items.length,1); assert.equal(page.data.items[0].sequence,'1');
});

test('unsubscribe cannot release an in-flight database reader slot before completion', async t => {
  const f=await fixture(t); let release, entered=false; const original=f.events.list.bind(f.events);
  f.events.list=async(...args)=>{entered=true; await new Promise(r=>release=r); return original(...args);};
  const pending=f.realtime.subscribe(f.socket,start); await until(()=>entered);
  f.realtime.unsubscribe(f.socket);
  await f.realtime.subscribe(f.socket,start);
  assert.equal(code(f.socket),'RATE_LIMITED'); release(); await pending;
  assert.equal(f.socket.frames.length,0);
});

test('gateway observation mode skips legacy snapshots, blocks legacy packets and excludes old broadcasts', async t => {
  const { MonitoringGateway }=require('../src/modules/websocket/websocket.gateway.ts');
  let authorized=0, oldSnapshots=0, middleware, disconnected=false;
  const realtime={authorize:async()=>{authorized++;},unsubscribe(){}};
  const gateway=new MonitoringGateway(...Array(8).fill({}),realtime);
  gateway.sendInitialData=()=>{oldSnapshots++;};
  const rooms=[];
  const socket={handshake:{auth:{observability:true}},use:fn=>middleware=fn,join:async room=>rooms.push(room),
    disconnect:()=>{disconnected=true;},emit(){}};
  await gateway.handleConnection(socket);
  assert.equal(authorized,1); assert.equal(oldSnapshots,0); assert.deepEqual(rooms,['observability-v1']);
  let next=0; middleware(['subscribe-observability'],()=>next++); assert.equal(next,1);
  middleware(['subscribe-runtime-events'],()=>next++); assert.equal(next,1); assert.equal(disconnected,true);
  const emitted=[];
  gateway.server={emit:()=>assert.fail('unscoped global broadcast'),except:room=>({emit:(name)=>emitted.push([room,name])})};
  gateway.broadcastSystemNotification({type:'test',title:'test',message:'test'});
  assert.deepEqual(emitted,[['observability-v1','system-notification']]);
  gateway.getRuntimeAssetSocketContextByServerId=async()=>({runtimeAssetId:'a'});
  await gateway.emitRuntimeNativeServerEvent('server',{eventName:'status',status:'ok',summary:'test',timestamp:new Date()});
});

test('expired cursor errors never expose recovery metadata computed under a revoked scope', async t => {
  const f=await fixture(t);
  const { ObservabilityApiError }=require(base+'call-observability-api.contract.ts');
  f.events.list=async()=>{f.user.isActive=false; throw new ObservabilityApiError('EVENT_CURSOR_EXPIRED',undefined,
    {availableFrom:'secret-scope-watermark',resnapshotRequired:true});};
  await f.realtime.subscribe(f.socket,start);
  assert.equal(f.socket.frames.length,0);
  assert.equal(code(f.socket),'EVENT_CURSOR_EXPIRED');
  assert.ok(!JSON.stringify(f.socket.messages).includes('secret-scope-watermark'));
});
