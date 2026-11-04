"use strict";var k=require("node:child_process"),a=require("node:fs/promises"),h=require("node:os"),m=require("node:path"),y=/^skr_[A-Za-z0-9_-]{20,256}$/,d="skaile-harness",u="default",w="Skaile remote agent token";function l(r){return y.test(r)}function S(r=process.env,e=(0,h.homedir)()){let o=r.XDG_CONFIG_HOME?.trim();return(0,m.join)(o?.startsWith("/")?o:(0,m.join)(e,".config"),"skaile")}function p(r={}){let e=r.platform??process.platform,o=r.run??C,t=S(r.env??process.env,r.home??(0,h.homedir)()),n=(0,m.join)(t,"token"),s=T(e,o);return{async read(){let i=s?await s.read().catch(()=>null):null;if(i&&l(i))return i;try{let c=(await(0,a.readFile)(n,"utf8")).trim();return l(c)?c:null}catch{return null}},async write(i){if(!l(i))throw new Error("That is not a Skaile remote-agent token (it starts with skr_).");return s&&await s.write(i).catch(()=>!1)?(await(0,a.rm)(n,{force:!0}),{location:"keychain",detail:s.name}):(await P(t,n,i),{location:"file",detail:n})},async clear(){s&&await s.clear().catch(()=>{}),await(0,a.rm)(n,{force:!0})}}}function T(r,e){if(r==="darwin"){let o=async()=>{let t=await e("security",["find-generic-password","-s",d,"-a",u,"-w"],"");return t.code===0&&t.stdout.trim()||null};return{name:"the macOS keychain",read:o,async write(t){let n=`add-generic-password -U -s ${d} -a ${u} -l "${w}" -w ${t}
`;return(await e("security",["-i"],n)).code===0&&await o()===t},async clear(){await e("security",["delete-generic-password","-s",d,"-a",u],"")}}}if(r==="linux"){let o=["service",d,"account",u],t=async()=>{let n=await e("secret-tool",["lookup",...o],"");return n.code===0&&n.stdout.trim()||null};return{name:"the Secret Service keyring",read:t,async write(n){return(await e("secret-tool",["store",`--label=${w}`,...o],n)).code===0&&await t()===n},async clear(){await e("secret-tool",["clear",...o],"")}}}return null}async function P(r,e,o){await(0,a.mkdir)(r,{recursive:!0,mode:448});let t=`${e}.${process.pid}.tmp`,n=await(0,a.open)(t,"w",384);try{await n.writeFile(`${o}
`,"utf8")}finally{await n.close()}await(0,a.chmod)(t,384),await(0,a.rename)(t,e)}var C=(r,e,o)=>new Promise(t=>{let n;try{n=(0,k.spawn)(r,e,{stdio:["pipe","pipe","ignore"],shell:!1})}catch{t({code:-1,stdout:""});return}let s="",i=setTimeout(()=>n.kill("SIGKILL"),1e4);n.stdout?.setEncoding("utf8").on("data",c=>{s+=c}),n.on("error",()=>{clearTimeout(i),t({code:-1,stdout:""})}),n.on("close",c=>{clearTimeout(i),t({code:c??-1,stdout:s})}),n.stdin?.on("error",()=>{}),n.stdin?.end(o)});var f=`Usage:
  /skaile connect <token>   store a Skaile remote-agent token (skr_\u2026) and connect
  /skaile connect           show the terminal command that keeps the token out of this chat
  /skaile status            show whether Claude Code is connected, the agent and the linked sessions
  /skaile reconnect         reconnect (takes the connection over from another Claude Code session)
  /skaile disconnect        remove the stored token and disconnect`;async function g(r,e){let[o]=r;if(o==="command"){let t=(await e.readStdin()).trim().split(/\s+/).filter(Boolean);return E(t,e)}if(o==="connect"){let t=e.readSecretLine?.("Paste your Skaile remote-agent token (input hidden): "),n=(t?await t:await e.readStdin()).trim();if(!l(n))return e.write(`That is not a Skaile remote-agent token (it starts with skr_). Nothing was stored.
`),1;let s=await e.tokens.write(n);return e.write(`Stored the Skaile token in ${s.detail}. In Claude Code, run /skaile reconnect to connect.
`),0}return o==="disconnect"?(await e.tokens.clear(),e.write(`Removed the stored Skaile token.
`),0):(e.write(`${f}

In a terminal: node "${e.cliPath}" connect   (reads the token from stdin)
`),o===void 0||o==="help"||o==="--help"?0:1)}async function E(r,e){let[o,...t]=r;switch(o){case"connect":{let n=t[0];if(!n)return e.write(`To keep the token out of this conversation, the user runs this in a terminal and pastes the token when asked:

  node "${e.cliPath}" connect

Then /skaile reconnect here. Tell the user exactly that, and show the command.
`),0;if(t.length>1||!l(n))return e.write(`That is not a Skaile remote-agent token (it starts with skr_). Nothing was stored. Tell the user, without repeating what they typed.
`),1;let s=await e.tokens.write(n);return e.write(`Stored the Skaile token in ${s.detail}. NEXT: call the skaile_reconnect tool now and show the user its result. Never repeat the token.
`),0}case"status":case void 0:return e.write(`NEXT: call the skaile_status tool and show the user its result.
`),0;case"reconnect":return e.write(`NEXT: call the skaile_reconnect tool and show the user its result.
`),0;case"disconnect":return await e.tokens.clear(),e.write(`Removed the stored Skaile token. NEXT: call the skaile_reconnect tool so this session drops its connection, and tell the user.
`),0;default:return e.write(`Unknown /skaile command. Show the user this:

${f}
`),1}}function v(){return new Promise((r,e)=>{if(process.stdin.isTTY){r("");return}let o="";process.stdin.setEncoding("utf8"),process.stdin.on("data",t=>{o+=t,o.length>64*1024&&e(new Error("input too long"))}),process.stdin.on("end",()=>r(o)),process.stdin.on("error",e)})}function x(r){let e=process.stdin;return e.isTTY?new Promise(o=>{process.stderr.write(r),e.setRawMode(!0),e.setEncoding("utf8");let t="",n=s=>{for(let i of s){if(i==="\r"||i===`
`||i===""){e.setRawMode(!1),e.off("data",n),e.pause(),process.stderr.write(`
`),o(t);return}i===""&&(e.setRawMode(!1),process.stderr.write(`
`),process.exit(130)),t=i==="\x7F"||i==="\b"?t.slice(0,-1):t+i}};e.on("data",n),e.resume()}):null}g(process.argv.slice(2),{readStdin:v,readSecretLine:x,write:r=>process.stdout.write(r),tokens:p(),cliPath:process.argv[1]??"cli.cjs"}).then(r=>{process.exitCode=r}).catch(r=>{process.stdout.write(`Skaile CLI failed: ${r.message}
`),process.exitCode=1});
