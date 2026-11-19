'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path'),http=require('node:http');
const {DustforgeClient}=require('../index');
const fetch=require('../public-fetch');
test('SDK refuses private onboarding before sending credentials',async()=>{
  for(const baseUrl of ['https://100.83.112.88','https://[fec0::1]','https://host.ts.net']){
    const c=new DustforgeClient({baseUrl,token:'fixture-only'});
    await assert.rejects(c.createIdentity('fixture','not-a-secret'),{code:'PRIVATE_SERVICE_ROUTE'});
  }
});
test('MCP direct mailbox refuses stale private overrides',()=>{
 const p=spawnSync(process.execPath,[path.join(__dirname,'../mcp-server.js')],{
  env:{PATH:process.env.PATH,HOME:'/nonexistent/public-route-fixture',DUSTFORGE_ENV_FILE:'/nonexistent',DUSTFORGE_JMAP_URL:'http://100.83.112.88:8090',DUSTFORGE_USERNAME:'fixture',DUSTFORGE_PASSWORD:'fixture'},
  input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'dustforge_mail_check',arguments:{}}})+'\n',encoding:'utf8',timeout:3000});
 assert.equal(p.status,0,p.stderr);const d=JSON.parse(p.stdout);assert.equal(d.result.isError,true);assert.match(d.result.content[0].text,/private\/tailnet/);
});
test('loopback fixture preserves JSON bodies and bearer; redirects never followed',async()=>{
 let seen=[];const s=http.createServer((q,r)=>{let body='';q.on('data',x=>body+=x);q.on('end',()=>{seen.push({url:q.url,auth:q.headers.authorization,body});
 if(q.url==='/redirect'){r.writeHead(302,{location:'http://100.83.112.88:8090'});r.end();}else{r.setHeader('content-type','application/json');r.end(JSON.stringify({ok:true}));}});});
 await new Promise(ok=>s.listen(0,'127.0.0.1',ok));
 try{const baseUrl=`http://127.0.0.1:${s.address().port}`;const c=new DustforgeClient({baseUrl,token:'fixture-only'});
 assert.deepEqual(await c.updateProfile({display_name:'fixture'}),{ok:true});assert.equal(seen[0].auth,'Bearer fixture-only');assert.deepEqual(JSON.parse(seen[0].body),{display_name:'fixture'});
 await assert.rejects(fetch(baseUrl+'/redirect'),/redirects are refused/);assert.equal(seen.length,2);
 }finally{await new Promise(ok=>s.close(ok));}
});
