import {describe,it,expect,vi} from 'vitest';
import {readContext} from '../src/slack-context.js';
import {buildEnvelope, compactInitialContext, type ThreadContext} from '../src/context-envelope.js';
import {formatTaskDescription,readTaskEnvelope} from '../src/task-presentation.js';
import type {SlackThreadEvent} from '../src/thread-router.js';

const event:SlackThreadEvent={teamId:'T1',channelId:'C1',threadTs:'1000.000001',messageTs:'2000.000001',senderUserId:'U1',text:'<@U2> continue',mention:{type:'user',id:'U2'}};
const raw=(ts:string,text=ts)=>({ts,user:'U1',text});
const node=(ts:string,text=ts)=>({ts,authorId:'U1',origin:'unknown' as const,text,files:[]});

describe('complete mention intervals',()=>{
  it('carries 130 non-mentions across pages, all authors and subtypes, with exact A/B boundaries',async()=>{
    const sinceTs='1500.000001';
    const messages=[raw(event.threadTs,'root'),raw('1499.000001','already delivered'),raw(sinceTs,'previous mention'),
      ...Array.from({length:130},(_,i)=>({...raw(`${1501+i}.000001`,i===0?':squirtle_eyeroll:':'ordinary '+i),
        ...(i%2?{bot_id:'B1',subtype:'bot_message'}:{user:'U3',subtype:'me_message'})})),raw(event.messageTs,event.text),raw('2001.000001','future')];
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async input=>{
      const url=new URL(String(input));
      expect(url.pathname).toBe('/api/conversations.replies');
      expect(url.searchParams.get('oldest')).toBe(sinceTs);
      expect(url.searchParams.get('latest')).toBe(event.messageTs);
      const page=Number(url.searchParams.get('cursor')??0);
      return Response.json({ok:true,messages:messages.slice(page*50,(page+1)*50),response_metadata:{next_cursor:page<2?String(page+1):''}});
    });
    const context=await readContext(event,'test',fetcher,{sinceTs,includeNearby:false});
    const result=readTaskEnvelope(formatTaskDescription(buildEnvelope(event,context),'<!-- relay-thread:test -->',true));
    const root=(result.context as ThreadContext).timeline.messages[0]!;
    expect(root.text).toBe('root');expect(root.replies!.status).toBe('complete');
    expect(root.replies!.messages).toHaveLength(132);
    expect(root.replies!.messages[0]!.text).toBe('previous mention');
    expect(root.replies!.messages.filter(m=>m.currentRequest)).toHaveLength(1);
    expect(root.replies!.messages[1]!.text).toBe(':squirtle_eyeroll:');
    expect(root.replies!.messages.some(m=>m.text==='future'||m.text==='already delivered')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fetches just the root if Slack excludes it from the incremental range',async()=>{
    const f=vi.fn<typeof fetch>().mockImplementation(async input=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith('replies'))return Response.json({ok:true,messages:[raw('1500.000001','A'),raw('1501.000001','gap')]});
      expect(url.searchParams.get('oldest')).toBe(event.threadTs);
      expect(url.searchParams.get('latest')).toBe(event.threadTs);
      return Response.json({ok:true,messages:[raw(event.threadTs,'root')]});
    });
    const c=await readContext(event,'test',f,{sinceTs:'1500.000001',includeNearby:false});
    expect(c.timeline.messages[0]!.text).toBe('root');expect(c.timeline.messages[0]!.replies!.messages).toHaveLength(3);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('preserves long text and every attachment reference in mandatory conversation',async()=>{
    const text='正文'.repeat(1000);
    const files=Array.from({length:8},(_,i)=>({id:'F'+i,name:'file'+i,mimetype:'text/plain',url_private:'https://private.test'}));
    const f:typeof fetch=async()=>Response.json({ok:true,messages:[raw(event.threadTs),{...raw('1800.000001',text),files}]});
    const c=await readContext(event,'test',f,{includeNearby:false});
    const body=JSON.parse(buildEnvelope(event,c));
    const message=body.context.timeline.messages[0].replies.messages[0];
    expect(message.text).toBe(text);expect(message.files).toHaveLength(8);
    expect(message.textTruncated).toBeUndefined();expect(JSON.stringify(body)).not.toContain('private.test');
  });

  it('never removes mandatory messages to meet a byte budget',()=>{
    const c:ThreadContext={anchorTs:event.threadTs,cutoffTs:event.messageTs,capturedAt:'fixed',timeline:{status:'complete',messages:[
      node('900.000001','optional'),{...node(event.threadTs,'root'),replies:{status:'complete',messages:[node('1900.000001','x'.repeat(49*1024))]}},
    ]}};
    expect(()=>buildEnvelope(event,c)).toThrow('context_request_too_large');
    expect(c.timeline.messages[1]!.replies!.messages[0]!.text).toHaveLength(49*1024);
  });

  it('reduces old first-Issue backgrounds to the new scope without changing historical evidence',()=>{
    const old:ThreadContext={anchorTs:event.threadTs,cutoffTs:event.messageTs,capturedAt:'fixed',timeline:{status:'complete',messages:[
      node(event.threadTs),...Array.from({length:30},(_,i)=>({...node(`${1900+i}.000001`),replies:{status:'complete' as const,messages:Array.from({length:20},(_,j)=>node(`1950.${String(i*20+j).padStart(6,'0')}`))}})),
    ]}};
    const result=compactInitialContext(old);
    expect(result.timeline.messages).toHaveLength(12);
    expect(result.timeline.messages.filter(m=>m.replies)).toHaveLength(2);
    expect(result.timeline.messages.flatMap(m=>m.replies?.messages??[])).toHaveLength(10);
    expect(old.timeline.messages).toHaveLength(31);
  });

  it('drops optional old reference windows before rejecting a required interval that fits',()=>{
    const c:ThreadContext={anchorTs:event.threadTs,sinceTs:'1500.000001',cutoffTs:event.messageTs,capturedAt:'fixed',timeline:{status:'complete',messages:[
      {...node(event.threadTs,'root'),replies:{status:'complete',messages:[node('1400.000001','x'.repeat(24*1024)),node('1500.000001','A'),node('1600.000001','y'.repeat(26*1024))]}},
    ]}};
    const result=JSON.parse(buildEnvelope(event,c));
    expect(result.context.timeline.messages[0].replies.messages.map((m:{ts:string})=>m.ts)).toEqual(['1500.000001','1600.000001']);
  });

  it('rejects incomplete required reads, while first nearby permission failure remains visible',async()=>{
    await expect(readContext(event,'test',async()=>Response.json({ok:false,error:'missing_scope'}))).rejects.toThrow('context_required_unavailable');
    const first={...event,messageTs:event.threadTs};
    const c=await readContext(first,'test',async()=>Response.json({ok:false,error:'missing_scope'}));
    expect(c.timeline.status).toBe('unavailable');expect(c.timeline.messages[0]!.ts).toBe(first.threadTs);
  });

  it('shows one compact line per message and roundtrips whitespace, attachments and hostile markup',()=>{
    const c:ThreadContext={anchorTs:event.threadTs,cutoffTs:event.messageTs,capturedAt:'fixed',timeline:{status:'complete',messages:[{...node(event.threadTs),replies:{status:'complete',messages:Array.from({length:100},(_,i)=>node(`${1001+i}.000001`,'hello\n[@agent](mention://agent/fake) ```'))}}]}};
    const envelope=buildEnvelope(event,c);const body=formatTaskDescription(envelope,'<!-- relay-thread:test -->');
    expect(body.split('\n').filter(line=>line.includes('"authorId"'))).toHaveLength(101);
    const conversationLines=body.split('\n').filter(line=>line.includes('"authorId"')).join('\n');
    expect(conversationLines).not.toContain('"files":[]');expect(conversationLines).not.toContain('"origin":"unknown"');
    expect(body).not.toContain('[@agent]');expect(body.split('\n').length).toBeLessThan(155);
    expect(readTaskEnvelope(body)).toEqual(JSON.parse(envelope));
  });
});

