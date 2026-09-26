import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {stripTypeScriptTypes} from 'node:module';
import {RoomStore} from '../../../lib/room/roster.ts';
import {openCrewStore} from '../../../lib/database/store.ts';
import {slugName,uniqueName} from './tmux.ts';
import {allocatedNames} from './names.ts';
const source=readFileSync(process.env.CREW_NAMES_BASE_SOURCE ?? new URL('../index.ts',import.meta.url),'utf8');
const start=source.indexOf('  const spawn = async (');
const end=source.indexOf('    const dir = childDir',start);
const code=stripTypeScriptTypes(source.slice(start,end)+'    return p.name;\n  };')+'\nreturn spawn;';
function setup() {
 const dir=mkdtempSync(`${tmpdir()}/crew-names-`),db=openCrewStore(`${dir}/crew.sqlite`);
 const owner=db.claimMain(db.ensureMain('fixture-main').id,'fixture-instance');
 const store=new RoomStore(dir,db.resolveCrew(owner,'r').id);
 let exists=()=>true; let peerList=async()=>[];
 const deps={alive:true,stopRequested:new Set(),workers:new Map(),specOf:new Map(),allLivePeers:()=>peerList(),
  existsSync:p=>exists(p),HOME:"/fixture",mainPane:"%fixture",AGENT_DIR:"/fixture",
  presetFiles:()=>[],presetReads:()=>[],VAULT:"/fixture",CONSTITUTION:"constitution",mcpGrants:()=>({tools:undefined,servers:[]}),
  registry:()=>({store:db,owner}),room:()=>({roster:()=>store.read()}),runDir:()=>dir,slugName,uniqueName,allocatedNames};
 const spawn=new Function(...Object.keys(deps),code)(...Object.values(deps));
 return {dir,store,spawn,setExists:fn=>{exists=fn},setSessions:fn=>{peerList=fn},close:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('production admission never reuses a departed worker name or artifact namespace',async()=>{
 const h=setup();try {
  h.store.join({name:'reviewer',backend:'crew',role:'reviewer',responsibility:'first review'},'main');
  h.store.leave('reviewer','finished','main');
  assert.equal(h.store.read().members.length,0);
  assert.equal(await h.spawn({role:'reviewer',run:'r'},'/fixture'),'reviewer-2');
  await assert.rejects(h.spawn({name:'reviewer',run:'r'},'/fixture'),/already used|already allocated/);
  assert.equal(await h.spawn({role:'researcher',run:'r'},'/fixture'),'researcher');
 }finally{h.close();}
});
test('concurrent admissions reserve distinct names before the next asynchronous step',async()=>{
 const h=setup();try {
  const names=await Promise.all([h.spawn({role:'reviewer',run:'r'},'/fixture'),h.spawn({role:'reviewer',run:'r'},'/fixture')]);
  assert.deepEqual(names,['reviewer','reviewer-2']);
 }finally{h.close();}
});
test('unknown history blocks reuse, while failed-attempt folders remain reserved',()=>{
 const h=setup();try {
  writeFileSync(`${h.dir}/artifacts.json`,'{}');
  assert.throws(()=>allocatedNames(h.dir,'r',[]),/history/);
  writeFileSync(`${h.dir}/room.jsonl`,'{broken\n');
  assert.throws(()=>allocatedNames(h.dir,'r',[]),/history/);
  writeFileSync(`${h.dir}/room.jsonl`,JSON.stringify({type:'event',run:'other',kind:'member_joined',member:'foreign'})+'\n');
  mkdirSync(`${h.dir}/children/failed`,{recursive:true});
  assert.deepEqual(allocatedNames(h.dir,'r',[]),['failed']);
 }finally{h.close();}
});

for (const [label, fail, args, error] of [
 ['cwd',p=>p!=='/missing',{cwd:'/missing'},/does not exist/],
 ['profile',p=>!p.endsWith('/AGENTS.md'),{profile:'fixture'},/unknown profile/],
 ['constitution',p=>p!=='constitution',{},/constitution.*missing/],
]) test(`failed ${label} preflight releases its in-flight name reservation`,async()=>{
 const h=setup();try {
  h.setExists(fail);
  const request={name:'retryable',run:'r',...args};
  await assert.rejects(h.spawn(request,'/fixture'),error);
  h.setExists(()=>true);
  assert.equal(await h.spawn(request,'/fixture'),'retryable');
 }finally{h.close();}
});
test('asynchronous preflight failure releases the reservation too',async()=>{
 const h=setup();try {
  let calls=0;h.setSessions(async()=>{if(++calls===2)throw new Error('fixture transport');return[]});
  await assert.rejects(h.spawn({name:'retryable',run:'r'},'/fixture'),/fixture transport/);
  h.setSessions(async()=>[]);
  assert.equal(await h.spawn({name:'retryable',run:'r'},'/fixture'),'retryable');
 }finally{h.close();}
});

test('pending names are exclusive across concurrent runs, but completed preflight is not a cross-run tombstone',async()=>{
 const h=setup();try {
  assert.deepEqual(await Promise.all([h.spawn({role:'reviewer',run:'r'},'/fixture'),h.spawn({role:'reviewer',run:'other'},'/fixture')]),['reviewer','reviewer-2']);
  assert.equal(await h.spawn({name:'reviewer',run:'third'},'/fixture'),'reviewer');
 }finally{h.close();}
});
