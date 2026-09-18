(() => {
  const fragment=new URLSearchParams(location.hash.slice(1));
  let token=fragment.get("session")||""; history.replaceState(null,"",location.pathname+location.search);
  const prefix=location.pathname.replace(/\/(devices|my-twins)\/?$/,"");
  const $=id=>document.getElementById(id);
  let signals=[], devices=[], native=false;
  const status=value=>{$("status").textContent=value;};
  async function request(path,body) {
    if(!token && !native) throw Error("Sign in with your DID to manage devices.");
    const response=await fetch(prefix+"/api/device-workbench"+path,{credentials:"same-origin",method:body===undefined?"GET":"POST",headers:{...(token?{authorization:"Bearer "+token}:{}),...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const result=await response.json();
    if(!response.ok) throw Error(result.error?.message||result.error?.code||result.error||"IS error");
    return result;
  }
  function download(value,name) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));
    const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function run(action) {
    const buttons=[...document.querySelectorAll("button")];buttons.forEach(b=>b.disabled=true);
    try {await action();} catch(error){status(error.message);} finally{buttons.forEach(b=>b.disabled=false);}
  }
  function clearSignals(){signals=[];$("signals").replaceChildren();}
  $("device").onchange=clearSignals;
  async function refresh() {
    const context=await request("/context");
    $("access-scope").textContent="User: "+context.requesterDid+" · Owner: "+context.ownerDid+(context.plantId?" · Plant: "+context.plantId:"")+(token?" · Temporary delegated session":"");
    const selected=$("device").value, result=await request("/devices");devices=result.devices;
    $("device").replaceChildren(...devices.map(d=>{const o=document.createElement("option");o.value=d.id;o.textContent=d.name+" · "+d.state;return o;}));
    if(devices.some(d=>d.id===selected)) $("device").value=selected;
    if($("device").value!==selected)clearSignals();
    $("catalog").replaceChildren();
    for(const d of devices.filter(d=>!d.revokedAt)) {
      const button=document.createElement("button");button.textContent="REVOKE DEVICE · "+d.name;
      button.onclick=()=>run(async()=>{if(!confirm("Revoke device credentials? Ingestion will stop; the Twin will not be deleted."))return;await request("/devices/"+d.id+"/revoke",{});await refresh();});
      $("catalog").append(button);
    }
    for(const d of devices.filter(d=>d.state==="created")) {
      const article=document.createElement("article"), label=document.createElement("p"), button=document.createElement("button");
      label.textContent=d.name+" · "+d.twinId;button.textContent="EXPORT TWIN CONFIGURATION";
      button.onclick=()=>run(async()=>download(await request("/devices/"+d.id+"/export"),"objectid-twin-"+d.id+".json"));
      article.append(label,button);$("catalog").append(article);
    }
  }
  $("refresh").onclick=()=>run(refresh);
  function clearWorkspace(){clearSignals();devices=[];$("register").reset();$("password").value="";$("catalog").replaceChildren();$("device").replaceChildren();$("access-scope").textContent="";}
  $("disconnect").onclick=()=>run(async()=>{
    const response=await fetch(prefix+"/api/device-auth/logout",{method:"POST",credentials:"same-origin"});
    if(!response.ok)throw Error("Unable to sign out. Please try again.");
    token="";native=false;clearWorkspace();$("workspace").hidden=true;status("Signed out.");window.dispatchEvent(new Event("dtis-session-closed"));
  });
  window.addEventListener("dtis-native-session",event=>{
    native=event.detail.authenticated;
    if(event.detail.explicit){token="";clearWorkspace();}
    $("workspace").hidden=!token&&!native;$("disconnect").hidden=!token&&!native;
    if(native&&!token)run(async()=>{await refresh();status("Signed in with DID. You can register devices and classify data.");});
  });
  $("register").onsubmit=event=>{event.preventDefault();run(async()=>{
    const data=new FormData(event.currentTarget);
    const value=await request("/devices",{name:data.get("name"),encryptionPassword:data.get("encryptionPassword")||undefined});
    download(value,"objectid-device-"+value.deviceId+".json");$("register").reset();await refresh();
    $("device").value=value.deviceId;status("Import the file into your device. Once it sends data, choose CONTINUE DEVICE SETUP.");$("create-dialog").close();
  });};
  $("inspect").onclick=()=>run(async()=>{
    const id=$("device").value;if(!id)throw Error("Select a device.");
    const sample=await request("/devices/"+id+"/inspect",{password:$("password").value||undefined});
    signals=sample.signals;$("signals").replaceChildren();
    for(const signal of signals) {
      const row=document.createElement("tr");
      const values=[true,signal.source,String(signal.value),signal.key,signal.name,signal.unit];
      values.forEach((value,index)=>{const cell=document.createElement("td");if([0,3,4,5].includes(index)){
        const input=document.createElement("input");input.type=index===0?"checkbox":"text";if(index===0)input.checked=true;else input.value=value;
        input.dataset.field=["use","","","key","name","unit"][index];cell.append(input);
      }else cell.textContent=value;row.append(cell);});$("signals").append(row);
    }
    $("classify").elements.name.value=devices.find(d=>d.id===id)?.name||"";
    status("Sample received: "+new Date(sample.receivedAt).toLocaleString());
  });
  $("classify").onsubmit=event=>{event.preventDefault();run(async()=>{
    if(!signals.length)throw Error("Read a sample first.");
    const selected=[...$("signals").children].flatMap((row,index)=>{
      if(!row.querySelector('[data-field="use"]').checked)return [];
      return [{source:signals[index].source,...Object.fromEntries(["key","name","unit"].map(field=>[field,row.querySelector('[data-field="'+field+'"]').value]))}];
    });
    if(!confirm("Create the Twin using the owner's subscription?"))return;
    await request("/devices/"+$("device").value+"/classify",{name:$("classify").elements.name.value,signals:selected,password:$("password").value||undefined});
    $("password").value="";await refresh();status("Twin created. Download its configuration from My Twins when needed.");$("classify-dialog").close();window.dispatchEvent(new Event("dtis-twins-changed"));
  });};
  if(token){$("workspace").hidden=false;$("create-dialog").showModal();run(refresh);}
})();
