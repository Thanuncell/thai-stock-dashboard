'use strict';
const fs=require('node:fs');
const {prepareCompanyNameImport}=require('../server/search-company-names');
// Writes reviewable local SQL only. Applying either SQL file requires separate operator approval.
if(process.argv.length!==5)throw Error('Usage: node scripts/prepare-search-company-names.js registry.json reviewed-names.json output-prefix');
const [, ,registryFile,namesFile,prefix]=process.argv;
const plan=prepareCompanyNameImport({registry:JSON.parse(fs.readFileSync(registryFile,'utf8')),records:JSON.parse(fs.readFileSync(namesFile,'utf8'))});
for(const [suffix,content]of [['.sql',plan.sql],['.rollback.sql',plan.rollbackSql]])fs.writeFileSync(prefix+suffix,content,{flag:'wx'});
console.log(JSON.stringify({prepared:plan.changes.length,applied:0}));
