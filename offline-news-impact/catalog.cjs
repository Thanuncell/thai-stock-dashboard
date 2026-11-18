'use strict';
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function hasIdentityEvidence(identity,evidence,catalog){
  if([identity.name,...(identity.aliases||[]).filter(x=>x!==identity.symbol)].some(x=>x.length>10&&evidence.toLocaleLowerCase().includes(x.toLocaleLowerCase())))return true;
  // PTT in OR/PTTEP/PTTGC's full English company name is not evidence of
  // the parent ticker. Preserve any separate explicit ticker mention outside it.
  for(const other of catalog.items){if(other.symbol===identity.symbol)continue;for(const name of [other.name,...(other.aliases||[])].filter(x=>x.length>10))evidence=evidence.replace(new RegExp(escape(name),'gi'),' ');}
  const ticker=escape(identity.symbol);
  if(identity.symbol.length<=2||['OR','THAI','ADVICE'].includes(identity.symbol))return new RegExp(`(?:หุ้น|หลักทรัพย์|ticker|stock|symbol)\\s*[:：]?\\s*${ticker}($|[^A-Za-z0-9_&.-])`).test(evidence);
  return new RegExp(`(^|[^A-Za-z0-9_&-])${ticker}($|[^A-Za-z0-9_&-])`).test(evidence);
}
module.exports={hasIdentityEvidence};
