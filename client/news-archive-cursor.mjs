/**
 * News Archive cursor history. Account lifetime is owned by the caller.
 * Prepared five-page cursor window. No network, database or provider calls.
 * This helper intentionally does not change the shared Watchlist pageList().
 */
export const ARCHIVE_PAGE_SIZE = 10;
export const ARCHIVE_CURSOR_CACHE_MS = 30_000;

export function cursorScope({source='all',query='',symbol='',excludeUrls=[],featuredCount=5}={}) {
  return JSON.stringify({
    source:[...new Set(String(source||'all').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean))].sort().join(',')||'all',
    query:String(query||'').trim().slice(0,80).toLocaleLowerCase('th'),
    symbol:String(symbol||'').trim().toUpperCase(),
    excludeUrls:[...new Set((Array.isArray(excludeUrls)?excludeUrls:[]).map(x=>String(x||'').trim()).filter(Boolean))].sort(),
    featuredCount:Math.max(0,Math.min(5,Number(featuredCount)||0))
  });
}

export function cursorPageWindow(page) {
  const current=Math.max(1,Math.trunc(Number(page)||1));
  const first=Math.max(1,current-2);
  return {pages:Array.from({length:5},(_,i)=>first+i),leftEllipsis:first>1,rightEllipsis:true};
}

