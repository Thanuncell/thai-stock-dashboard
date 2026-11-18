'use strict';
const net = require('node:net');
const { JinaHtmlExtractor } = require('./vendor/jina-html.cjs');
const fail = code => Object.assign(Error(code), {code,confirmedFailure:true});
function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('INVALID_URL'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // Reject local/special names and IP literals; transport also pins public DNS.
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80','443'].includes(url.port)) || net.isIP(host) ||
      !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host) ||
      host.length > 253 || host.endsWith('.') || !/^[a-z0-9.-]+$/.test(host) || /(^|\.)-|-($|\.)|\.\./.test(host)) throw fail('UNSAFE_URL');
  url.hash = '';
  return url.href;
}
function createReader({loadHtml,loadFixture,timeoutMs=5000}) {
  const load=loadHtml||loadFixture;
  if (typeof load !== 'function') throw fail('TRANSPORT_REQUIRED');
  const extractor = new JinaHtmlExtractor();
  return {async read(value) {
    const url = safeUrl(value);
    let timer,response;
    try {response=await Promise.race([load(url),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('READER_TIMEOUT')),timeoutMs);})]);}
    finally{clearTimeout(timer);}
    if (!response || response.status !== 200) throw fail(response?.status === 402 || response?.status === 403 ? 'READER_RESTRICTED' : 'READER_UNAVAILABLE');
    if (typeof response.html !== 'string' || Buffer.byteLength(response.html) > 512_000) throw fail('ARTICLE_TOO_LARGE');
    if (/"isAccessibleForFree"\s*:\s*false|data-paywall\b/i.test(response.html)) throw fail('READER_PAYWALL');
    let parsed;
    try { parsed = (await extractor.actualNarrowSnapshot({html:response.html, href:url}, {readabilityRequired:true})).parsed; }
    catch { throw fail('READER_PARSE'); }
    const text = String(parsed?.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 60) throw fail(/<noscript[^>]*>[^<]*(?:javascript|จาวาสคริปต์)/i.test(response.html)?'READER_JS_REQUIRED':'EMPTY_ARTICLE');
    if (text.length > 20_000) throw fail('ARTICLE_TOO_LARGE');
    return {text,title:String(parsed.title || '').slice(0,300),sourceUrl:url,extractor:'jina-reader-oss-html-subset'};
  }};
}
module.exports = {safeUrl,createReader,fail};
