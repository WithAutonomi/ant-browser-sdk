import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createWriteStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
// Run after npm run sync:wasm and npm run check. Requires the sibling node
// binary and ant-core/browser-tests Playwright installation. Uses only a fresh
// local Anvil chain and processes created by this script; no testnet changes.
const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const projects = dirname(sdk);
const { chromium } = await import(`${projects}/ant-client-web-support/ant-core/browser-tests/node_modules/playwright-core/index.mjs`);
const { Wallet } = await import(`${sdk}/node_modules/ethers/lib.esm/index.js`);
const root = await mkdtemp(join(tmpdir(), "ant-rpc-browser-"));
console.log(`Audit artifacts: ${root}`);
const nodes = await mkdtemp(`${root}/nodes-`);
const children = [];
function start(command, args, cwd, name) {
  const child = spawn(command, args, {cwd, stdio:['ignore','pipe','pipe']});
  const log = createWriteStream(`${root}/${name}.log`);
  child.stdout.pipe(log); child.stderr.pipe(log);
  children.push(child); return child;
}
const devnet = start(`${projects}/ant-node-web-support/target/debug/ant-devnet`, [
 '--nodes','12','--data-dir',nodes,'--base-port','46300','--webrtc-direct','--webrtc-direct-base-port','46400',
 '--serve-port','46500','--enable-evm','--enable-logging','--log-level','warn'
], root, 'devnet');
start(process.execPath, ['node_modules/vite/bin/vite.js','--config','examples/all-in-one/vite.config.ts','--port','46573','--strictPort'], sdk, 'vite');
async function ready(url) {
  for(let i=0;i<240;i++) {
    if(children.some(c=>c.exitCode!==null)) throw new Error('A test service exited');
    try { const response=await fetch(url); if(response.ok) return response; } catch {}
    await new Promise(r=>setTimeout(r,500));
  } throw new Error(`Service not ready: ${url}`);
}
let browser;
const results={ provenance: JSON.parse(await readFile(`${sdk}/src/wasm/source.json`, "utf8")) };
try {
  const info=await (await ready('http://127.0.0.1:46500/api/info')).json();
  assert.equal(info.evm.network,'local-anvil');
  const manifest=await (await fetch('http://127.0.0.1:46500/api/browser-manifest.json')).json();
  await ready('http://127.0.0.1:46573/');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  const wasmHashes=new Set();
  page.on('response', async response=>{
    if(new URL(response.url()).pathname.endsWith('.wasm')) {
      wasmHashes.add(createHash('sha256').update(await response.body()).digest('hex'));
    }
  });
  await page.addInitScript(()=>{
    window.testPeers=[];
    const Original=window.RTCPeerConnection;
    window.RTCPeerConnection=class extends Original {
      constructor(...args){super(...args);window.testPeers.push(this);}
    };
    // Exercise the demo's browser download fallback without an OS picker.
    delete window.showSaveFilePicker;
  });
  await page.goto('http://127.0.0.1:46573/');
  await page.locator('#bootstrap').fill(manifest.endpoints[0].multiaddr ?? manifest.endpoints[0]);
  await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#connection').value.startsWith('Connected'),{},{timeout:30000});
  console.log('Demo connected');
  const key=Wallet.fromPhrase('test test test test test test test test test test test junk').privateKey;
  await page.locator('#payment-rpc').fill(info.evm.rpc_url);
  await page.locator('#wallet').fill(key);
  const content=randomBytes(1024*1024);
  await page.locator('#upload-input').setInputFiles({name:'rpc-demo.bin',mimeType:'application/octet-stream',buffer:content});
  await page.locator('#upload').click();
  await page.waitForFunction(()=>/Uploaded rpc-demo/.test(document.querySelector('#log').textContent)||/Error:/.test(document.querySelector('#log').textContent),{},{timeout:180000});
  const log=await page.locator('#log').textContent();
  await writeFile(`${root}/demo.log`,log);
  assert.match(log,/Uploaded rpc-demo/);
  console.log('Demo uploaded');
  const downloadPromise=page.waitForEvent('download',{timeout:180000});
  await page.locator('#download').click();
  const download=await downloadPromise;
  const downloaded=await readFile(await download.path());
  assert.deepEqual(downloaded,content);
  results.demo={bytes:content.length,matches:true,address:await page.locator('#address').inputValue()};
  console.log('Demo download matches');
  await page.reload();
  await page.exposeFunction('measure', value=>console.log(JSON.stringify(value)));
  results.large=await page.evaluate(async ({sdk,endpoint,rpcUrl,key})=>{
    const {AutonomiClient}=await import(`/@fs/${sdk}/dist/index.js`);
    const {createEthersPaymentProvider}=await import(`/@fs/${sdk}/dist/ethers.js`);
    const wallet=createEthersPaymentProvider({privateKey:key,rpcUrl});
    let payments=0,forced=false,forcedPeerClosed=false;
    const payment={pay(...args){payments++;return wallet.pay(...args);}};
    const client=await AutonomiClient.connect(endpoint,{payment});
    const poolStart=window.testPeers.length;
    await client.findClosest('33'.repeat(32));
    const bytes=new Uint8Array(100*1024*1024);
    for(let offset=0;offset<bytes.length;offset+=65536) crypto.getRandomValues(bytes.subarray(offset,Math.min(offset+65536,bytes.length)));
    const started=performance.now();
    let lookup;
    try {
      const upload=await client.upload(bytes,{name:'rpc-100m.bin',paymentMode:'single',onProgress:e=>{
        if(e.message.includes('Storage payment confirmed') && !forced){
          forced=true;
          lookup=client.findClosest('44'.repeat(32)).then(r=>({nodes:r.nodes.length}),error=>({error:String(error)}));
          setTimeout(()=>{
            const peer=window.testPeers.slice(poolStart).findLast(p=>p.connectionState==='connected');
            if(peer){peer.close();forcedPeerClosed=true;}
          },50);
        }
        if(/Stored record|Storage payment|complete/.test(e.message)) window.measure({message:e.message,ms:performance.now()-started});
      }});
      await window.measure({phase:'uploaded',ms:performance.now()-started,records:upload.records});
      const download=await client.download(upload.file.address);
      const matches=download.bytes.length===bytes.length && download.bytes.every((b,i)=>b===bytes[i]);
      return {bytes:bytes.length,records:upload.records,replicas:upload.file.replicas,matches,payments,forced,forcedPeerClosed,lookup:await lookup,ms:performance.now()-started};
    } finally {client.close();}
  },{sdk,endpoint:manifest.endpoints[0].multiaddr??manifest.endpoints[0],rpcUrl:info.evm.rpc_url,key});
  assert.ok(results.large.records>=26); assert.equal(results.large.matches,true);
  assert.equal(results.large.payments,1); assert.equal(results.large.forcedPeerClosed,true);
  results.servedWasmHashes=[...wasmHashes];
  assert.deepEqual(results.servedWasmHashes,[results.provenance.wasmSha256]);
  results.errors=errors;
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify(results));
} catch(error) {
  results.error=String(error); console.error(error); process.exitCode=1;
} finally {
  await writeFile(`${root}/results.json`,JSON.stringify(results,null,2));
  await browser?.close();
  for(const child of children) if(child.exitCode===null) child.kill('SIGINT');
  await Promise.all(children.map(child=>child.exitCode!==null?undefined:new Promise(resolve=>{
    const timer=setTimeout(()=>{child.kill('SIGTERM');resolve();},15000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
  })));
}
