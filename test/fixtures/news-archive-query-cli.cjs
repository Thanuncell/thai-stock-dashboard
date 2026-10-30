'use strict';
// Synthetic CLI transport: never accepts a non-loopback database origin.
const assert=require('node:assert/strict'),nativeFetch=globalThis.fetch,base=new URL(process.env.SETSCOPE_WS7_HTTP_BASE);
assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
globalThis.fetch=(input,init)=>{const url=new URL(input);assert.equal(url.origin,'https://ws7-bootstrap.invalid');assert.ok(url.pathname.startsWith('/rest/v1/'));return nativeFetch(base.origin+url.pathname.slice('/rest/v1'.length)+url.search,init);};
