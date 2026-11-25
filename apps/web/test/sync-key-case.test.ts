import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { syncKeyMessage } from '../src/syncPayload';
import { readVersionedSync, decryptVersionedSync, syncKeyAddress, authorizeVersionedSync, writeVersionedSync } from '../src/versionedSyncTransport';
import { encryptSyncPayloadV2 } from '../src/versionedSyncCipher';
const wallet=privateKeyToAccount(('0x'+'12'.repeat(32)) as `0x${string}`),owner=wallet.address.toLowerCase();
async function key(address:string) {
 const signature=await wallet.signMessage({message:syncKeyMessage(address)});
 const input=await webcrypto.subtle.importKey('raw',hexToBytes(signature),'HKDF',false,['deriveKey']);
 return webcrypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode(`Chirpy encrypted sync v1:${owner}`),info:new TextEncoder().encode('settings-prefs-and-saved-messages')},input,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('recovers a checksum-case legacy key, upgrades without losing its identity and reopens with a fresh key',async()=>{
 vi.stubGlobal('crypto',webcrypto);expect(wallet.address).not.toBe(owner);
 const originalKey=await key(wallet.address),iv=new Uint8Array(12).fill(7);
 const plaintext={version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[]},savedMessages:[{id:'original',body:'Preserve original data'}],updatedAt:10};
 const encrypted=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},originalKey,new TextEncoder().encode(JSON.stringify(plaintext)));
 const legacy={version:1,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address:wallet.address,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(encrypted).toString('base64'),updatedAt:10};
 let record={blob:JSON.stringify(legacy),revision:3,minPayloadVersion:1};const before=record.blob;
 const service=new URL('/api/usersync',window.location.href).href;
 vi.stubGlobal('fetch',vi.fn(async(_url,opts:any)=>{
  const response=(body:any)=>({ok:true,status:200,json:async()=>body});
  if(opts?.method==='POST'){
   const write=JSON.parse(opts.body);expect(write.expectedRevision).toBe(record.revision);
   expect(JSON.parse(write.blob).address).toBe(wallet.address);
   record={blob:write.blob,revision:record.revision+1,minPayloadVersion:2};
   return response({ok:true,revision:record.revision,minPayloadVersion:2});
  }
  return response({...record,epoch:0,authVersion:2,payloadVersions:[1,2],service});
 }));
 const snapshot=await readVersionedSync(owner,1,()=>{});
 await expect(decryptVersionedSync(snapshot,await key(owner))).rejects.toThrow();expect(record.blob).toBe(before);
 const signingAddress=syncKeyAddress(snapshot,owner);expect(signingAddress).toBe(wallet.address);
 const recoveredKey=await key(signingAddress),recovered=await decryptVersionedSync(snapshot,recoveredKey);
 expect(recovered!.savedMessages.original.value).toEqual(plaintext.savedMessages[0]);
 const envelope=await encryptSyncPayloadV2(recovered,recoveredKey,signingAddress);
 const authorization=await authorizeVersionedSync(snapshot,message=>wallet.signMessage({message}),()=>{});
 const upgraded=await writeVersionedSync(snapshot,authorization,envelope,()=>{});
 expect(record.revision).toBe(4);expect(record.minPayloadVersion).toBe(2);
 const reopened=await readVersionedSync(owner,2,()=>{});
 const freshKey=await key(syncKeyAddress(reopened,owner));
 expect(await decryptVersionedSync(reopened,freshKey)).toEqual(recovered);
 expect(upgraded.revision).toBe(4);
});
it('rejects arbitrary signing text and preserves the historical case-sensitive message',()=>{
 expect(()=>syncKeyMessage('0xwallet\nAuthorize anything')).toThrow();
 expect(syncKeyMessage(wallet.address)).not.toBe(syncKeyMessage(owner));
});
