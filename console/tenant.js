(()=>{
 const $=id=>document.getElementById(id),prefix=location.pathname.replace(/\/tenant\/?$/,"");
 $("open-dt").href=prefix.includes("mainnet")?"https://dt.objectid.io/":"https://dt-demo.objectid.io/";
 async function api(action="",body){const r=await fetch(prefix+"/api/tenant-access/"+action,{method:body?"POST":"GET",credentials:"same-origin",headers:body?{"Content-Type":"application/json"}:{},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error?.message||"Tenant request failed");return v;}
 async function refresh(){const v=await api();$("tenant-status").textContent=v.tenantId?"Tenant: "+v.tenantId+" · version "+v.version+" · "+(v.active?"Active":"Inactive"):"No tenant provisioned. Complete subscription setup in DT."; $("tenant-rotate").disabled=!v.tenantId;$("tenant-revoke").disabled=!v.tenantId||!v.active;}
 async function change(action){if(!confirm("This invalidates the previous tenant application credentials. Continue?"))return;$("tenant-rotate").disabled=$("tenant-revoke").disabled=true;try{const v=await api(action,{confirm:true});if(action==="rotate"){const u=URL.createObjectURL(new Blob([JSON.stringify(v,null,2)],{type:"application/json"})),a=document.createElement("a");a.href=u;a.download="objectid-tenant-access.json";a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}await refresh();}catch(e){$("tenant-status").textContent=e.message+" Check status before retrying.";}}
 $("tenant-rotate").onclick=()=>change("rotate");$("tenant-revoke").onclick=()=>change("revoke");
 const names={ai:"AI analysis",commands:"Device commands",rest:"REST data requests"};
 async function modules(id,enabled){
  const r=await fetch(prefix+"/api/modules/"+(id||""),{method:id?"POST":"GET",credentials:"same-origin",headers:id?{"Content-Type":"application/json"}:{},...(id?{body:JSON.stringify({enabled})}:{})});
  const v=await r.json();if(!r.ok)throw Error(v.error?.message||"Module request failed");
  $("module-list").replaceChildren();
  for(const m of v.modules){const row=document.createElement("div"),label=document.createElement("p"),button=document.createElement("button");row.className="twin-toolbar";label.textContent=names[m.id]+" · "+(!m.available?"Not configured":m.enabled?"Enabled":"Paused");button.type="button";button.textContent=m.enabled?"PAUSE":"ENABLE";button.disabled=!m.available;button.setAttribute("aria-label",button.textContent+" "+names[m.id]);button.onclick=async()=>{if(!confirm((m.enabled?"Pause ":"Enable ")+names[m.id]+" for your tenant?"))return;button.disabled=true;try{await modules(m.id,!m.enabled);$("module-message").textContent="Settings saved.";}catch(e){$("module-message").textContent=e.message;button.disabled=false;}};row.append(label,button);$("module-list").append(row);}
 }
 function moduleSession(e){const active=Boolean(e.detail?.authenticated);$("module-workspace").hidden=!active;$("module-list").replaceChildren();$("module-message").textContent="";if(active)modules().catch(e=>{$("module-message").textContent=e.message;});}
 window.addEventListener("dtis-native-session",moduleSession);if(window.dtisSessionState)moduleSession({detail:window.dtisSessionState});
 function session(e){const active=Boolean(e.detail?.authenticated);$("tenant-workspace").hidden=!active;if(active)refresh().catch(e=>{$("tenant-status").textContent=e.message;});else $("tenant-status").textContent="";}
 window.addEventListener("dtis-native-session",session);if(window.dtisSessionState)session({detail:window.dtisSessionState});
})();
