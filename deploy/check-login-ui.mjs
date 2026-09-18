import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
  const page=await browser.newPage({viewport});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/device-auth/session')),page.goto(process.env.DTIS_UI_URL || 'https://dtis.objectid.io/')]);
  const initialUrl=page.url();
  await page.getByRole('button',{name:'SIGN IN',exact:true}).click();
  assert.equal(page.url(),initialUrl);
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  const dialog=page.getByRole('dialog');await dialog.waitFor({state:'visible'});
  assert.equal(await page.locator('#login-did').getAttribute('autocomplete'),'username');
  assert.equal(await page.locator('#login-seed').getAttribute('autocomplete'),'current-password');
  assert.equal(await page.locator('#login-seed').getAttribute('type'),'password');
  await page.locator('#login-seed').fill('temporary-ui-test-not-a-real-seed');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'SIGN IN',exact:true}).click();
  assert.equal(await page.locator('#login-seed').inputValue(),'');
  const box=await dialog.boundingBox();assert.ok(box.x>=0 && box.x+box.width<=viewport.width);
  await page.getByRole('button',{name:'Close sign-in dialog'}).click();
  await dialog.waitFor({state:'hidden'});assert.deepEqual(errors,[]);
  console.log(`Login modal, autocomplete metadata, secret clearing and JS errors: PASS (${viewport.width}px)`);
  await page.close();
 }
} finally {await browser.close();}
