import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createRequire} from "node:module";
import assert from "node:assert/strict";
const {chromium}=createRequire(import.meta.url)("playwright");
const root=resolve("console");
const server=createServer(async(q,r)=>{
 try {const path=resolve(root,q.url==="/tenant"?"tenant.html":q.url.split("?")[0].replace(/^\/console-assets\//,""));
 if(!path.startsWith(root+"/")&&!path.startsWith(root+"\\")){r.writeHead(404).end();return;}
 r.setHeader("Content-Type",path.endsWith(".html")?"text/html":path.endsWith(".css")?"text/css":"application/javascript");r.end(await readFile(path));
 }catch{r.writeHead(404).end();}
});
await new Promise(r=>server.listen(5188,"127.0.0.1",r));const browser=await chromium.launch({channel:"chrome",headless:true});
try{
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];let active=true,downloaded=0,rotated=0,revoked=0;
  page.on("pageerror",e=>errors.push(e.message));page.on("download",()=>downloaded++);page.on("dialog",d=>d.accept());
  await page.route("**/api/device-auth/session",r=>r.fulfill({json:{available:true,network:"testnet",session:{did:"did-test",expiresAt:Date.now()+100000},subscriptionConfigured:true}}));
  await page.route("**/api/tenant-access/**",async r=>{
   const action=r.request().url().split("/").at(-1);
   if(action){assert.deepEqual(r.request().postDataJSON(),{confirm:true});if(action==="rotate"){rotated++;active=true;}if(action==="revoke"){revoked++;active=false;}}
   await r.fulfill({json:{tenantId:"my-tenant",version:rotated+1,active,...(action==="rotate"?{api:{apiKey:"test-only"}}:{})}});
  });
  await page.goto("http://127.0.0.1:5188/tenant");
  await page.getByText("Tenant: my-tenant",{exact:false}).waitFor();
  assert.equal(await page.getByRole("link",{name:"OPEN DT",exact:false}).getAttribute("href"),"https://dt-demo.objectid.io/");
  assert.equal(await page.getByRole("button",{name:/BUY|ACTIVATE|CREATE TWIN/}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:"C:/Users/sdellava/AppData/Local/Temp/is-tenant-access-"+width+".png",fullPage:true});
  await page.getByRole("button",{name:"GENERATE / ROTATE & DOWNLOAD JSON",exact:true}).click();
  await page.waitForTimeout(200);assert.equal(rotated,1);assert.equal(downloaded,1);
  await page.getByRole("button",{name:"REVOKE ACCESS",exact:true}).click();
  await page.getByText("Inactive",{exact:false}).waitFor();assert.equal(revoked,1);
  assert.deepEqual(errors,[]);console.log("Tenant portal passed at "+width+"px (mock API, no real credentials changed).");await page.close();
 }
}finally{await browser.close();await new Promise(r=>server.close(r));}
