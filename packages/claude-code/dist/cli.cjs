"use strict";var y="20.3.0";function C(t){let[e=0,o=0,r=0]=t.replace(/^v/,"").split(".").map(l=>Number.parseInt(l,10)),[n,i,s]=y.split(".").map(Number);return e!==n?e>n:o!==i?o>i:r>=s}function b(t,e){return`The Skaile plugin needs Node.js ${y} or newer, but ${e} is ${t}. Install a current Node.js (22 LTS or newer) and put it first on PATH, then restart Claude Code.`}function _(){(!C(process.version)||typeof AbortSignal.any!="function")&&(process.stderr.write(`[skaile] ${b(process.version,process.execPath)}
`),process.exit(1))}_();var f=require("node:fs/promises"),x=require("node:path");var c=require("node:os"),S=require("node:path");function u(){try{return(0,c.userInfo)().homedir||(0,c.homedir)()}catch{return(0,c.homedir)()}}function d(t=u()){return(0,S.join)(t,".config","skaile")}var P=require("node:child_process"),a=require("node:fs/promises"),I=require("node:path");var N=/^skr_[A-Za-z0-9_-]{20,256}$/,p="skaile-harness",m="default",T="Skaile remote agent token";function h(t){return N.test(t)}function E(t={}){let e=t.platform??process.platform,o=t.run??K,r=d(t.home??u()),n=(0,I.join)(r,"token"),i=O(e,o);return{async read(){let s=i?await i.read().catch(()=>null):null;if(s&&h(s))return s;try{let l=(await(0,a.readFile)(n,"utf8")).trim();return h(l)?l:null}catch{return null}},async write(s){if(!h(s))throw new Error("That is not a Skaile remote-agent token (it starts with skr_).");return i&&await i.write(s).catch(()=>!1)?(await(0,a.rm)(n,{force:!0}),{location:"keychain",detail:i.name}):(await w(r,n,`${s}
`),{location:"file",detail:n})},async clear(){i&&await i.clear().catch(()=>{}),await(0,a.rm)(n,{force:!0})}}}function O(t,e){if(t==="darwin"){let o=async()=>{let r=await e("security",["find-generic-password","-s",p,"-a",m,"-w"],"");return r.code===0&&r.stdout.trim()||null};return{name:"the macOS keychain",read:o,async write(r){let n=`add-generic-password -U -s ${p} -a ${m} -l "${T}" -w ${r}
`;return(await e("security",["-i"],n)).code===0&&await o()===r},async clear(){await e("security",["delete-generic-password","-s",p,"-a",m],"")}}}if(t==="linux"){let o=["service",p,"account",m],r=async()=>{let n=await e("secret-tool",["lookup",...o],"");return n.code===0&&n.stdout.trim()||null};return{name:"the Secret Service keyring",read:r,async write(n){return(await e("secret-tool",["store",`--label=${T}`,...o],n)).code===0&&await r()===n},async clear(){await e("secret-tool",["clear",...o],"")}}}return null}async function w(t,e,o){await(0,a.mkdir)(t,{recursive:!0,mode:448});let r=`${e}.${process.pid}.tmp`;await(0,a.rm)(r,{force:!0});let n=await(0,a.open)(r,"wx",384);try{await n.writeFile(o,"utf8")}finally{await n.close()}await(0,a.chmod)(r,384),await(0,a.rename)(r,e)}var K=(t,e,o)=>new Promise(r=>{let n;try{n=(0,P.spawn)(t,e,{stdio:["pipe","pipe","ignore"],shell:!1})}catch{r({code:-1,stdout:""});return}let i="",s=setTimeout(()=>n.kill("SIGKILL"),1e4);n.stdout?.setEncoding("utf8").on("data",l=>{i+=l}),n.on("error",()=>{clearTimeout(s),r({code:-1,stdout:""})}),n.on("close",l=>{clearTimeout(s),r({code:l??-1,stdout:i})}),n.stdin?.on("error",()=>{}),n.stdin?.end(o)});function F(t){let e;try{e=new URL(t)}catch{throw new Error(`The Skaile API URL is not a URL: ${t}`)}if(e.protocol!=="https:"&&e.protocol!=="http:")throw new Error(`The Skaile API URL must be an http(s) URL, got ${e.protocol}`);if(e.protocol==="http:"&&!j(e.hostname))throw new Error("The Skaile API URL must use https (http is allowed only for localhost)");if(e.username||e.password||e.search||e.hash)throw new Error("The Skaile API URL must not carry credentials, a query or a fragment");if(e.pathname!=="/")throw new Error(`The Skaile API URL must be an origin only (like https://platform-api.skaile.ai), without the path ${e.pathname}`);return e.origin}function j(t){return t==="localhost"||t==="127.0.0.1"||t==="[::1]"||t==="::1"}function R(t){return(0,x.join)(d(t),"api-url")}async function $(t,e=u()){if(t===null)return await(0,f.rm)(R(e),{force:!0}),null;let o=F(t.trim());return await w(d(e),R(e),`${o}
`),o}var k=`Usage:
  /skaile connect           show the terminal command that stores a Skaile remote-agent token
  /skaile status            show whether Claude Code is connected, the agent and the linked sessions
  /skaile reconnect         reconnect (takes the connection over from another Claude Code session)
  /skaile disconnect        show the terminal command that removes the stored token`;async function A(t,e){let[o]=t;if(o==="command")return D(t.slice(1).filter(Boolean),e);if(o==="connect"){let r=e.readSecretLine?.("Paste your Skaile remote-agent token (input hidden): "),n=(r?await r:await e.readStdin()).trim();if(!h(n))return e.write(`That is not a Skaile remote-agent token (it starts with skr_). Nothing was stored.
`),1;let i=await e.tokens.write(n);return e.write(`Stored the Skaile token in ${i.detail}. In Claude Code, run /skaile reconnect to connect.
`),0}if(o==="disconnect")return await e.tokens.clear(),e.write(`Removed the stored Skaile token.
`),0;if(o==="set-api-url"){let r=t[1];if(!r)return e.write(`Usage: set-api-url <https://your-skaile-api> | --clear
`),1;let n=await(e.saveApiUrl??$)(r==="--clear"?null:r);return e.write(n?`Saved ${n} as the Skaile API. The token goes to this host. Restart Claude Code to use it.
`:`Removed the saved Skaile API URL; the plugin uses https://platform-api.skaile.ai again after a restart.
`),0}return e.write(`${k}

In a terminal:
  node "${e.cliPath}" connect                 read the token from stdin
  node "${e.cliPath}" set-api-url <url>       trust a self-hosted Skaile API (--clear to undo)
`),o===void 0||o==="help"||o==="--help"?0:1}var g=t=>`the user runs this in a terminal and pastes the token when asked:

  node "${t.cliPath}" connect

Then /skaile reconnect here.`,H=t=>/skr_/i.test(t),U=t=>`Nothing was stored: /skaile does not take a token. To store one, ${g(t)} Tell the user exactly that and show the command, without repeating what they typed. If it was a real token, it is now in this conversation, so they can create a new one in Skaile.`,L=t=>`${U(t)}
`,v=t=>`the user runs this in a terminal:

  node "${t.cliPath}" disconnect

Then /skaile reconnect here, so this session drops its connection.`;function M(t){return[`First: if anything the user typed after /skaile contains skr_ (in any case; a Skaile token), whatever the subcommand, or none: do not call any tool, not even skaile_status. ${U(t)}`,"","Otherwise, for each /skaile subcommand, do this:","",`- connect: to store a Skaile token, ${g(t)} Tell the user exactly that and show the command. If they typed anything after connect, nothing was stored: answer as in the first rule.`,"- status (or nothing): call the skaile_status tool and show the user its result.","- reconnect: call the skaile_reconnect tool and show the user its result.",`- disconnect: to remove the stored token, ${v(t)} Tell the user exactly that and show the command.`,`- anything else: show the user this:

${k}`,""].join(`
`)}async function D(t,e){let[o,...r]=t;if(t.some(H))return e.write(L(e)),1;switch(o){case void 0:return e.write(M(e)),0;case"connect":return r.length===0?(e.write(`To store a Skaile token, ${g(e)} Tell the user exactly that, and show the command.
`),0):(e.write(L(e)),1);case"status":return e.write(`NEXT: call the skaile_status tool and show the user its result.
`),0;case"reconnect":return e.write(`NEXT: call the skaile_reconnect tool and show the user its result.
`),0;case"disconnect":return e.write(`To remove the stored Skaile token, ${v(e)} Tell the user exactly that, and show the command.
`),0;default:return e.write(`Unknown /skaile command. Show the user this:

${k}
`),1}}function V(){return new Promise((t,e)=>{if(process.stdin.isTTY){t("");return}let o="";process.stdin.setEncoding("utf8"),process.stdin.on("data",r=>{o+=r,o.length>64*1024&&e(new Error("input too long"))}),process.stdin.on("end",()=>t(o)),process.stdin.on("error",e)})}function Y(t){let e=process.stdin;return e.isTTY?new Promise(o=>{process.stderr.write(t),e.setRawMode(!0),e.setEncoding("utf8");let r="",n=i=>{for(let s of i){if(s==="\r"||s===`
`||s===""){e.setRawMode(!1),e.off("data",n),e.pause(),process.stderr.write(`
`),o(r);return}s===""&&(e.setRawMode(!1),process.stderr.write(`
`),process.exit(130)),r=s==="\x7F"||s==="\b"?r.slice(0,-1):r+s}};e.on("data",n),e.resume()}):null}A(process.argv.slice(2),{readStdin:V,readSecretLine:Y,write:t=>process.stdout.write(t),tokens:E(),cliPath:process.argv[1]??"cli.cjs"}).then(t=>{process.exitCode=t}).catch(t=>{process.stdout.write(`Skaile CLI failed: ${t.message}
`),process.exitCode=1});
