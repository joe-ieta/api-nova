'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createUpstreamSecretProvider, UpstreamSecretProviderError } = require('../dist/credentials/secret-provider');
const supported = { skip: process.platform !== 'win32' ? 'Requires real Windows NTFS ACLs' : false };
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function powershell(code, values) {
  return execFileSync(ps, ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')], {windowsHide:true,encoding:'utf8',env:{...process.env,PSModulePath:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules'),ACL_TEST_INPUT:JSON.stringify(values)},timeout:15000});
}
function acl(file, { broad, owner, trusted = false, inherited = false } = {}) {
  powershell(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $d=$env:ACL_TEST_INPUT|ConvertFrom-Json; $item=Get-Item -LiteralPath $d.file -Force; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; if($item.PSIsContainer){$a=$item.GetAccessControl(); $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{$a=$item.GetAccessControl();$inherit=[Security.AccessControl.InheritanceFlags]::None}; $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}; $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,'None','Allow'))); if($d.broad){$other=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($other,$d.broad,$inherit,'None','Allow')))}; if($d.trusted){foreach($v in @('S-1-5-18','S-1-5-32-544')){$tsid=New-Object Security.Principal.SecurityIdentifier($v);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($tsid,'FullControl',$inherit,'None','Allow')))}}; if($d.owner){$a.SetOwner((New-Object Security.Principal.SecurityIdentifier($d.owner)))}; $item.SetAccessControl($a); if($d.inherited){$a=$item.GetAccessControl();$a.SetAccessRuleProtection($false,$true);$item.SetAccessControl($a)}`, {file,broad,owner,trusted,inherited});
}
async function fixture(t) {
  const parent=path.resolve(__dirname,'../../..');await fs.mkdir(parent,{recursive:true});
  const dir=await fs.mkdtemp(path.join(parent,'windows-secret-acl-'));
  t.after(async()=>{const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('windows-secret-acl-'));await fs.rm(resolved,{recursive:true,force:true});});
  acl(dir);
  const root=path.join(dir,'secrets');await fs.mkdir(root);acl(root);
  const provider=createUpstreamSecretProvider({type:'file',root,requireOwnerOnly:true});
  const put=async(key='token',data='synthetic-private-token')=>{const f=path.join(root,key);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,data);return f;};
  return {dir,root,provider,put};
}
function rejected(code,root) {return e=>{assert.ok(e instanceof UpstreamSecretProviderError);assert.equal(e.code,code);assert.ok(!String(e).includes(root));assert.ok(!JSON.stringify(e).includes('synthetic-private-token'));assert.equal(e.cause,undefined);return true;};}
test('Windows actual owner-only ACL resolves file and refreshed value',supported,async t=>{const f=await fixture(t);const p=await f.put();assert.equal(await f.provider.resolve('token'),'synthetic-private-token');await fs.writeFile(p,'rotated-token');assert.equal(await f.provider.resolve('token'),'rotated-token');});
test('Windows private inherited nested ACL is accepted',supported,async t=>{const f=await fixture(t);await f.put('nested/token');assert.equal(await f.provider.resolve('nested/token'),'synthetic-private-token');});
for(const [label,location,right] of [['file read','file','Read'],['file write','file','Write'],['root read','root','Read'],['nested read','nested','Read'],['ancestor delete child','ancestor','DeleteSubdirectoriesAndFiles'],['ancestor ACL change','ancestor','ChangePermissions']]) {
 test('Windows rejects actual '+label+' grant to Everyone',supported,async t=>{const f=await fixture(t);const p=await f.put('nested/token');acl(location==='file'?p:location==='root'?f.root:location==='nested'?path.dirname(p):f.dir,{broad:right});await assert.rejects(f.provider.resolve('nested/token'),rejected('SECRET_FILE_UNSAFE',f.root));});
}
test('Windows rejects inherited broad file ACL',supported,async t=>{const f=await fixture(t);const p=await f.put();acl(f.root,{broad:'Read'});acl(p,{inherited:true});await assert.rejects(f.provider.resolve('token'),rejected('SECRET_FILE_UNSAFE',f.root));});
test('Windows rejects hardlinked file',supported,async t=>{const f=await fixture(t);const p=await f.put();await fs.link(p,path.join(f.root,'alias'));await assert.rejects(f.provider.resolve('token'),rejected('SECRET_FILE_UNSAFE',f.root));});
test('Windows rejects directory junction in root',supported,async t=>{const f=await fixture(t);await f.put();const link=path.join(f.dir,'linked');await fs.symlink(f.root,link,'junction');const p=createUpstreamSecretProvider({type:'file',root:link,requireOwnerOnly:true});await assert.rejects(p.resolve('token'),rejected('SECRET_FILE_UNSAFE',f.root));});
test('Windows rejects directory replacing file',supported,async t=>{const f=await fixture(t);await fs.mkdir(path.join(f.root,'token'));await assert.rejects(f.provider.resolve('token'),e=>{assert.ok(['SECRET_FILE_UNSAFE','SECRET_READ_FAILED'].includes(e.code));return true;});});
test('Windows missing file has redacted error',supported,async t=>{const f=await fixture(t);await assert.rejects(f.provider.resolve('missing'),rejected('SECRET_NOT_FOUND',f.root));});
for(const [label,value,code] of [['empty','','SECRET_VALUE_INVALID'],['newline','synthetic-private-token\n','SECRET_VALUE_INVALID'],['invalid utf8',Buffer.from([0xc3,0x28]),'SECRET_VALUE_INVALID'],['overflow','a'.repeat(8193),'SECRET_LIMIT_EXCEEDED']]) test('Windows rejects '+label,supported,async t=>{const f=await fixture(t);await f.put('token',value);await assert.rejects(f.provider.resolve('token'),rejected(code,f.root));});
test('Windows exact byte limit is accepted',supported,async t=>{const f=await fixture(t);await f.put('token','a'.repeat(8192));assert.equal((await f.provider.resolve('token')).length,8192);});
for(const key of ['../token','token:stream','con','NUL.txt','nested/token.','nested\\token']) test('Windows rejects aliased or escaped key '+key,supported,async t=>{const f=await fixture(t);await assert.rejects(f.provider.resolve(key),rejected('INVALID_SECRET_KEY',f.root));});

test('Windows accepts trusted SYSTEM and Administrators ACL entries',supported,async t=>{const f=await fixture(t);const p=await f.put();acl(p,{trusted:true});assert.equal(await f.provider.resolve('token'),'synthetic-private-token');});
test('Windows refuses a file held open for writing and resolves after writer closes',supported,async t=>{const f=await fixture(t);const p=await f.put();const h=await fs.open(p,'r+');try{await assert.rejects(f.provider.resolve('token'),rejected('SECRET_READ_FAILED',f.root));}finally{await h.close();}assert.equal(await f.provider.resolve('token'),'synthetic-private-token');});
test('Windows rejects nested directory junction',supported,async t=>{const f=await fixture(t);await f.put('real/token');await fs.symlink(path.join(f.root,'real'),path.join(f.root,'alias'),'junction');await assert.rejects(f.provider.resolve('alias/token'),rejected('SECRET_FILE_UNSAFE',f.root));});
test('Windows secret reads do not block concurrent writes to unrelated workspace files',supported,async t=>{
  const f=await fixture(t);await f.put('token','x'.repeat(8192));
  const other=path.join(path.dirname(f.dir),'docs','acl-concurrency-'+path.basename(f.dir)+'.tmp');
  t.after(async()=>{assert.equal(path.dirname(other),path.resolve(__dirname,'../../../docs'));await fs.rm(other,{force:true});});
  let finished=false,writes=0;const reads=Promise.all(Array.from({length:4},()=>f.provider.resolve('token'))).finally(()=>{finished=true;});
  while(!finished){await fs.writeFile(other,'unrelated-document-'+writes);writes++;await new Promise(r=>setTimeout(r,1));}
  assert.ok(writes>1);assert.deepEqual((await reads).map(v=>v.length),[8192,8192,8192,8192]);
});
