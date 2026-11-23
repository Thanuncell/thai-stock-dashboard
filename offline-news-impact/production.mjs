import {mountNewsImpact} from './ui.mjs';
import {createImpactTransport} from './transport.mjs';
mountNewsImpact({root:document.querySelector('#news-section'),auth:window.setscopeAuth,send:createImpactTransport(window.setscopeAuth),preview:false});
