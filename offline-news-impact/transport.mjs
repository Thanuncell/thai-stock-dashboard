// Delegate session refresh to the existing client. Server must reject 401 BEFORE
// admission; provider 401 maps to 502. Thus refresh cannot replay provider work.
export function createImpactTransport(auth){
  return async(payload,signal)=>{
    const identity=auth.captureIdentity();
    const response=await auth.authorizedFetch('/api/news-impact-phase1',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal});
    if(!auth.isCurrentIdentity(identity))throw Object.assign(Error('STALE_SESSION'),{code:'STALE_SESSION'});
    let body;try{body=await response.json();}catch{throw Object.assign(Error('INVALID_RESPONSE'),{code:'INVALID_RESPONSE'});}
    return body;
  };
}
