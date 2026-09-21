import { execFile } from 'node:child_process';
import * as path from 'node:path';

// Fixed code only: paths travel as encoded data. Native handles pin every path
// component while security descriptors and file contents are inspected.
const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class ApiNovaPrivateSecret {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFile(string p, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
 [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h, uint type, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 [StructLayout(LayoutKind.Sequential, Pack=4)] struct Info { public uint Attributes; public long Creation; public long Access; public long Write; public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow; }
 static void Reject(string code) { throw new InvalidOperationException(code); }
 static bool Trusted(SecurityIdentifier sid, string user) { string s=sid.Value; return s==user || s=="S-1-5-18" || s=="S-1-5-32-544"; }
 static string Check(SafeFileHandle h, string user, bool privatePath) {
  IntPtr owner, group, dacl, sacl, sd;
  if(GetSecurityInfo(h,1,5,out owner,out group,out dacl,out sacl,out sd)!=0) Reject("SECRET_READ_FAILED");
  try {
   if(dacl==IntPtr.Zero) Reject("SECRET_FILE_UNSAFE");
   byte[] data=new byte[GetSecurityDescriptorLength(sd)]; Marshal.Copy(sd,data,0,data.Length);
   RawSecurityDescriptor acl=new RawSecurityDescriptor(data,0);
   if(acl.Owner==null || (privatePath ? acl.Owner.Value!=user : !Trusted(acl.Owner,user))) Reject("SECRET_FILE_UNSAFE");
   if(acl.DiscretionaryAcl==null || acl.DiscretionaryAcl.Count==0) Reject("SECRET_FILE_UNSAFE");
   foreach(GenericAce entry in acl.DiscretionaryAcl) {
    CommonAce ace=entry as CommonAce;
    if(ace==null || ace.IsCallback) Reject("SECRET_FILE_UNSAFE");
    if((ace.AceFlags & AceFlags.InheritOnly)!=0) continue;
    if(ace.AceQualifier==AceQualifier.AccessDenied) continue;
    if(ace.AceQualifier!=AceQualifier.AccessAllowed) Reject("SECRET_FILE_UNSAFE");
    // Ancestor create/read permissions cannot grant access to protected children.
    uint dangerous=0x40u|0x40000u|0x80000u|0x40000000u|0x10000000u;
    if(!Trusted(ace.SecurityIdentifier,user) && (privatePath || (((uint)ace.AccessMask & dangerous)!=0))) Reject("SECRET_FILE_UNSAFE");
   }
   return Convert.ToBase64String(data);
  } finally { if(sd!=IntPtr.Zero) LocalFree(sd); }
 }
 public static string Read(string root, string key) {
  var handles=new List<SafeFileHandle>(); var descriptors=new List<string>(); var privatePaths=new List<bool>();
  byte[] bytes=new byte[8193];
  try {
   if(root.StartsWith(@"\\") || root.IndexOf(':')!=1 || root.IndexOf(':',2)>=0) Reject("SECRET_FILE_UNSAFE");
   string target=Path.Combine(root,key.Replace('/',Path.DirectorySeparatorChar));
   var directories=new List<string>(); string cursor=Path.GetDirectoryName(target);
   while(cursor!=null) { directories.Add(cursor); cursor=Path.GetDirectoryName(cursor); }
   directories.Reverse(); string user=WindowsIdentity.GetCurrent().User.Value;
   foreach(string directory in directories) {
    SafeFileHandle h=CreateFile(directory,0x20080u,1,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);
    handles.Add(h); if(h.IsInvalid) Reject(Marshal.GetLastWin32Error()==2 || Marshal.GetLastWin32Error()==3 ? "SECRET_NOT_FOUND" : "SECRET_READ_FAILED");
    Info info; if(!GetFileInformationByHandle(h,out info)) Reject("SECRET_READ_FAILED");
    if((info.Attributes & 0x400)!=0 || (info.Attributes & 0x10)==0) Reject("SECRET_FILE_UNSAFE");
    bool isPrivate=directory.Equals(root,StringComparison.OrdinalIgnoreCase) || directory.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);
    privatePaths.Add(isPrivate); descriptors.Add(Check(h,user,isPrivate));
   }
   SafeFileHandle file=CreateFile(target,0x80020000u,1,IntPtr.Zero,3,0x00200000u,IntPtr.Zero);
   handles.Add(file); if(file.IsInvalid) Reject(Marshal.GetLastWin32Error()==2 || Marshal.GetLastWin32Error()==3 ? "SECRET_NOT_FOUND" : "SECRET_READ_FAILED");
   Info before; if(!GetFileInformationByHandle(file,out before)) Reject("SECRET_READ_FAILED");
   if((before.Attributes & (0x400u|0x10u|0x40u))!=0 || before.Links!=1) Reject("SECRET_FILE_UNSAFE");
   string fileAcl=Check(file,user,true); if(before.SizeHigh!=0 || before.SizeLow>8192) Reject("SECRET_LIMIT_EXCEEDED");
   int total=0;
   using(var stream=new FileStream(file,FileAccess.Read)) {
    int n; while(total<bytes.Length && (n=stream.Read(bytes,total,bytes.Length-total))>0) total+=n;
    if(total>8192) Reject("SECRET_LIMIT_EXCEEDED");
    Info after; if(!GetFileInformationByHandle(file,out after)) Reject("SECRET_READ_FAILED");
    if(total!=before.SizeLow || before.Write!=after.Write || before.SizeHigh!=after.SizeHigh || before.SizeLow!=after.SizeLow || before.Links!=after.Links || fileAcl!=Check(file,user,true)) Reject("SECRET_CHANGED_DURING_READ");
    for(int i=0;i<descriptors.Count;i++) if(descriptors[i]!=Check(handles[i],user,privatePaths[i])) Reject("SECRET_CHANGED_DURING_READ");
    return Convert.ToBase64String(bytes,0,total);
   }
  } finally { Array.Clear(bytes,0,bytes.Length); foreach(var h in handles) h.Dispose(); }
 }
}
"@
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:API_NOVA_PRIVATE_FILE_INPUT)) | ConvertFrom-Json
$result = [ApiNovaPrivateSecret]::Read([string]$inputData.root, [string]$inputData.key)
[Console]::Out.Write('OK:' + $result)
} catch {
$code = $_.Exception.GetBaseException().Message
if ($code -notin @('SECRET_FILE_UNSAFE','SECRET_READ_FAILED','SECRET_NOT_FOUND','SECRET_LIMIT_EXCEEDED','SECRET_CHANGED_DURING_READ')) { $code = 'SECRET_READ_FAILED' }
[Console]::Out.Write('ERR:' + $code)
exit 1
}
`;

/** Native failures deliberately never include paths, identities, causes or secret bytes. */
export async function readWindowsPrivateSecret(root: string, key: string): Promise<Buffer> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('SECRET_READ_FAILED');
  return new Promise((resolve, reject) => {
    execFile(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 20000, encoding: 'utf8',
        env: { ...process.env, PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), API_NOVA_PRIVATE_FILE_INPUT: Buffer.from(JSON.stringify({ root, key })).toString('base64') } },
      (error, stdout) => {
        if (!error && /^OK:[A-Za-z0-9+/]*={0,2}$/.test(stdout)) resolve(Buffer.from(stdout.slice(3), 'base64'));
        else {
          const code = /^ERR:(SECRET_FILE_UNSAFE|SECRET_READ_FAILED|SECRET_NOT_FOUND|SECRET_LIMIT_EXCEEDED|SECRET_CHANGED_DURING_READ)$/.exec(stdout)?.[1];
          reject(new Error(code || 'SECRET_READ_FAILED'));
        }
      });
  });
}
