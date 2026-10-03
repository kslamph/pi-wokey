import { readFileSync } from "node:fs"; import { homedir } from "node:os"; import { join } from "node:path";
import { createHash } from "node:crypto";
const key = process.env.WOKEY_API_KEY ?? JSON.parse(readFileSync(join(homedir(), ".pi","agent","wokey.json"),"utf8")).apiKey;
const BASE = "https://api.wokey.ai/v1";
const FILLER = "Cache locality depends on a byte-identical prefix across consecutive calls. ".repeat(300);
async function trial(model, n, gap) {
  const body = { model, instructions:"You are a helpful assistant.",
    input:[{role:"user",content:[{type:"input_text",text:FILLER+"\nSummarize in one word."}]}],
    store:false, include:["reasoning.encrypted_content"], text:{verbosity:"low"}, tool_choice:"auto",
    parallel_tool_calls:true, prompt_cache_key:"cachetest-fixed-key-0001", stream:true };
  const sha = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const rows=[]; const rh=new Set();
  for (let i=0;i<n;i++){
    const res = await fetch(`${BASE}/responses`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify(body)});
    const t = await res.text(); let cached=-1, rbs=null;
    for (const l of t.split("\n")){ if(!l.startsWith("data:"))continue; let p; try{p=JSON.parse(l.slice(5))}catch{continue}
      if(p?.response?.usage) cached=p.response.usage.input_tokens_details?.cached_tokens??0;
      if(p?.request_body_sha256) rbs=p.request_body_sha256; }
    if(rbs) rh.add(rbs);
    rows.push(cached>0?"H":"M");
    await new Promise(r=>setTimeout(r,gap));
  }
  const h=rows.filter(x=>x==="H").length;
  console.log(`${model}: ${h}/${n} hit (${(100*h/n).toFixed(0)}%), miss ${(100*(n-h)/n).toFixed(0)}%  pattern=${rows.join("")}`);
  console.log(`   client_body_sha256=${sha.slice(0,16)}  distinct relay request_body_sha256 across trials = ${rh.size}`);
  return {model,h,n};
}
const a = await trial("gpt-6-luna", 30, 800);
const b = await trial("gpt-6-sol", 15, 800);
const H=a.h+b.h, N=a.n+b.n;
console.log(`\nTOTAL: ${H}/${N} hit = ${(100*H/N).toFixed(1)}%  |  miss rate ${(100*(N-H)/N).toFixed(1)}%`);
