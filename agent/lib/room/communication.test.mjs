import test from 'node:test';
import assert from 'node:assert/strict';
import { replayCommunication, workerStats, communicationFor } from './communication.ts';
const join = name => ({ type:'event', kind:'member_joined', run:'r', member:name, details:{backend:'crew'} });
const msg = (id, from, to, extra={}) => ({type:'message',run:'r',id,from,to,kind:'inform',...extra});
const text = rows => rows.map(JSON.stringify).join('\n');
test('counts directed peers, copies, broadcasts and actual correlated replies once', () => {
 const rows=[join('a'),join('b'),join('c'),msg('1','a',['b'],{kind:'query'}),msg('2','b',['a'],{re:'1'}),msg('3','a',['b','c'],{cc:['b']}),msg('4','a',['*'],{kind:'notice'}),msg('5','b',['a'],{re:'missing'}),msg('6','a',['a']),msg('7','main',['a']),msg('8','a',['main']),msg('9','a',['b'],{task:'vitals'}),msg('10','a',['b'],{run:'other'}),msg('1','a',['b'])];
 const s=replayCommunication(text(rows),'r');
 assert.deepEqual(s.workers.get('a'),{sent:2,addressed:2,onePeer:1,multiPeer:1,broadcasts:1,distinctPeers:2,replies:0});
 assert.deepEqual(s.workers.get('b'),{sent:2,addressed:2,onePeer:2,multiPeer:0,broadcasts:0,distinctPeers:1,replies:1});
 assert.equal(s.workers.get('c').addressed,1);
 assert.deepEqual(replayCommunication(text(rows),'r'),s);
});
test('unknown, corrupt and zero are distinct; retired peers retain history', () => {
 assert.equal(communicationFor('/nonexistent/crew-stats-fixture','r','a').status,'unknown');
 const s=replayCommunication(text([join('a'),join('b'),{type:'event',kind:'member_left',run:'r',member:'b'},msg('1','a',['b'])])+'\n{broken','r');
 assert.equal(s.status,'partial');assert.equal(s.malformed,1);assert.equal(s.workers.get('a').sent,1);
 assert.equal(workerStats(s,'absent').status,'unknown');
 assert.equal(replayCommunication(text([join('a')]),'r').workers.get('a').sent,0);
});

test('a correlation must belong to a prior request addressed to the replying peer', () => {
 const s=replayCommunication(text([join('a'),join('b'),join('c'),msg('1','a',['b']),msg('2','c',['a'],{re:'1'}),msg('3','b',['c'],{re:'1'}),msg('4','b',['a'],{re:'future'}),msg('future','a',['b'])]),'r');
 assert.equal(s.workers.get('b').replies,0);assert.equal(s.workers.get('c').replies,0);
});
test('malformed records and undeclared senders cannot masquerade as complete zero', () => {
 for (const bad of [{},msg('1','a',['b'],{cc:'b'}),msg('1','a',['b'],{kind:'invalid'}),msg('1','unknown',['a'])]) {
  assert.equal(replayCommunication(text([join('a'),bad]),'r').status,'partial');
 }
 const s=replayCommunication(text([join('a'),join('governor'),msg('1','governor',['a']),msg('2','a',['governor'])]),'r');
 assert.equal(s.status,'complete');assert.equal(s.workers.get('a').sent,0);
});

test('file cache reloads changed logs and never double-counts repeated queries', async () => {
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join:pathJoin}=await import('node:path');
 const dir=mkdtempSync(pathJoin(tmpdir(),'crew-counter-cache-'));const file=pathJoin(dir,'room.jsonl');
 try {
  const rows=[join('a'),join('b'),msg('1','a',['b'],{cc:['main','b']})];
  writeFileSync(file,text(rows));
  assert.equal(communicationFor(file,'r','a').counts.sent,1);
  assert.equal(communicationFor(file,'r','a').counts.sent,1);
  rows.push(msg('2','a',['b']));writeFileSync(file,text(rows));
  assert.equal(communicationFor(file,'r','a').counts.sent,2);
  assert.equal(communicationFor(file,'other','a').status,'unknown');
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('reused names cannot present aggregate traffic as a fresh worker lifetime', () => {
 const s=replayCommunication(text([join('a'),join('b'),msg('1','a',['b']),{type:'event',run:'r',kind:'member_left',member:'a'},join('a')]),'r');
 const reused=workerStats(s,'a');
 assert.equal(reused.status,'partial');assert.match(reused.reason,/2 join records.*lifetimes/);
 assert.equal(reused.counts.sent,1,'retain aggregate evidence, but mark it ambiguous');
 assert.equal(workerStats(s,'b').status,'complete','unaffected peer remains complete');
});
