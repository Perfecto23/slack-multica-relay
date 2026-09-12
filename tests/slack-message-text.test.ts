import {it,expect} from 'vitest';
import {agentBody} from '../src/slack-message-text.js';
import {readContext} from '../src/slack-context.js';

const section=(text:string)=>({type:'section',text:{type:'mrkdwn',text}});
const context=(text:string,block_id?:string)=>({type:'context',...(block_id?{block_id}:{}),elements:[{type:'mrkdwn',text}]});
const marker='relay-delivery-'+'a'.repeat(64);
const raw={bot_id:'B1',text:'flattened body plus footer',blocks:[section('Body\nSent by is part of the quotation :doge:'),context('stats'),context('Sent by Agent',marker)]};
it('removes recognized footer blocks and preserves body text, line breaks and emoji',()=>{
  expect(agentBody(raw)).toBe('Body\nSent by is part of the quotation :doge:');
});
it('reconstructs Unicode bodies split at the adapter chunk boundary',()=>{
  const first='😀'.repeat(3000);
  expect(agentBody({...raw,blocks:[section(first),section('tail'),context('footer',marker)]})).toBe(first+'tail');
});
it('preserves humans, unmarked bots and unsupported structures',()=>{
  for(const message of [
    {...raw,bot_id:undefined},
    {...raw,blocks:[section('body'),context('Sent by Agent')]},
    {...raw,blocks:[section('one'),section('two'),context('footer',marker)]},
    {...raw,blocks:[{...section('body'),fields:[{text:'important'}]},context('footer',marker)]},
    {...raw,blocks:[section('body'),{type:'image',image_url:'https://example.test/image'},context('footer',marker)]},
    {...raw,blocks:[section('body'),{type:'context',elements:[{type:'image'}]},context('footer',marker)]},
    {...raw,blocks:[section('body'),context('footer','relay-delivery-invalid')]},
  ])expect(agentBody(message)).toBeUndefined();
});
it('projects recognized replies without changing message identity or attachment references',async()=>{
  const event={teamId:'T1',channelId:'C1',threadTs:'100.000001',messageTs:'102.000001',senderUserId:'U1',text:'new request',mention:{type:'user' as const,id:'U2'}};
  const data=await readContext(event,'fixture',async()=>Response.json({ok:true,messages:[{ts:event.threadTs,user:'U1',text:'root'},{...raw,ts:'101.000001',user:'U2',thread_ts:event.threadTs,files:[{id:'F1',name:'file.txt',mimetype:'text/plain'}]}]}),{includeNearby:false});
  const message=data.timeline.messages[0]!.replies!.messages[0]!;
  expect(message).toMatchObject({ts:'101.000001',authorId:'U2',origin:'bot_or_app',footerOmitted:true,text:agentBody(raw)});
  expect(message.files).toHaveLength(1);expect(message.files[0]!.id).toBe('F1');
});
