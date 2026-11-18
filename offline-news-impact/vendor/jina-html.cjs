// Derived from jina-ai/reader, Apache-2.0. See THIRD_PARTY.md.
const { Readability } = require('@mozilla/readability');
class JinaHtmlExtractor {
    constructor() { this.linkedom = require('linkedom'); this.logger = { warn() { } }; }
    async actualNarrowSnapshot(snapshot, options) {
        const t0 = Date.now();
        let sourceHTML = snapshot.html;
        if (options?.withShadowDom && snapshot.shadowExpanded) {
            sourceHTML = snapshot.shadowExpanded;
        }
        let jsdom = this.linkedom.parseHTML(sourceHTML);
        if (!jsdom.window.document.documentElement) {
            jsdom = this.linkedom.parseHTML(`<html><body>${sourceHTML}</body></html>`);
        }
        const allNodes = [];
        jsdom.window.document.querySelectorAll('svg').forEach((x) => x.innerHTML = '');
        if (options?.withIframe) {
            jsdom.window.document.querySelectorAll('iframe[src],frame[src]').forEach((x) => {
                const origSrc = x.getAttribute('src');
                if (!origSrc) {
                    return;
                }
                const src = new URL(origSrc, snapshot.rebase || snapshot.href).toString();
                const thisSnapshot = snapshot.childFrames?.find((f) => f.href === src);
                if (options?.withIframe === 'quoted') {
                    const blockquoteElem = jsdom.window.document.createElement('blockquote');
                    const preElem = jsdom.window.document.createElement('pre');
                    preElem.innerHTML = thisSnapshot?.text || '';
                    blockquoteElem.appendChild(preElem);
                    x.replaceWith(blockquoteElem);
                }
                else if (thisSnapshot?.html) {
                    x.innerHTML = thisSnapshot.html;
                    x.querySelectorAll('script, style').forEach((s) => s.remove());
                    if (src) {
                        x.querySelectorAll('[src]').forEach((el) => {
                            const imgSrc = el.getAttribute('src');
                            if (URL.canParse(imgSrc, src)) {
                                el.setAttribute('src', new URL(imgSrc, src).toString());
                            }
                        });
                        x.querySelectorAll('[href]').forEach((el) => {
                            const linkHref = el.getAttribute('href');
                            if (URL.canParse(linkHref, src)) {
                                el.setAttribute('href', new URL(linkHref, src).toString());
                            }
                        });
                    }
                }
            });
        }
        if (Array.isArray(options?.removeSelector)) {
            for (const rl of options.removeSelector) {
                jsdom.window.document.querySelectorAll(rl).forEach((x) => x.remove());
            }
        }
        else if (options?.removeSelector) {
            jsdom.window.document.querySelectorAll(options.removeSelector).forEach((x) => x.remove());
        }
        let bewareTargetContentDoesNotExist = false;
        if (Array.isArray(options?.targetSelector)) {
            bewareTargetContentDoesNotExist = true;
            for (const x of options.targetSelector.map((x) => jsdom.window.document.querySelectorAll(x))) {
                x.forEach((el) => {
                    if (!allNodes.includes(el)) {
                        allNodes.push(el);
                    }
                });
            }
        }
        else if (options?.targetSelector) {
            bewareTargetContentDoesNotExist = true;
            jsdom.window.document.querySelectorAll(options.targetSelector).forEach((el) => {
                if (!allNodes.includes(el)) {
                    allNodes.push(el);
                }
            });
        }
        else {
            allNodes.push(jsdom.window.document);
        }
        if (!allNodes.length) {
            if (bewareTargetContentDoesNotExist) {
                return undefined;
            }
            return snapshot;
        }
        const textNodes = [];
        let rootDoc;
        let bewareHeadHtmlUnexpectedlyPreserved = false;
        if (allNodes.length === 1 && allNodes[0].nodeName === '#document' && allNodes[0].documentElement) {
            rootDoc = allNodes[0];
            if (rootDoc.body?.innerText) {
                textNodes.push(rootDoc.body);
            }
        }
        else {
            rootDoc = this.linkedom.parseHTML('<html><body></body></html>').window.document;
            rootDoc.head.innerHTML = jsdom.window.document.head?.innerHTML || '';
            bewareHeadHtmlUnexpectedlyPreserved = true;
            for (const n of allNodes) {
                rootDoc.body.appendChild(n);
                rootDoc.body.appendChild(rootDoc.createTextNode('\n\n'));
                if (n.innerText) {
                    textNodes.push(n);
                }
            }
        }
        const metadata = {};
        const lang = rootDoc.documentElement.getAttribute('lang');
        if (lang) {
            metadata.lang = lang;
        }
        rootDoc.head?.querySelectorAll('meta[content]').forEach((el) => {
            const name = el.getAttribute('name') || el.getAttribute('property');
            if (!name) {
                return;
            }
            const val = el.getAttribute('content') || '';
            const curVal = Reflect.get(metadata, name);
            if (Array.isArray(curVal)) {
                curVal.push(val);
            }
            else if (curVal) {
                Reflect.set(metadata, name, [curVal, val]);
            }
            else {
                Reflect.set(metadata, name, val);
            }
        });
        const baseURI = snapshot.rebase || snapshot.href;
        const external = {};
        rootDoc.head?.querySelectorAll('link[rel][href]').forEach((el) => {
            const attributes = {};
            el.getAttributeNames().forEach((attrName) => {
                attributes[attrName] = el.getAttribute(attrName) || '';
            });
            const rels = attributes['rel']?.split(/\s+/g).filter(Boolean) || [];
            if (!rels?.length) {
                return;
            }
            let href = attributes['href'] || '';
            if (href) {
                try {
                    href = new URL(href, baseURI).href;
                }
                catch (err) {
                    // void 0;
                }
            }
            delete attributes.rel;
            delete attributes.href;
            for (const rel of rels) {
                external[rel] ??= {};
                external[rel][href] ??= {};
                Object.assign(external[rel][href], attributes);
            }
        });
        delete external['stylesheet'];
        delete external['shortcut'];
        const textChunks = textNodes.map((x) => {
            const clone = x.cloneNode(true);
            clone.querySelectorAll('script,style,link,svg').forEach((s) => s.remove());
            return clone.innerText;
        });
        let parsed = snapshot.parsed;
        if (options?.readabilityRequired && (!parsed || options?.targetSelector)) {
            try {
                parsed = new Readability(rootDoc.cloneNode(true)).parse();
            }
            catch (err) {
                this.logger.warn(`Failed to parse selected element`, { err });
            }
        }
        const imgSet = new Set();
        const rebuiltImgs = [];
        Array.from(rootDoc.querySelectorAll('img[src],img[data-src]'))
            .map((x) => [x.getAttribute('src'), x.getAttribute('data-src'), x.getAttribute('alt')])
            .forEach(([u1, u2, alt]) => {
            let absUrl;
            if (u1) {
                try {
                    const u1Txt = new URL(u1, snapshot.rebase || snapshot.href).toString();
                    imgSet.add(u1Txt);
                    absUrl = u1Txt;
                }
                catch (err) {
                    // void 0;
                }
            }
            if (u2) {
                try {
                    const u2Txt = new URL(u2, snapshot.rebase || snapshot.href).toString();
                    imgSet.add(u2Txt);
                    absUrl = u2Txt;
                }
                catch (err) {
                    // void 0;
                }
            }
            if (absUrl) {
                rebuiltImgs.push({
                    src: absUrl,
                    alt
                });
            }
        });
        const r = {
            ...snapshot,
            title: snapshot.title || jsdom.window.document.title,
            description: snapshot.description ||
                (jsdom.window.document.head?.querySelector('meta[name$="description"][content],meta[property$="description"][content]')?.getAttribute('content') ?? ''),
            parsed,
            html: rootDoc.documentElement.outerHTML,
            text: textChunks.join('\n'),
            imgs: (snapshot.imgs || rebuiltImgs)?.filter((x) => imgSet.has(x.src)) || [],
            metadata,
            external,
        };
        if (bewareHeadHtmlUnexpectedlyPreserved) {
            rootDoc.head.innerHTML = '';
            r.html = rootDoc.documentElement.outerHTML;
        }
        const dt = Date.now() - t0;
        if (dt > 1000) {
            this.logger.warn(`Performance issue: Narrowing snapshot took ${dt}ms`, { url: snapshot.href, dt });
        }
        return r;
    }
}
module.exports = { JinaHtmlExtractor };
