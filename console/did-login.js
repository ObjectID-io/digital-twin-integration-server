import {Ed25519Keypair} from "@iota/iota-sdk/keypairs/ed25519";
import {parseRecoveryFile,decryptRecoveryFile} from "./seed-recovery.js";
const $=id=>document.getElementById(id),form=$("did-login"),prefix=location.pathname.replace(/\/(devices|my-twins|tenant)\/?$/,"").replace(/\/$/,"");
let recovery=null;
const dialog=$("login-dialog");
let requestedLogin=new URLSearchParams(location.search).get("login")==="1";
$("open-login").onclick=()=>{dialog.showModal();form.elements.did.focus();};
$("close-login").onclick=()=>dialog.close();
dialog.addEventListener("close",()=>{recovery=null;form.reset();$("login-message").textContent="";});
dialog.addEventListener("click",event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
async function api(path,body) {
  const response=await fetch(prefix+"/api/device-auth/"+path,{credentials:"same-origin",method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();
  if(!response.ok)throw Error(value.error?.message || value.error || "Sign-in failed");return value;
}
async function session(explicit=false) {
  const value=await api("session");
  if(value.session && dialog.open)dialog.close();$("open-login").hidden=Boolean(value.session);$("identity-section").hidden=!value.session || Boolean(document.body.dataset.home);$("my-twins-link").hidden=!value.session;
  if(requestedLogin){requestedLogin=false;history.replaceState(null,"",location.pathname);if(!value.session)$("open-login").click();}
  form.elements.did.placeholder=value.network==="mainnet"?"did:iota:0x…":"did:iota:"+value.network+":0x…";
  $("identity-info").textContent=value.session?value.session.did+" · session expires at "+new Date(value.session.expiresAt).toLocaleTimeString():"";
  $("subscription-info").textContent=value.subscriptionConfigured?"Subscription linked. Validity and availability are checked before creating a Twin.":"No subscription linked on this IS. Activate one in DT or contact your IS administrator.";
  $("subscription-link").href=value.network==="mainnet"?"https://dt.objectid.io/":"https://dt-demo.objectid.io/";
  if(!value.available)$("login-message").textContent="DID sign-in is not configured on this IS yet.";
  window.dtisSessionState={authenticated:Boolean(value.session),explicit};
  window.dispatchEvent(new CustomEvent("dtis-native-session",{detail:window.dtisSessionState}));
}
form.elements.recovery.onchange=async event=>{
  recovery=null;form.elements.seed.value="";form.elements.recoveryPassword.value="";
  try {const file=event.target.files[0];if(!file)return;if(file.size>65536)throw Error("Recovery file is too large");recovery=parseRecoveryFile(await file.text());if(recovery.did)form.elements.did.value=recovery.did;}
  catch(error){event.target.value="";$("login-message").textContent=error.message;}
};
form.onsubmit=async event=>{
  event.preventDefault();const button=$("sign-in-submit");button.disabled=true;$("login-message").textContent="Verifying signature and DID…";
  let seed="",keypair;
  try {
    seed=recovery?await decryptRecoveryFile(recovery,form.elements.recoveryPassword.value):form.elements.seed.value.trim().replace(/^0x/i,"");
    if(!/^[0-9a-f]{64}$/i.test(seed))throw Error("Enter a 64-character hexadecimal seed or a valid recovery file.");
    keypair=Ed25519Keypair.deriveKeypairFromSeed(seed);seed="";form.elements.seed.value="";form.elements.recoveryPassword.value="";
    const did=form.elements.did.value.trim(),challenge=await api("challenge",{did});
    const signed=await keypair.signPersonalMessage(new TextEncoder().encode(challenge.message));keypair=undefined;
    await api("verify",{did,challengeId:challenge.challengeId,signature:signed.signature});
    recovery=null;form.reset();$("login-message").textContent="";await session(true);
  } catch(error) {$("login-message").textContent=error.message;}
  finally {seed="";keypair=undefined;form.elements.seed.value="";form.elements.recoveryPassword.value="";button.disabled=false;}
};
window.addEventListener("dtis-session-closed",()=>{recovery=null;form.reset();session().catch(error=>$("login-message").textContent=error.message);});
session().catch(error=>$("login-message").textContent=error.message);
if(document.body.dataset.home){
 $("disconnect").onclick=async()=>{try{const r=await fetch(prefix+"/api/device-auth/logout",{method:"POST",credentials:"same-origin"});if(!r.ok)throw Error("Unable to sign out");await session();}catch(e){dialog.showModal();$("login-message").textContent=e.message;}};
 window.addEventListener("dtis-native-session",e=>{$("disconnect").hidden=!e.detail.authenticated;});
}
