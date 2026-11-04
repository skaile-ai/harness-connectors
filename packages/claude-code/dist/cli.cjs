"use strict";var f=require("node:fs/promises"),R=require("node:path");var u=require("node:os"),k=require("node:path");function d(){try{return(0,u.userInfo)().homedir||(0,u.homedir)()}catch{return(0,u.homedir)()}}function p(e=d()){return(0,k.join)(e,".config","skaile")}var S=require("node:child_process"),a=require("node:fs/promises"),y=require("node:path");var A=/^skr_[A-Za-z0-9_-]{20,256}$/,h="skaile-harness",m="default",g="Skaile remote agent token";function l(e){return A.test(e)}function T(e={}){let t=e.platform??process.platform,o=e.run??I,r=p(e.home??d()),n=(0,y.join)(r,"token"),i=x(t,o);return{async read(){let s=i?await i.read().catch(()=>null):null;if(s&&l(s))return s;try{let c=(await(0,a.readFile)(n,"utf8")).trim();return l(c)?c:null}catch{return null}},async write(s){if(!l(s))throw new Error("That is not a Skaile remote-agent token (it starts with skr_).");return i&&await i.write(s).catch(()=>!1)?(await(0,a.rm)(n,{force:!0}),{location:"keychain",detail:i.name}):(await w(r,n,`${s}
`),{location:"file",detail:n})},async clear(){i&&await i.clear().catch(()=>{}),await(0,a.rm)(n,{force:!0})}}}function x(e,t){if(e==="darwin"){let o=async()=>{let r=await t("security",["find-generic-password","-s",h,"-a",m,"-w"],"");return r.code===0&&r.stdout.trim()||null};return{name:"the macOS keychain",read:o,async write(r){let n=`add-generic-password -U -s ${h} -a ${m} -l "${g}" -w ${r}
`;return(await t("security",["-i"],n)).code===0&&await o()===r},async clear(){await t("security",["delete-generic-password","-s",h,"-a",m],"")}}}if(e==="linux"){let o=["service",h,"account",m],r=async()=>{let n=await t("secret-tool",["lookup",...o],"");return n.code===0&&n.stdout.trim()||null};return{name:"the Secret Service keyring",read:r,async write(n){return(await t("secret-tool",["store",`--label=${g}`,...o],n)).code===0&&await r()===n},async clear(){await t("secret-tool",["clear",...o],"")}}}return null}async function w(e,t,o){await(0,a.mkdir)(e,{recursive:!0,mode:448});let r=`${t}.${process.pid}.tmp`;await(0,a.rm)(r,{force:!0});let n=await(0,a.open)(r,"wx",384);try{await n.writeFile(o,"utf8")}finally{await n.close()}await(0,a.chmod)(r,384),await(0,a.rename)(r,t)}var I=(e,t,o)=>new Promise(r=>{let n;try{n=(0,S.spawn)(e,t,{stdio:["pipe","pipe","ignore"],shell:!1})}catch{r({code:-1,stdout:""});return}let i="",s=setTimeout(()=>n.kill("SIGKILL"),1e4);n.stdout?.setEncoding("utf8").on("data",c=>{i+=c}),n.on("error",()=>{clearTimeout(s),r({code:-1,stdout:""})}),n.on("close",c=>{clearTimeout(s),r({code:c??-1,stdout:i})}),n.stdin?.on("error",()=>{}),n.stdin?.end(o)});function C(e){let t;try{t=new URL(e)}catch{throw new Error(`The Skaile API URL is not a URL: ${e}`)}if(t.protocol!=="https:"&&t.protocol!=="http:")throw new Error(`The Skaile API URL must be an http(s) URL, got ${t.protocol}`);if(t.protocol==="http:"&&!$(t.hostname))throw new Error("The Skaile API URL must use https (http is allowed only for localhost)");if(t.username||t.password||t.search||t.hash)throw new Error("The Skaile API URL must not carry credentials, a query or a fragment");return t.origin+t.pathname.replace(/\/+$/,"")}function $(e){return e==="localhost"||e==="127.0.0.1"||e==="[::1]"||e==="::1"}function P(e){return(0,R.join)(p(e),"api-url")}async function E(e,t=d()){if(e===null)return await(0,f.rm)(P(t),{force:!0}),null;let o=C(e.trim());return await w(p(t),P(t),`${o}
`),o}var L=`Usage:
  /skaile connect <token>   store a Skaile remote-agent token (skr_\u2026) and connect
  /skaile connect           show the terminal command that keeps the token out of this chat
  /skaile status            show whether Claude Code is connected, the agent and the linked sessions
  /skaile reconnect         reconnect (takes the connection over from another Claude Code session)
  /skaile disconnect        remove the stored token and disconnect`;async function U(e,t){let[o]=e;if(o==="command"){let r=(await t.readStdin()).trim().split(/\s+/).filter(Boolean);return v(r,t)}if(o==="connect"){let r=t.readSecretLine?.("Paste your Skaile remote-agent token (input hidden): "),n=(r?await r:await t.readStdin()).trim();if(!l(n))return t.write(`That is not a Skaile remote-agent token (it starts with skr_). Nothing was stored.
`),1;let i=await t.tokens.write(n);return t.write(`Stored the Skaile token in ${i.detail}. In Claude Code, run /skaile reconnect to connect.
`),0}if(o==="disconnect")return await t.tokens.clear(),t.write(`Removed the stored Skaile token.
`),0;if(o==="set-api-url"){let r=e[1];if(!r)return t.write(`Usage: set-api-url <https://your-skaile-api> | --clear
`),1;let n=await(t.saveApiUrl??E)(r==="--clear"?null:r);return t.write(n?`Saved ${n} as the Skaile API. The token goes to this host. Restart Claude Code to use it.
`:`Removed the saved Skaile API URL; the plugin uses https://platform-api.skaile.ai again after a restart.
`),0}return t.write(`${L}

In a terminal:
  node "${t.cliPath}" connect                 read the token from stdin
  node "${t.cliPath}" set-api-url <url>       trust a self-hosted Skaile API (--clear to undo)
`),o===void 0||o==="help"||o==="--help"?0:1}async function v(e,t){let[o,...r]=e;switch(o){case"connect":{let n=r[0];if(!n)return t.write(`To keep the token out of this conversation, the user runs this in a terminal and pastes the token when asked:

  node "${t.cliPath}" connect

Then /skaile reconnect here. Tell the user exactly that, and show the command.
`),0;if(r.length>1||!l(n))return t.write(`That is not a Skaile remote-agent token (it starts with skr_). Nothing was stored. Tell the user, without repeating what they typed.
`),1;let i=await t.tokens.write(n);return t.write(`Stored the Skaile token in ${i.detail}. NEXT: call the skaile_reconnect tool now and show the user its result. Never repeat the token.
`),0}case"status":case void 0:return t.write(`NEXT: call the skaile_status tool and show the user its result.
`),0;case"reconnect":return t.write(`NEXT: call the skaile_reconnect tool and show the user its result.
`),0;case"disconnect":return await t.tokens.clear(),t.write(`Removed the stored Skaile token. NEXT: call the skaile_reconnect tool so this session drops its connection, and tell the user.
`),0;default:return t.write(`Unknown /skaile command. Show the user this:

${L}
`),1}}function _(){return new Promise((e,t)=>{if(process.stdin.isTTY){e("");return}let o="";process.stdin.setEncoding("utf8"),process.stdin.on("data",r=>{o+=r,o.length>64*1024&&t(new Error("input too long"))}),process.stdin.on("end",()=>e(o)),process.stdin.on("error",t)})}function N(e){let t=process.stdin;return t.isTTY?new Promise(o=>{process.stderr.write(e),t.setRawMode(!0),t.setEncoding("utf8");let r="",n=i=>{for(let s of i){if(s==="\r"||s===`
`||s===""){t.setRawMode(!1),t.off("data",n),t.pause(),process.stderr.write(`
`),o(r);return}s===""&&(t.setRawMode(!1),process.stderr.write(`
`),process.exit(130)),r=s==="\x7F"||s==="\b"?r.slice(0,-1):r+s}};t.on("data",n),t.resume()}):null}U(process.argv.slice(2),{readStdin:_,readSecretLine:N,write:e=>process.stdout.write(e),tokens:T(),cliPath:process.argv[1]??"cli.cjs"}).then(e=>{process.exitCode=e}).catch(e=>{process.stdout.write(`Skaile CLI failed: ${e.message}
`),process.exitCode=1});
