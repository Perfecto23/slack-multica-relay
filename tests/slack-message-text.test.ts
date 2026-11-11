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

// Shape recorded from chat.postMessage with a markdown block, read back via conversations.history.
const t=(text:string,style?:Record<string,boolean>)=>({type:'text',text,...(style?{style}:{})});
const sectionRich=(...elements:unknown[])=>({type:'rich_text_section',elements});
const cell=(text:string)=>({type:'rich_text',block_id:'c',elements:[sectionRich(t(text))]});
const storedMarkdown={app_id:'A1',user:'U2',text:'flattened',blocks:[
  {type:'rich_text',block_id:'a',elements:[sectionRich(t('结论：'),t('\n\n'))]},
  {type:'header',block_id:'b',text:{type:'plain_text',text:'小标题',emoji:true},level:2},
  {type:'rich_text',block_id:'d',elements:[
    sectionRich(t('粗体',{bold:true}),t('、'),t('code',{code:true}),t(' 见 '),{type:'link',url:'https://example.test/pr/1',text:'PR #1'},t('\n\n')),
    {type:'rich_text_list',style:'bullet',indent:0,elements:[sectionRich(t('一'))]},
    {type:'rich_text_list',style:'bullet',indent:1,elements:[sectionRich(t('嵌套'))]},
    {type:'rich_text_list',style:'ordered',indent:0,elements:[sectionRich(t('甲')),sectionRich(t('乙'))]},
    {type:'rich_text_quote',elements:[t('引用')]}]},
  {type:'table',block_id:'e',rows:[[cell('项'),cell('结果')],[cell('表格'),cell('正常')]]},
  {type:'rich_text',block_id:'f',elements:[{type:'rich_text_preformatted',language:'python',elements:[t('print(1)')]},sectionRich(t('\n'),t('表情 '),{type:'emoji',name:'doge'},t(' 好～'))]},
  context('stats'),context('Sent by Agent',marker)]};
it('recognizes the rich_text layout Slack stores for a markdown block',()=>{
  expect(agentBody(storedMarkdown)).toBe('结论：\n## 小标题\n**粗体**、`code` 见 [PR #1](https://example.test/pr/1)\n\n- 一\n  - 嵌套\n1. 甲\n2. 乙\n> 引用\n| 项 | 结果 |\n|---|---|\n| 表格 | 正常 |\n```\nprint(1)\n```\n\n表情 :doge: 好～');
  expect(agentBody({...storedMarkdown,blocks:[{type:'markdown',text:'**hi**'},context('Sent by Agent',marker)]})).toBe('**hi**');
  expect(agentBody({...storedMarkdown,blocks:[{type:'rich_text',elements:[{type:'unknown_element'}]},context('Sent by Agent',marker)]})).toBeUndefined();
  expect(agentBody({...storedMarkdown,blocks:[{type:'rich_text',elements:[sectionRich(t('x'))]},context('Sent by Agent')]})).toBeUndefined();
});
