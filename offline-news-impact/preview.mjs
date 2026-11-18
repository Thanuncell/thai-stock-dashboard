import {mountNewsImpact} from './ui.mjs';
import {createImpactTransport} from './transport.mjs';
// Actual auth client delegates to the isolated server's existing auth verifier.
// Offline browser tests mock Supabase transport; no mock session registry here.
mountNewsImpact({root:document.querySelector('#news-section'),auth:window.setscopeAuth,send:createImpactTransport(window.setscopeAuth)});
