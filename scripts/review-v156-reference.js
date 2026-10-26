'use strict';
const fs = require('node:fs/promises');
const { reviewReferenceChanges } = require('../server/reference-review');
async function main(filename) {
  if (!filename) throw Error('Explicit offline reference proposal required');
  const input = await fs.readFile(filename, 'utf8');
  if (Buffer.byteLength(input) > 1048576) throw Error('Reference proposal too large');
  return reviewReferenceChanges(JSON.parse(input));
}
if (require.main === module) main(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(() => {
  console.error('Reference review stopped: verify the local proposal.'); process.exitCode = 1;
});
module.exports = { main };
