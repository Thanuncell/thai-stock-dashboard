'use strict';
// Unit-test fixtures explicitly inject article IO; production uses the pinned transport.
const actual=require('../../server/news-service');
module.exports={...actual,createNewsService(options={}) {
 return actual.createNewsService({...options,articleFetch:options.articleFetch||options.fetchImpl});
}};
