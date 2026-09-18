import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const network of ['testnet','mainnet']){
 const page=await browser.newPage();let enabled=true,writes=0;
 await page.route('**/*',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('status.json'))return route.fulfill({json:{network,overall:'operational',services:['rest','ai','mqtt'].map(id=>({id:'connector-'+id,label:id,status:'operational'})),metrics:{}}});
  if(path.includes('/api/modules/')){
   if(route.request().method()==='POST'){enabled=route.request().postDataJSON().enabled;writes++;}
   return route.fulfill({json:{modules:[{id:'rest',enabled,available:true},{id:'ai',enabled:false,available:false},{id:'commands',enabled:true,available:true}]}});
  }
  if(path.endsWith('status.js'))return route.fulfill({contentType:'application/javascript',body:await readFile('console/status.js','utf8')});
  if(path.endsWith('status.css'))return route.fulfill({contentType:'text/css',body:await readFile('console/status.css','utf8')});
  if(path.endsWith('/'))return route.fulfill({contentType:'text/html',body:(await readFile('console/index.html','utf8')).replace(/<script type="module"[^>]*><\/script>/g,'')});
  return route.fulfill({body:''});
 });
 await page.goto('https://dtis.example/'+(network==='mainnet'?'mainnet/':''));
 await page.locator('.service-card').first().waitFor();
 assert.equal(await page.locator('.module-controls').count(),0);
 const session=async(auth,net)=>page.evaluate(({auth,net})=>window.dispatchEvent(new CustomEvent('dtis-native-session',{detail:{authenticated:auth,network:net}})),{auth,net});
 await session(true,network==='mainnet'?'testnet':'mainnet');
 assert.equal(await page.locator('.module-controls').count(),0);
 await session(true,network);
 await page.getByRole('button',{name:'Pause rest for your tenant',exact:true}).waitFor();
 assert.equal(await page.locator('.module-controls').count(),3);
 assert.equal(await page.getByRole('button',{name:'Enable ai for your tenant',exact:true}).isDisabled(),true);
 page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Pause rest for your tenant',exact:true}).click();
 await page.getByRole('button',{name:'Enable rest for your tenant',exact:true}).waitFor();
 assert.equal(writes,1);
 await session(false,network);assert.equal(await page.locator('.module-controls').count(),0);
 await page.close();console.log(network+': card controls, network isolation, toggle and logout passed');
 }
}finally{await browser.close();}
