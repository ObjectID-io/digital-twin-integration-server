import {test} from "node:test";
import assert from "node:assert/strict";
import {loginNetwork,loginPrefix} from "../console/login-network.js";
test("routes both networks independently of the initially opened page",()=>{
 const id="0x"+"a".repeat(64);
 assert.equal(loginNetwork("did:iota:testnet:"+id),"testnet");
 assert.equal(loginNetwork("did:iota:"+id),"mainnet");
 assert.equal(loginPrefix("testnet","mainnet","/mainnet"),"");
 assert.equal(loginPrefix("mainnet","testnet",""),"/mainnet");
 assert.equal(loginPrefix("mainnet","mainnet","/mainnet"),"/mainnet");
 assert.throws(()=>loginNetwork("did:iota:devnet:"+id));
 assert.throws(()=>loginNetwork("did:iota:0x123"));
});