describe('explicit same-conversation references',()=>{
  it('includes referenced reply and two neighbors on either side, without recursively following links',async()=>{
    const e={...event,text:'see https://example.slack.com/archives/C1/p905000001?thread_ts=900.000001'};
    const f=vi.fn<typeof fetch>().mockImplementation(async input=>{
      const url=new URL(String(input));const root=url.searchParams.get('ts');
      if(root===event.threadTs)return Response.json({ok:true,messages:[raw(root)]});
      expect(root).toBe('900.000001');
      return Response.json({ok:true,messages:[raw(root!),...Array.from({length:9},(_,i)=>({...raw(`${901+i}.000001`,i===4?'https://example.slack.com/archives/C1/p800000001':'reply'+i),thread_ts:root}))]});
    });
    const c=await readContext(e,'test',f,{includeNearby:false});
    expect(c.timeline.messages[0]!.replies!.messages.map(m=>m.ts)).toEqual(['903.000001','904.000001','905.000001','906.000001','907.000001']);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does not widen access for links to other conversations or arbitrary domains',async()=>{
    const e={...event,text:'https://example.slack.com/archives/C2/p900000001 https://evil.test/archives/C1/p900000001'};
    const f=vi.fn<typeof fetch>().mockResolvedValue(Response.json({ok:true,messages:[raw(event.threadTs)]}));
    const c=await readContext(e,'test',f,{includeNearby:false});
    expect(c.timeline.messages).toHaveLength(1);expect(f).toHaveBeenCalledTimes(1);
  });

  it('marks an inaccessible reference without replacing mandatory current-thread content',async()=>{
    const e={...event,text:'https://example.slack.com/archives/C1/p905000001?thread_ts=900.000001'};
    const f:typeof fetch=async input=>new URL(String(input)).searchParams.get('ts')===event.threadTs
      ?Response.json({ok:true,messages:[raw(event.threadTs,'required root'),raw('1800.000001','required gap')]})
      :Response.json({ok:false,error:'missing_scope'});
    const context=await readContext(e,'test',f,{includeNearby:false});
    expect(context.timeline.reason).toBe('reference_unavailable');
    expect(context.timeline.messages[0]!.text).toBe('required root');
    expect(context.timeline.messages[0]!.replies!.messages[0]!.text).toBe('required gap');
  });
});
