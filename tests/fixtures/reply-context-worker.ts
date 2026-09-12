import {getSlackReplyContext} from '../../src/multica-api.js';

export default {async fetch(request:Request,env:{UPSTREAM:string}):Promise<Response>{
  const mode=new URL(request.url).pathname;
  const result=await getSlackReplyContext({multicaApiBaseUrl:env.UPSTREAM+mode,multicaApiToken:'fixture-token',multicaWorkspaceId:'W1',multicaProjectId:'P1',multicaAgentId:'A1'});
  return Response.json(result);
}};
