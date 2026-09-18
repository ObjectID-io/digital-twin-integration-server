import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
const server=createServer(async(q,r)=>{
 try {const path=new URL(q.url,'http://localhost').pathname;
 const file=path.includes('/console-assets/')?path.split('/console-assets/')[1]:'tenant.html';
 if(file.includes('..'))throw Error();
 r.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'application/javascript');
 r.end(await readFile(resolve('console',file)));}catch{r.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const source of ['mainnet','testnet']){
  const target=source==='mainnet'?'testnet':'mainnet',targetPrefix=target==='mainnet'?'/mainnet':'',calls=[],page=await browser.newPage();
  await page.route('**/api/**',async route=>{
   const path=new URL(route.request().url()).pathname,network=path.startsWith('/mainnet/')?'mainnet':'testnet';
   if(path.endsWith('/session'))return route.fulfill({json:{available:true,network,session:null}});
   calls.push(path);
   const body=route.request().postDataJSON();
   assert.equal(JSON.stringify(body).includes('1'.repeat(64)),false);
   if(path.endsWith('/challenge'))return route.fulfill({json:{message:'Test challenge only',challengeId:'mock'}});
   if(path.endsWith('/verify')){assert.equal(typeof body.signature,'string');return route.fulfill({json:{}});}
   return route.fulfill({json:{modules:[]}});
  });
  await page.goto(base+(source==='mainnet'?'/mainnet':'')+'/tenant');
  await page.locator('#open-login').click();
  await page.locator('[name=did]').fill('did:iota:'+(target==='testnet'?'testnet:':'')+'0x'+'a'.repeat(64));
  await page.locator('[name=seed]').fill('1'.repeat(64));
  await page.locator('#sign-in-submit').click();
  await page.waitForURL(base+targetPrefix+'/');
  assert.deepEqual(calls,[targetPrefix+'/api/device-auth/challenge',targetPrefix+'/api/device-auth/verify',(target==='mainnet'?'':'/mainnet')+'/api/device-auth/logout']);
  assert.equal(await page.locator('.brand img').evaluate(img=>img.complete&&img.naturalWidth>0),true);
  await page.close();console.log(source+' -> '+target+': passed');
 }
} finally {await browser.close();await new Promise(r=>server.close(r));}
