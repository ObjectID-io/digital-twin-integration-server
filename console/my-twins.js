(() => {
 const $=id=>document.getElementById(id),prefix=location.pathname.replace(/\/(devices|my-twins)\/?$/,"");
 let selected=new Set(),twins=[],editing=null,pending=[],deletedHere=new Set();
 async function api(path,body){const r=await fetch(prefix+"/api/my-twins"+path,{credentials:"same-origin",method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await r.json();if(!r.ok)throw Error(value.error?.message||value.error?.code||"Request failed");return value;}
 function button(text,action){const b=document.createElement("button");b.textContent=text;b.onclick=action;return b;}
 function count(){$("delete-selected").disabled=!selected.size;$("delete-selected").textContent="DELETE SELECTED"+(selected.size?" ("+selected.size+")":"");}
 async function refresh(){$("twin-list").setAttribute("aria-busy","true");try{twins=(await api("")).twins.filter(t=>!deletedHere.has(t.twinId));selected=new Set([...selected].filter(id=>twins.some(t=>t.twinId===id)));render();}catch(e){const p=document.createElement("p");p.className="catalog-message catalog-error";p.textContent="Unable to load Twins: "+e.message+". Use REFRESH to try again.";$("twin-list").replaceChildren(p);$("twin-count").textContent="Unavailable";}finally{$("twin-list").setAttribute("aria-busy","false");}}
 function render(){
  const list=$("twin-list");list.replaceChildren();$("twin-count").textContent=String(twins.length).padStart(2,"0");
  if(!twins.length){const p=document.createElement("p");p.className="catalog-message";p.textContent="No owned Twins found. Choose NEW TWIN to connect a device.";list.append(p);}
  const table=document.createElement("table");table.className="twins-table";table.setAttribute("aria-label","Your Twins");
  const head=document.createElement("thead"),header=document.createElement("tr"),selectCell=document.createElement("th"),all=document.createElement("input");
  all.type="checkbox";all.setAttribute("aria-label","Select all Twins");all.checked=twins.length>0&&selected.size===twins.length;all.indeterminate=selected.size>0&&selected.size<twins.length;all.disabled=!twins.length;all.onchange=()=>{selected=all.checked?new Set(twins.map(t=>t.twinId)):new Set();render();};selectCell.append(all);header.append(selectCell);
  for(const title of ["Twin","Twin ID","Actions"]){const th=document.createElement("th");th.scope="col";th.textContent=title;header.append(th);}head.append(header);table.append(head);const tbody=document.createElement("tbody");table.append(tbody);if(twins.length)list.append(table);
  for(const twin of twins){
   const row=document.createElement("tr"),label=document.createElement("td"),checkbox=document.createElement("input"),name=document.createElement("strong"),id=document.createElement("td"),nameCell=document.createElement("td"),actions=document.createElement("td");actions.className="row-actions";id.className="twin-id";
   checkbox.type="checkbox";checkbox.setAttribute("aria-label","Select "+(twin.name||twin.twinId));checkbox.checked=selected.has(twin.twinId);checkbox.onchange=()=>{checkbox.checked?selected.add(twin.twinId):selected.delete(twin.twinId);render();};
   name.textContent=twin.name||twin.twinId;label.append(checkbox);nameCell.append(name);id.textContent=twin.twinId.slice(0,12)+"…"+twin.twinId.slice(-10);id.title=twin.twinId;
   actions.append(button("OPEN / EDIT",()=>{editing=twin.twinId;$("edit-twin-id").textContent=editing;$("edit-twin-form").elements.name.value=twin.name||"";$("edit-twin-form").elements.description.value=twin.description||"";$("edit-result").textContent="";$("edit-twin-dialog").showModal();loadCredentials(editing);}),button("DELETE",()=>confirmDelete([twin.twinId])));if(twin.canExport){const exportButton=button("DOWNLOAD TWIN JSON",async()=>{exportButton.disabled=true;try{const value=await api("/"+twin.twinId+"/export"),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"})),a=document.createElement("a");a.href=url;a.download="objectid-twin-"+twin.twinId+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){$("status").textContent=e.message;}finally{exportButton.disabled=false;}});actions.prepend(exportButton);}row.append(label,nameCell,id,actions);tbody.append(row);
  }count();
 }
 async function loadCredentials(id){
  $("download-device").disabled=true;$("rotate-device").disabled=true;$("credentials-status").textContent="Checking device credentials…";
  try{const status=await api("/"+id+"/credentials");if(editing!==id)return;$("credentials-status").textContent=!status.associated?"No device associated with this Twin on this IS.":status.recoverable?"Download the current configuration without changing credentials.":"Existing secrets cannot be recovered. Regenerate credentials to download a new file.";
  $("download-device").disabled=!status.recoverable;$("rotate-device").disabled=!status.associated;}catch(e){$("credentials-status").textContent=e.message;}
 }
 function downloadConfig(value){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="objectid-device-"+editing+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 $("download-device").onclick=async()=>{const id=editing;$("download-device").disabled=true;try{downloadConfig(await api("/"+id+"/credentials",{action:"download"}));}catch(e){$("credentials-status").textContent=e.message;}finally{await loadCredentials(id);}};
 $("rotate-device").onclick=()=>{$("rotate-target").textContent=editing;$("rotate-result").textContent="";$("confirm-rotate-device").disabled=false;$("rotate-device-dialog").showModal();};
 $("confirm-rotate-device").onclick=async()=>{
  const id=editing,dialog=$("rotate-device-dialog"),close=dialog.querySelector("[data-close]"),prevent=e=>e.preventDefault();
  $("confirm-rotate-device").disabled=true;close.disabled=true;dialog.addEventListener("cancel",prevent);$("rotate-result").textContent="Regenerating credentials…";
  try{downloadConfig(await api("/"+id+"/credentials",{action:"rotate",confirm:true}));$("rotate-result").textContent="New configuration downloaded. Reconfigure your device.";await loadCredentials(id);}catch(e){$("rotate-result").textContent=e.message+". Check credential status before retrying.";await loadCredentials(id);}finally{close.disabled=false;dialog.removeEventListener("cancel",prevent);}
 };
 function confirmDelete(ids){pending=[...ids];$("delete-twin-list").replaceChildren(...pending.map(id=>{const li=document.createElement("li");li.textContent=(twins.find(t=>t.twinId===id)?.name||"Twin")+" · "+id;return li;}));$("delete-result").textContent="";$("confirm-delete-twins").disabled=false;$("delete-twins-dialog").showModal();}
 $("new-twin").onclick=()=>$("create-dialog").showModal();
 $("resume-device").onclick=()=>$("classify-dialog").showModal();
 $("refresh-twins").onclick=refresh;$("delete-selected").onclick=()=>confirmDelete([...selected]);
 for(const b of document.querySelectorAll("[data-close]"))b.onclick=()=>$(b.dataset.close).close();
 $("create-dialog").addEventListener("close",()=>$("register").reset());
 $("classify-dialog").addEventListener("close",()=>$("password").value="");
 $("edit-twin-form").onsubmit=async event=>{
  event.preventDefault();const b=event.currentTarget.querySelector("button");b.disabled=true;
  try{await api("/"+editing+"/edit",{name:event.currentTarget.elements.name.value,description:event.currentTarget.elements.description.value});$("edit-result").textContent="Saved on-chain.";await refresh();}catch(e){$("edit-result").textContent=e.message;}finally{b.disabled=false;}
 };
 $("confirm-delete-twins").onclick=async()=>{
  const b=$("confirm-delete-twins");b.disabled=true;const dlg=$("delete-twins-dialog"),close=dlg.querySelector("[data-close]");close.disabled=true;
  const prevent=e=>e.preventDefault();dlg.addEventListener("cancel",prevent);$("delete-result").textContent="Deleting selected Twins. Please wait…";
  try{const {results}=await api("/delete",{ids:pending,confirm:true});$("delete-result").textContent=results.map(r=>r.id+": "+(r.deleted?(r.result?.cleanupPending?"DELETED — credential cleanup needs attention":"DELETED"):r.error)).join("\n");for(const r of results)if(r.deleted){selected.delete(r.id);deletedHere.add(r.id);}await refresh();}catch(e){$("delete-result").textContent=e.message+". Check chain status before retrying.";}finally{close.disabled=false;dlg.removeEventListener("cancel",prevent);}
 };
 const onSession=e=>{$("personal-twins").hidden=!e.detail.authenticated;if(e.detail.authenticated)refresh();else{twins=[];selected.clear();render();for(const d of document.querySelectorAll("dialog[open]:not(#login-dialog)"))d.close();}};
 window.addEventListener("dtis-native-session",onSession);
 if(window.dtisSessionState)onSession({detail:window.dtisSessionState});
 window.addEventListener("dtis-twins-changed",refresh);
})();