export function createArchiveCursorSession({scope=cursorScope(),now=Date.now,ttlMs=ARCHIVE_CURSOR_CACHE_MS}={}) {
  let activeScope=scope, currentPage=1, requestSequence=0, revision=null, context=null, endPage=null, frontier=null;
  const entries=new Map();
  // Positions contain opaque inbound cursors only; entries cache opened content.
  const positions=new Map([[1,null]]);
  const highestLoaded=()=>Math.max(0,...entries.keys());
  const fresh=entry=>entry && now()-entry.acceptedAt<ttlMs;
  const allowed=page=>Number.isSafeInteger(page)&&page>=1&&positions.has(page)&&(endPage===null||page<=Math.max(1,endPage));
  const window=()=>{
    const target=cursorPageWindow(currentPage),pages=revision===null?[]:target.pages.filter(page=>allowed(page)&&page<= (endPage??Infinity));
    return {pages,leftEllipsis:pages.length>0&&pages[0]>1,rightEllipsis:pages.length>0&&(endPage===null||pages.at(-1)<endPage)};
  };
  const clear=()=>{entries.clear();positions.clear();positions.set(1,null);revision=null;context=null;endPage=null;frontier=null;};
  const token=value=>typeof value==='string'&&value.length>0&&value.length<=512;
  const publicEntry=page=>{
    const e=entries.get(page);
    return e?{items:e.items,featured:e.featured,hasNext:e.hasNext,data:e.data,acceptedAt:e.acceptedAt,stale:!fresh(e)}:null;
  };
  const invalidateFrom=page=>{for(const key of entries.keys())if(key>=page)entries.delete(key);};
  return {
    get scope(){return activeScope;},
    get page(){return currentPage;},
    get highestLoaded(){return highestLoaded();},
    get current(){return publicEntry(currentPage);},
    get revision(){return revision;},
    get window(){return window();},
    canOpen:allowed,
    visibleButtons(){return window().pages.map(page=>({page,active:page===currentPage,disabled:false}));},
    setScope(nextScope){
      if(nextScope===activeScope)return false;
      activeScope=nextScope;currentPage=1;clear();requestSequence++;
      return true;
    },
    open(page){
      if(!allowed(page))return false;
      if(page!==currentPage){currentPage=page;requestSequence++;}
      return true;
    },
    begin({refresh=false}={}){
      const page=currentPage;
      if(!allowed(page))throw Error('ARCHIVE_CURSOR_PAGE_NOT_REACHABLE');
      if(!refresh&&fresh(entries.get(page)))return {cached:true,page,scope:activeScope,revision,entry:publicEntry(page)};
      const cursor=positions.get(page);
      if(page>1&&!cursor)throw Error('ARCHIVE_CURSOR_MISSING');
      const last=cursorPageWindow(page).pages.at(-1);
      const lookahead=revision===null||refresh&&page===1?{startPage:1,cursor:null,pageCount:5}:
        endPage===null&&frontier&&last>=frontier.page?{startPage:frontier.page,cursor:frontier.cursor,pageCount:Math.min(5,last-frontier.page+1)}:null;
      const requestId=++requestSequence;
      return {cached:false,requestId,scope:activeScope,revision,context,page,cursor,pageSize:ARCHIVE_PAGE_SIZE,refresh,lookahead};
    },
    accept(request,response){
      if(!request||request.cached||request.requestId!==requestSequence||request.scope!==activeScope||request.page!==currentPage)return false;
      if(!response||!Array.isArray(response.items)||response.items.length>ARCHIVE_PAGE_SIZE||typeof response.hasNext!=='boolean')throw Error('ARCHIVE_CURSOR_RESPONSE_INVALID');
      if(response.scope!==activeScope||typeof response.revision!=='string'||!response.revision||response.revision.length>128)throw Error('ARCHIVE_CURSOR_CONTEXT_INVALID');
      if(response.context!==undefined&&(typeof response.context!=='string'||!response.context.length||response.context.length>2048))throw Error('ARCHIVE_CURSOR_CONTEXT_INVALID');
      const changed=revision!==null&&response.revision!==revision;
      if(changed&&currentPage!==1)throw Error('ARCHIVE_CURSOR_REVISION_CHANGED');
      if(response.hasNext&&!token(response.nextCursor))throw Error('ARCHIVE_CURSOR_RESPONSE_INVALID');
      if(response.hasNext&&(response.items.length!==ARCHIVE_PAGE_SIZE||response.nextCursor===request.cursor))throw Error('ARCHIVE_CURSOR_RESPONSE_INVALID');
      if(!response.hasNext&&response.nextCursor!=null)throw Error('ARCHIVE_CURSOR_RESPONSE_INVALID');
      if(currentPage>1&&!response.items.length)throw Error('ARCHIVE_CURSOR_RESPONSE_INVALID');
      if(response.featured!==undefined&&(!Array.isArray(response.featured)||response.featured.length>5))throw Error('ARCHIVE_CURSOR_RESPONSE_INVALID');
      // Validate the whole response before replacing any accepted view/history.
      const lookahead=changed?{startPage:1,cursor:null,pageCount:5}:request.lookahead;
      const metadata=response.window;
      if(lookahead){
        if(!metadata||Object.keys(metadata).sort().join(',')!=='hasMore,nextCursor,pages'||!Array.isArray(metadata.pages)||metadata.pages.length>lookahead.pageCount||typeof metadata.hasMore!=='boolean')throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
        if(metadata.hasMore&&(metadata.pages.length!==lookahead.pageCount||!token(metadata.nextCursor)))throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
        if(!metadata.hasMore&&metadata.nextCursor!==null)throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
        const tokens=new Set();
        for(const [index,position]of metadata.pages.entries()){
          if(!position||Object.keys(position).sort().join(',')!=='cursor,page'||position.page!==lookahead.startPage+index||(position.page===1?position.cursor!==null:!token(position.cursor))||tokens.has(position.cursor))throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
          if(index===0&&position.cursor!==lookahead.cursor)throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
          if(!changed&&positions.has(position.page)&&positions.get(position.page)!==position.cursor)throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
          if(!changed&&[...positions].some(([page,cursor])=>page!==position.page&&cursor===position.cursor))throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
          tokens.add(position.cursor);
        }
        if(metadata.hasMore&&tokens.has(metadata.nextCursor))throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
        if(!metadata.pages.length&&(lookahead.startPage!==1||response.items.length))throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
      }else if(metadata!==undefined)throw Error('ARCHIVE_CURSOR_WINDOW_UNREQUESTED');
      const nextPosition=metadata?.pages.find(x=>x.page===currentPage+1)?.cursor??(!changed?positions.get(currentPage+1):undefined);
      if(response.hasNext&&nextPosition!==undefined&&response.nextCursor!==nextPosition)throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
      if(!response.hasNext&&metadata?.pages.some(x=>x.page>currentPage))throw Error('ARCHIVE_CURSOR_WINDOW_INVALID');
      const old=entries.get(currentPage);
      if(!changed&&old&&(old.hasNext!==response.hasNext||old.nextCursor!==(response.hasNext?response.nextCursor:null)))throw Error('ARCHIVE_CURSOR_REVISION_CHANGED');
      if(changed)clear();
      revision=response.revision;
      context=response.context??context;
      if(metadata){
        for(const position of metadata.pages)positions.set(position.page,position.cursor);
        const last=metadata.pages.at(-1)?.page??0;
        if(!metadata.hasMore)frontier=null;
        else if(endPage===null&&(!frontier||last+1>=frontier.page))frontier={page:last+1,cursor:metadata.nextCursor};
        if(!metadata.hasMore)endPage=last;
      }
      if(response.hasNext)positions.set(currentPage+1,response.nextCursor);
      else{
        endPage=response.items.length?currentPage:0;frontier=null;
        invalidateFrom(currentPage+1);
        for(const page of positions.keys())if(page>currentPage)positions.delete(page);
      }
      const cursorIn=request.cursor??null;
      const featured=response.featured??entries.get(1)?.featured??old?.featured??[];
      entries.set(currentPage,{cursorIn,data:{...response,featured},items:response.items,featured,hasNext:response.hasNext,nextCursor:response.hasNext?response.nextCursor:null,acceptedAt:now()});
      return true;
    },
    fail(request){return Boolean(request&&!request.cached&&request.requestId===requestSequence&&request.scope===activeScope&&request.page===currentPage);},
    invalidateCurrent(){
      // Do not silently change the user's requested page during a scoped refresh.
      requestSequence++;
      const entry=entries.get(currentPage);
      if(entry)entry.acceptedAt=-Infinity;
    },
    invalidateCache(){
      // Display-policy exclusions can arrive from the existing News pipeline.
      // Keep navigation positions, but revalidate responses before any revisit.
      for(const entry of entries.values())entry.acceptedAt=-Infinity;
    },
    resetToFirst(){currentPage=1;clear();requestSequence++;},
    navigateNext(){return allowed(currentPage+1)&&this.open(currentPage+1);},
    navigatePrevious(){return currentPage>1&&this.open(currentPage-1);}
  };
}
