import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { communicationFor, communicationText } from '../../../lib/room/communication.ts';
import { rowOf, boardLines, boardStyled, boardSummary, attentionOf, withWait } from './board.ts';
import { waitsFor } from './blockers.ts';
import { fit } from '../../../lib/agent-ui/width.ts';
const source = readFileSync(process.env.CREW_STATS_BASE_SOURCE ?? new URL('../index.ts',import.meta.url),'utf8');
const helpers = source.slice(source.indexOf('  const communicationOf ='),source.indexOf('  const paint ='));
const list = source.slice(source.indexOf('  pi.registerTool({\n    name: "crew_list"'),source.indexOf('  pi.registerCommand("crew_cli"'));
const command = source.slice(source.indexOf('  pi.registerCommand("crew_cli"'),source.lastIndexOf('\n}'));
const paint = source.slice(source.indexOf('  const paint ='),source.indexOf('  /** every reviewer-ish verdict'));

test('production list, stats command and board use the owning run record', async () => {
 const dir=mkdtempSync(join(tmpdir(),'crew-communication-'));
 try {
  const rows=[...['a','b'].map(member=>({type:'event',run:'r',kind:'member_joined',member,details:{backend:'crew'}})),{type:'message',run:'r',id:'m',from:'a',to:['b'],kind:'query'}];
  writeFileSync(join(dir,'room.jsonl'),rows.map(JSON.stringify).join('\n'));
  const workers=new Map(['a','b'].map((name,i)=>[name,{name,id:i+1,run:'r',pane:`%${i}`,spawnedAt:new Date().toISOString()}]));
  const sent=[],notices=[],tools=new Map(),commands=new Map();let widget;
  const deps={workers,communicationFor,communicationText,runDir:()=>dir,rowOf,boardLines,boardStyled,boardSummary,attentionOf,withWait,waitsFor,fit,folded:false,
   alive:true,BOARD_ID:'crew',held:new Set(),governors:new Map(),colorFor:()=>undefined,
   presence:new Map(),firstTokenMedianMs:new Map(),openConsults:new Map(),milestones:new Map(),milestoneDetail:(m,o)=>o,
   adopt:async()=>{},ensureTicker(){},refresh:async()=>{},staleLine:()=>undefined,board:{section(s){widget=s},remove(){widget=undefined}},
   Type:{Object:()=>({})},notify:(...args)=>notices.push(args),
   pi:{registerTool:t=>tools.set(t.name,t),registerCommand:(n,c)=>commands.set(n,c),sendMessage:m=>sent.push(m)}};
  const code=stripTypeScriptTypes(`let ui;\n${helpers}\n${list}\n${command}\n${paint}`)+'\nreturn {paint, setUi: v=>{ui=v}};';
  const host=new Function(...Object.keys(deps),code)(...Object.values(deps));
  const result=await tools.get('crew_list').execute();
  assert.equal(result.details.communication[0].communication.counts.sent,1);
  await commands.get('crew_cli').handler('stats #2',{});
  assert.equal(sent.length,1);assert.match(sent[0].content,/#2 b/);assert.doesNotMatch(sent[0].content,/#1 a/);assert.match(sent[0].content,/addressed in 1/);
  await commands.get('crew_cli').handler('stats missing',{});assert.equal(sent.length,1);assert.match(notices.at(-1)[0],/no worker/);
  host.setUi({hasUI:true,ui:{}});host.paint();
  const lines=widget.render(100, {fg:(_c,s)=>s,bold:s=>s});
  assert.ok(lines.some(line=>line.includes('peer ↑1 ↓0')));
  assert.ok(lines.some(line=>line.includes('peer ↑0 ↓1')));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
