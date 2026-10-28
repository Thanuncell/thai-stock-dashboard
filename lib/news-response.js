'use strict';
async function readBoundedText(response,limit=256000,signal){
 const reader=response.body?.getReader();if(!reader)return String(await response.text()).slice(0,limit);
 const chunks=[];let size=0;
 const abort=()=>reader.cancel().catch(()=>{});signal?.addEventListener('abort',abort,{once:true});
 try{while(size<limit){if(signal?.aborted)throw Error('NEWS_READ_ABORTED');const part=await reader.read();if(part.done)break;const chunk=part.value.slice(0,limit-size);chunks.push(chunk);size+=chunk.length;if(size>=limit)await reader.cancel().catch(()=>{});}if(signal?.aborted)throw Error('NEWS_READ_ABORTED');return new TextDecoder().decode(Buffer.concat(chunks));}
 finally{signal?.removeEventListener('abort',abort);}
}
module.exports={readBoundedText};
