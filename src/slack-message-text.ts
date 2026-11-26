function object(value:unknown):value is Record<string,unknown>{
  return !!value&&typeof value==='object'&&!Array.isArray(value);
}

/** Recognize transient `--progress` status cards so they never self-trigger or pollute context. */
export function isRelayProgressMessage(raw:Record<string,unknown>):boolean {
  const blocks=raw.blocks;
  if(!Array.isArray(blocks)||blocks.length<2||!blocks.every(object))return false;
  const last=blocks.at(-1)!;
  return last.type==='context'&&typeof last.block_id==='string'&&/^relay-progress-[a-f0-9]{64}$/.test(last.block_id);
}

/** Recognize the Relay adapter's complete block layout, never prose keywords. */
export function agentBody(raw:Record<string,unknown>, allowUserToken = false):string|undefined {
  // User-token events can omit app metadata; admission still recognizes our output layout.
  if(!allowUserToken&&!raw.bot_id&&!raw.app_id)return;
  const blocks=raw.blocks;
  if(!Array.isArray(blocks)||blocks.length<2||!blocks.every(object))return;
  const last=blocks.at(-1)!;
  if(last.type!=='context'||typeof last.block_id!=='string'||!/^relay-delivery-[a-f0-9]{64}$/.test(last.block_id))return;
  const split=blocks.findIndex(block=>block.type==='context');
  if(split<1)return;
  const bodyBlocks=blocks.slice(0,split);
  let text:string|undefined;
  if(bodyBlocks.every(block=>block.type==='section')){
    const body:string[]=[];
    for(const section of bodyBlocks){
      if(section.fields!==undefined||section.accessory!==undefined||!object(section.text)||section.text.type!=='mrkdwn'||typeof section.text.text!=='string')return;
      body.push(section.text.text);
    }
    // Our adapter splits a long body into 3000-codepoint chunks. Other multi-section
    // layouts may encode paragraph breaks that concatenation would lose.
    if(body.slice(0,-1).some(text=>Array.from(text).length!==3000))return;
    text=body.join('');
  }else{
    // Slack stores a markdown block as native rich_text, header and table blocks.
    const body:string[]=[];
    for(const block of bodyBlocks){
      const part=markdownPart(block);
      if(part===undefined)return;
      body.push(part);
    }
    text=body.join('\n').replace(/\n{3,}/g,'\n\n');
  }
  for(const context of blocks.slice(split)){
    if(context.type!=='context'||!Array.isArray(context.elements)||context.elements.length!==1)return;
    const element=context.elements[0];
    if(!object(element)||element.type!=='mrkdwn'||typeof element.text!=='string')return;
  }
  return text.trim()?text:undefined;
}

function inline(elements:unknown):string {
  if(!Array.isArray(elements))return '';
  return elements.map(element=>{
    if(!object(element))return '';
    switch(element.type){
      case 'text':{
        const text=typeof element.text==='string'?element.text:'';
        const style=object(element.style)?element.style:{};
        if(style.code)return '`'+text+'`';
        return style.bold?'**'+text+'**':text;
      }
      case 'link':return typeof element.text==='string'&&element.text?`[${element.text}](${String(element.url)})`:String(element.url??'');
      case 'emoji':return `:${String(element.name)}:`;
      case 'user':return `<@${String(element.user_id)}>`;
      case 'usergroup':return `<!subteam^${String(element.usergroup_id)}>`;
      case 'channel':return `<#${String(element.channel_id)}>`;
      case 'broadcast':return `<!${String(element.range)}>`;
      default:return typeof element.text==='string'?element.text:typeof element.fallback==='string'?element.fallback:'';
    }
  }).join('');
}

function richText(block:Record<string,unknown>):string|undefined {
  if(!Array.isArray(block.elements))return;
  const lines:string[]=[];
  for(const element of block.elements){
    if(!object(element))return;
    if(element.type==='rich_text_section')lines.push(inline(element.elements));
    else if(element.type==='rich_text_quote')lines.push(inline(element.elements).split('\n').map(line=>'> '+line).join('\n'));
    else if(element.type==='rich_text_preformatted')lines.push('```\n'+inline(element.elements)+'\n```');
    else if(element.type==='rich_text_list'&&Array.isArray(element.elements)){
      const indent='  '.repeat(typeof element.indent==='number'?element.indent:0);
      lines.push(element.elements.map((item,index)=>indent+(element.style==='ordered'?`${index+1}. `:'- ')+(object(item)?inline(item.elements):'')).join('\n'));
    }else return;
  }
  return lines.join('\n').replace(/\n+$/,'');
}

function markdownPart(block:Record<string,unknown>):string|undefined {
  if(block.type==='markdown')return typeof block.text==='string'?block.text:undefined;
  if(block.type==='rich_text')return richText(block);
  if(block.type==='header')return object(block.text)&&typeof block.text.text==='string'?'#'.repeat(typeof block.level==='number'?block.level:1)+' '+block.text.text:undefined;
  if(block.type==='divider')return '---';
  if(block.type==='table'&&Array.isArray(block.rows)){
    const rows=block.rows.map(row=>Array.isArray(row)?row.map(cell=>object(cell)&&cell.type==='rich_text'?richText(cell)??'':''):[]);
    return rows.map((row,index)=>'| '+row.join(' | ')+' |'+(index===0?'\n|'+row.map(()=>'---').join('|')+'|':'')).join('\n');
  }
}
