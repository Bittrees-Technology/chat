import { test, expect, dismissAnalyticsConsent } from './fixtures/wallet';
import { webcrypto } from 'node:crypto';
import { hexToBytes, stringToHex } from 'viem';
import { decryptSyncPayloadV2 } from '../../apps/web/src/versionedSyncCipher';

async function open(page: import('@playwright/test').Page, firstLoad = true) {
  await page.goto('/'); if (firstLoad) await dismissAnalyticsConsent(page);
  // Disposable fixture provider: emulate a lowercase shared-sign-in identity.
  await page.evaluate(() => {
    const provider=(window as any).ethereum, original=provider.request.bind(provider);
    (window as any).__syncSigns=[];
    provider.request=async(args:any)=>{
      if(args.method==='personal_sign')(window as any).__syncSigns.push(args.params[0]);
      const result=await original(args);
      return ['eth_accounts','eth_requestAccounts'].includes(args.method)?result.map((x:string)=>x.toLowerCase()):result;
    };
  });
  await page.locator('.nav-item',{hasText:'Settings'}).click();
  const connect=page.getByRole('button',{name:'Connect wallet',exact:true});if(await connect.isVisible())await connect.click();
}

test('recovers an older checksum-case snapshot from a lowercase profile and preserves it across upgrade and reload',async({page,walletAddress})=>{
  const owner=walletAddress.toLowerCase();expect(walletAddress).not.toBe(owner);
  await open(page);
  const message=`Chirpy: enable encrypted sync\nAddress: ${walletAddress}\nThis is a gas-free signature used only to derive your sync key.`;
  const signature=await page.evaluate(async message=>(window as any).__walletSign([message]),stringToHex(message));
  const input=await webcrypto.subtle.importKey('raw',hexToBytes(signature),'HKDF',false,['deriveKey']);
  const key=await webcrypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode(`Chirpy encrypted sync v1:${owner}`),info:new TextEncoder().encode('settings-prefs-and-saved-messages')},input,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  const payload={version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[]},savedMessages:[{id:'original',body:'Preserve original synthetic data'}],updatedAt:10};
  const iv=new Uint8Array(12).fill(8),bytes=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(payload)));
  const legacy={version:1,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address:walletAddress,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(bytes).toString('base64'),updatedAt:10};
  let record={blob:JSON.stringify(legacy),revision:3,minPayloadVersion:1},writes=0;
  await page.route('**/api/usersync**',route=>{
    const service=new URL('/api/usersync',route.request().url()).href;
    if(route.request().method()==='GET')return route.fulfill({json:{...record,service,epoch:0,authVersion:2,payloadVersions:[1,2]}});
    const body=route.request().postDataJSON();expect(body.address).toBe(owner);expect(body.expectedRevision).toBe(record.revision);
    expect(JSON.parse(body.blob).address).toBe(walletAddress);
    record={blob:body.blob,revision:record.revision+1,minPayloadVersion:2};writes++;
    return route.fulfill({json:{ok:true,revision:record.revision,minPayloadVersion:2}});
  });
  await page.getByRole('button',{name:'Turn on',exact:true}).click();
  await expect(page.getByRole('button',{name:'Turn off',exact:true})).toBeVisible();
  await expect(page.getByText('Last verified sync:',{exact:false})).toBeVisible();
  expect(writes).toBe(1);expect(record.revision).toBe(4);
  const restored=await decryptSyncPayloadV2(JSON.parse(record.blob),key,owner);
  expect(restored.savedMessages.original.value).toEqual(payload.savedMessages[0]);
  expect(await page.evaluate(()=>(window as any).__syncSigns.length)).toBe(2);
  expect(await page.evaluate(()=>(window as any).__syncSigns[0])).toBe(stringToHex(message));
  await open(page, false);
  await expect(page.getByRole('button',{name:'Re-enable',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__syncSigns.length)).toBe(0);
  await page.getByRole('button',{name:'Re-enable',exact:true}).click();
  await expect(page.getByRole('button',{name:'Turn off',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__syncSigns[0])).toBe(stringToHex(message));
  expect((await decryptSyncPayloadV2(JSON.parse(record.blob),key,owner)).savedMessages.original.value).toEqual(payload.savedMessages[0]);
});

test('an unreadable service does not prompt for an encryption-key signature or report a verified sync',async({page,walletAddress})=>{
  expect(walletAddress).toMatch(/^0x/);await open(page);
  await page.route('**/api/usersync**',route=>route.fulfill({status:503,json:{error:'Synthetic unavailable service'}}));
  await page.getByRole('button',{name:'Turn on',exact:true}).click();
  await expect(page.getByText('Encrypted sync is paused because remote data could not be safely read.',{exact:false})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__syncSigns)).toEqual([]);
  await expect(page.getByText('No sync verified in this browser session.',{exact:true})).toBeVisible();
});
