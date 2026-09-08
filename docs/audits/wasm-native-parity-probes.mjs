// Audit probes for the behavior documented on 2026-09-08.
// These demonstrate current parity gaps, not desired regression expectations.
// Run with the sibling core wasm-tests/setup-wasm.mjs preloaded (see the report).
import assert from 'node:assert/strict';
import { BrowserNetworkClient, encryptPublicFile, parseWebRtcDirectMultiaddr } from '../../../ant-client-web-support/ant-core/wasm-tests/pkg/ant_core.js';
import { mockWebRtc, paymentNetwork } from '../../../ant-client-web-support/ant-core/wasm-tests/mock-webrtc.mjs';
const content = new TextEncoder().encode('Native parity audit fixture. '.repeat(100));
const encrypted = encryptPublicFile(content);
const map = encrypted.records.at(-1);
{
  const options = Array.from({length: 4}, () => ({chunk: map.content, respond(channel, method) {
    if (method === 'find_node') { channel.emit(new ArrayBuffer(0)); return false; }
  }}));
  const rtc = mockWebRtc(options);
  const sorted = rtc.endpoints.map((endpoint, i) => ({ i, distance: BigInt('0x'+parseWebRtcDirectMultiaddr(endpoint).peerId)^BigInt('0x'+map.address) })).sort((a,b)=> a.distance < b.distance ? -1 : 1);
  options[sorted[0].i].chunk = new Uint8Array([1,2,3]);
  const client = new BrowserNetworkClient(rtc.endpoints);
  let reader;
  try {
    reader = await client.openPublicFile(map.address);
    assert.equal(reader.size, content.length);
    const gets = rtc.requests.filter(r=>r.method==='get_chunk');
    assert.equal(gets.length,2);
    assert.equal(gets[0].node,sorted[0].i);
    console.log(JSON.stringify({case:'integrity failure is retried',wasm:'succeeded after corrupt first peer',native:'chunk_get_from_peer returns InvalidData; shared retrieve returns it immediately',getRequests:gets.length}));
  } finally {reader?.close();client.close();}
}
{
  const decline = {code:'put_failed',message:'audit rejection'};
  const options = Array.from({length:7},(_,i)=> i<3 ? {} : {putError:decline});
  const rtc = mockWebRtc(options);
  const client = new BrowserNetworkClient(rtc.endpoints);
  let retryStarted = false;
  let paymentCount = 0;
  try {
    const result = await client.uploadPublicFile(content, 'audit.bin','application/octet-stream',paymentNetwork,async (_,quotes)=>{
      paymentCount++;
      return {transactionHash:'0x'+'ab'.repeat(32),totalAmount:quotes.reduce((s,q)=>s+BigInt(q.amount),0n).toString()};
    },message=>{
      if (message.startsWith('Retrying ') && !retryStarted) {
        retryStarted = true;
        for (let i=0;i<options.length;i++) options[i].putError = i===3 ? undefined : decline;
        for (const c of rtc.connections) {
          if (c.channel?.server) {
            if (c.channel.index===3) c.channel.close();
            else c.channel.server.set_put_error(decline.code,decline.message);
          }
        }
      }
    });
    assert(retryStarted);
    assert.equal(result.file.replicas,4);
    assert.equal(paymentCount,1);
    console.log(JSON.stringify({case:'PUT acknowledgements accumulate across retry rounds',wasm:'completed with three peers in round one and one in round two',native:'each chunk_put_to_close_group call requires four successes in that round',reportedReplicas:result.file.replicas,records:result.records}));
  } finally {client.close();}
}
{
  const { retainUpload, recordPayment, paidReceipt } = await import('../../dist/internal/upload-recovery.js');
  const network = {chainId:31337,paymentTokenAddress:'0x'+'11'.repeat(20),paymentVaultAddress:'0x'+'22'.repeat(20)};
  const state = retainUpload(network,{bytes:new Uint8Array([1,2,3]),name:'audit.bin',contentType:'application/octet-stream'},'audit');
  const original = {quote:{content:'aa'.repeat(32),timestamp_secs:100},quoteHash:'bb'.repeat(32),amount:'42',rewardsAddress:'0x'+'cc'.repeat(20)};
  recordPayment(state,network,[original],{transactionHash:'0x'+'dd'.repeat(32),totalAmount:'42'});
  assert(paidReceipt(state,network,[original]));
  const refreshed = {...original,quote:{...original.quote,timestamp_secs:101},quoteHash:'ee'.repeat(32)};
  assert.equal(paidReceipt(state,network,[refreshed]),undefined);
  console.log(JSON.stringify({case:'receipt matching requires current quote hashes',sameContent:true,samePrice:true,changedQuoteHash:'retained payment is not reused',scope:'SDK matching helper; quote fixtures are synthetic and no transaction is submitted'}));
}
