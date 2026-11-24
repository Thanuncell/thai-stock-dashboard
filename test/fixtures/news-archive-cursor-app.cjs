'use strict';
// Local application shell only. All data/auth responses are synthetic browser
// fixtures; accidental server-side remote requests fail before reaching network.
process.env.SETSCOPE_TEST_MODE='1';
process.env.SUPABASE_URL='https://isolation-test.supabase.co';
process.env.SUPABASE_ANON_KEY='public-browser-fixture';
process.env.SUPABASE_SECRET_KEY='';process.env.SUPABASE_SERVICE_ROLE_KEY='';
process.env.SETSCOPE_NEWS_ARCHIVE_QUERY='off';process.env.SETSCOPE_NEWS_WORK_QUEUE='off';
globalThis.fetch=async()=>{throw Error('Remote access forbidden in cursor browser fixture');};
require('../../server').server.listen(Number(process.env.PORT),'127.0.0.1');
