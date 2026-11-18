'use strict';
// Reproducible selection of Jina Reader's actual HTML narrowing method.
// Apache-2.0 upstream; see vendor/JINA-LICENSE and THIRD_PARTY.md.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const input = fs.readFileSync(path.join(__dirname, 'vendor/jsdom.upstream.ts'), 'utf8').replace(/\r\n/g,'\n');
const start = input.indexOf('    async actualNarrowSnapshot(');
const end = input.indexOf('\n    @Threaded()\n    async inferSnapshot', start);
if (start < 0 || end < 0) throw Error('UPSTREAM_EXTRACTION_BOUNDARY_CHANGED');
const source = `// Derived from jina-ai/reader, Apache-2.0. See THIRD_PARTY.md.\nconst { Readability } = require('@mozilla/readability');\nclass JinaHtmlExtractor {\nconstructor() { this.linkedom = require('linkedom'); this.logger = {warn() {}}; }\n${input.slice(start, end)}\n}\nmodule.exports = { JinaHtmlExtractor };`;
fs.writeFileSync(path.join(__dirname, 'vendor/jina-html.cjs'), ts.transpileModule(source, { compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS} }).outputText);
