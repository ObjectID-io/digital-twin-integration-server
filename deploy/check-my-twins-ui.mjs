import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
try {for(const width of [1440,390]){
 const page=await browser.newPage({viewport:{width,height:1000}});let logged=false;
 const id='0x'+'a'.repeat(64),did='did:iota:testnet:'+id,errors=[];let items=[{twinId:id,name:'Test Twin',description:'Example',canExport:true,roles:['owner']}];
 page.on('pageerror',e=>errors.push(e.message));let downloads=0;page.on('download',()=>downloads++);
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url()),p=url.pathname;let data;
  if(p==='/api/device-auth/session')data={available:true,network:'testnet',subscriptionConfigured:true,session:logged?{did,expiresAt:Date.now()+100000}:null};
  else if(p==='/api/device-auth/challenge')data={challengeId:'test',message:'Local mocked test only'};
  else if(p==='/api/device-auth/verify'){logged=true;data={did};}
  else if(p==='/api/device-workbench/context')data={ownerDid:did,requesterDid:did};
  else if(p==='/api/device-workbench/devices')data={devices:[{id:'device-test',name:'Test device',state:'waiting'}]};
  else if(p.endsWith('/credentials'))data=route.request().method()==='GET'?{associated:true,recoverable:true}:{specVersion:'mock-only',mqttPassword:'disposable-test-value'};
  else if(p.endsWith('/inspect'))data={receivedAt:Date.now(),signals:[{source:'/temperature',key:'temperature',name:'Temperature',unit:'Cel',value:20}]};
  else if(p.endsWith('/classify'))data={specVersion:'objectid.twin-catalog.v1',twins:items};
  else if(p==='/api/my-twins')data={twins:items};
  else if(p.endsWith('/export'))data={specVersion:'objectid.twin-catalog.v1',network:'testnet',twins:items};
  else if(p.endsWith('/edit')){items[0].name=route.request().postDataJSON().name;data={ok:true};}
  else if(p==='/api/my-twins/delete'){items=[];data={results:[{id,deleted:true,result:{}}]};}
  if(data)return route.fulfill({json:data});
  if(p==='/console-assets/status.js')return route.fulfill({body:''});
  const name=p==='/'?'index.html':p==='/my-twins'?'devices.html':p.replace('/console-assets/','');
  if(!/^[a-zA-Z0-9.-]+$/.test(name))return route.abort();
  try{await route.fulfill({body:await readFile(new URL('../console/'+name,import.meta.url)),contentType:name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':'text/css'});}catch{await route.abort();}
 });
 await page.goto('https://dtis-ui.test/');await page.getByRole('button',{name:'SIGN IN',exact:true}).click();
 await page.locator('#login-did').fill(did);await page.locator('#login-seed').fill('1'.repeat(64));await page.locator('#sign-in-submit').click();
 await page.locator('#my-twins-link').waitFor({state:'visible'});assert.equal(page.url(),'https://dtis-ui.test/');assert.equal(await page.locator('#login-dialog').isVisible(),false);
 await page.locator('#my-twins-link').click();await page.getByText('Test Twin',{exact:true}).waitFor();
 assert.equal(await page.locator('#create-dialog').isVisible(),false);
 await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'DOWNLOAD TWIN JSON',exact:true}).click()]);
 const tableBox=await page.locator('.twins-table').boundingBox();assert.ok(tableBox.y<650);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'C:/Users/sdellava/AppData/Local/Temp/dtis-table-'+width+'.png'});
 await page.getByRole('button',{name:'NEW TWIN',exact:true}).click();await page.locator('#create-dialog').waitFor({state:'visible'});await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'CONTINUE DEVICE SETUP'}).click();await page.getByRole('button',{name:'READ LATEST SAMPLE'}).click();await page.locator('#signals input[data-field=key]').waitFor();
 const beforeClassification=downloads;page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'CONFIRM AND CREATE TWIN'}).click();await page.locator('#classify-dialog').waitFor({state:'hidden'});assert.equal(downloads,beforeClassification);
 await page.getByRole('button',{name:'OPEN / EDIT'}).click();await page.locator('#credentials-status').getByText('Download the current configuration without changing credentials.').waitFor();
 await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'DOWNLOAD DEVICE JSON',exact:true}).click()]);
 await page.getByRole('button',{name:'REGENERATE CREDENTIALS',exact:true}).click();await page.locator('#rotate-device-dialog').waitFor({state:'visible'});await page.getByRole('button',{name:'Close credential confirmation'}).click();
 await page.locator('#edit-twin-form input').fill('Renamed');await page.getByRole('button',{name:'SAVE CHANGES'}).click();await page.getByText('Saved on-chain.').waitFor();await page.getByRole('button',{name:'Close edit twin dialog'}).click();
 await page.locator('#twin-list tbody input[type=checkbox]').check();await page.locator('#delete-selected').click();await page.locator('#confirm-delete-twins').click();await page.getByText('No owned Twins found. Choose NEW TWIN to connect a device.').waitFor();
 assert.deepEqual(errors,[]);console.log('Mocked UI login stays on homepage, catalog and modal CRUD: PASS '+width);await page.close();
}}finally{await browser.close();}
