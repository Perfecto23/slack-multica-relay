import {createServer,type Server} from 'node:http';
import {type AddressInfo} from 'node:net';
import {createTestHarness} from 'wrangler';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';

let upstream:Server;
let worker:ReturnType<typeof createTestHarness>;
const seen:string[]=[];
beforeAll(async()=>{
  upstream=createServer((request,response)=>{
    seen.push(request.url!);
    if(request.url!.startsWith('/redirect/')){
      response.writeHead(302,{location:'/must-not-follow'});response.end();return;
    }
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({id:request.url!.startsWith('/wrong/')?'A2':'A1',workspace_id:'W1',model:'gpt-test',service_tier:'priority'}));
  });
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const port=(upstream.address() as AddressInfo).port;
  const origin=`http://127.0.0.1:${port}`;
  // Wrangler's Node outbound bridge must return the raw 3xx to workerd;
  // otherwise Node follows it before the Worker's redirect policy can apply.
  const transport=globalThis.fetch;
  vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith(origin)
    ?transport(new Request(input,init),{redirect:'manual'}):transport(input,init));
  worker=createTestHarness({workers:[{config:{name:'reply-context-test',main:'tests/fixtures/reply-context-worker.ts',compatibility_date:'2026-09-08',vars:{UPSTREAM:`http://127.0.0.1:${port}`}}}]});
  await worker.listen();
},60_000);
afterAll(async()=>{await worker?.close();vi.restoreAllMocks();await new Promise<void>(resolve=>upstream?.close(()=>resolve()));});
it('fetches and validates Agent configuration inside real workerd',async()=>{
  expect(await(await worker.fetch('/ok')).json()).toMatchObject({status:'available',model:'gpt-test',serviceTier:'priority'});
  expect(seen).toContain('/ok/api/agents/A1');
});
it('rejects redirects without following them',async()=>{
  const result=await(await worker.fetch('/redirect')).json();
  expect(result,JSON.stringify(seen)).toMatchObject({status:'unavailable',model:null});
  expect(seen).toContain('/redirect/api/agents/A1');expect(seen).not.toContain('/must-not-follow');
});
it('still rejects a mismatched Agent inside workerd',async()=>{
  expect(await(await worker.fetch('/wrong')).json()).toMatchObject({status:'unavailable',model:null});
});
