'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {evaluateInvestingArticleOffline:evaluate}=require('../lib/news-investing-article-evidence');
const {reviewNewsItem,reviewNewsForDisplay}=require('../lib/news-quality');
const {newsDisplayBlocked}=require('../lib/news-content');
const {allowedNewsUrl,publisherMatches}=require('../lib/news-policy');
const {createNewsService}=require('../server/news-service');

const date='2026-11-03T03:30:00.000Z';
const url='https://th.investing.com/news/stock-market-news/ptt-market-outlook-123456';
const wrapper='https://news.google.com/rss/articles/synthetic-investing-offline';
const thaiTitle='PTT หนุนหุ้นไทยหลังรายงานผลประกอบการเพิ่มความเชื่อมั่น - Investing.com';
const englishTitle='Thailand stocks rise as PTT earnings support sentiment - Investing.com';
const thaiBody=('ตลาดหุ้นไทยปรับขึ้นหลัง PTT รายงานผลประกอบการและการเติบโตของรายได้ บริษัทเปิดเผยข้อมูลใหม่ด้านแผนลงทุนและกำไร ผู้ลงทุนติดตามแนวโน้มเศรษฐกิจไทยและธนาคารแห่งประเทศไทยอย่างใกล้ชิด ').repeat(3);
const englishBody=('Thailand stocks rose as PTT earnings supported Thai equities. Investors assessed the Thai economy while the Bank of Thailand monitored investment and inflation. ').repeat(3);
const foreignBody=('US stocks rose as technology companies released earnings. American shares rallied while the Federal Reserve discussed inflation and domestic demand in the United States. ').repeat(3);
const rss=(title=thaiTitle)=>({source:'other',sourceName:'Investing.com',title,url:wrapper,pubDate:date,
  snippet:title.replace(/ - Investing\.com$/,'')+' &nbsp;&nbsp; Investing.com'});
function html({title=thaiTitle,articleUrl=url,canonical=articleUrl,structuredUrl=articleUrl,
  heading=title.replace(/ - Investing\.com$/,''),published=date,body=thaiBody,
  structuredType='NewsArticle',articleBody=body,includeCanonical=true,includeStructured=true}={}){
  return '<html><head>'+(includeCanonical?'<link rel="canonical" href="'+canonical+'">':'')
    +(includeStructured?'<script type="application/ld+json">'+JSON.stringify({
      '@context':'https://schema.org','@type':structuredType,url:structuredUrl,
      headline:heading,datePublished:published,articleBody})+'</script>':'')
    +'</head><body><h1>'+heading+'</h1><article><p>'+body+'</p></article></body></html>';
}
function inspect(item=rss(),options={}){return evaluate(item,{articleUrl:options.articleUrl??url,html:html(options)});}
test('Thai article with bound canonical, headline, date and body is content-eligible offline only',()=>{
  const item=rss(),result=inspect(item);
  assert.equal(result.stage,'OFFLINE_ONLY');assert.equal(result.status,'ELIGIBLE');
  assert.equal(result.qualityDecision,'ACCEPT');assert.match(result.excerpt,/ตลาดหุ้นไทย/);
  assert.equal(reviewNewsItem(item).status,'UNVERIFIED');
  assert.equal(newsDisplayBlocked(item),true);
  assert.equal(allowedNewsUrl(url),null);
  assert.equal(publisherMatches({...item,url}),false);
  assert.equal(reviewNewsForDisplay({...item,url}).status,'UNVERIFIED');
});
test('English article with independently verified-shaped body is eligible offline',()=>{
  const item=rss(englishTitle);
  const result=inspect(item,{title:englishTitle,heading:'Thailand stocks rise as PTT earnings support sentiment',body:englishBody});
  assert.equal(result.status,'ELIGIBLE');assert.equal(result.qualityDecision,'ACCEPT');
});
test('headline-only RSS or headline-only article body cannot become eligible',()=>{
  const item=rss();
  assert.equal(reviewNewsItem(item).status,'UNVERIFIED');
  for(const body of ['', 'PTT หนุนหุ้นไทยหลังรายงานผลประกอบการเพิ่มความเชื่อมั่น']){
    const result=inspect(item,{body});
    assert.equal(result.status,'UNVERIFIED');
    assert.equal(result.reason,'ARTICLE_TEXT_INSUFFICIENT');
  }
});
test('foreign article remains blocked even if publisher shape and metadata are valid',()=>{
  const title='US stocks climb after technology earnings - Investing.com',item=rss(title);
  const result=inspect(item,{title,heading:'US stocks climb after technology earnings',body:foreignBody});
  assert.notEqual(result.status,'ELIGIBLE');
  assert.equal(result.qualityDecision,'REJECT');
  assert.equal(result.status,'REJECTED');
});
test('non-article listing, quote, marketing and unsafe domain cannot become publisher articles',()=>{
  const denied=[
    'https://th.investing.com/equities/ptt-pcl',
    'https://www.investing.com/indices/thailand-indices',
    'https://th.investing.com/markets/thailand',
    'https://www.investing.com/brokers/reviews/rewalt/',
    'https://th.investing.com/news',
    'https://th.investing.com/news/stock-market-news/story-123?session=token',
    'https://th.investing.com.evil.example/news/stock-market-news/story-123',
    'https://user@th.investing.com/news/stock-market-news/story-123',
    'http://th.investing.com/news/stock-market-news/story-123',
    'https://fr.investing.com/news/stock-market-news/story-123'
  ];
  for(const articleUrl of denied){
    const result=inspect(rss(),{articleUrl});
    assert.equal(result.status,'REJECTED',articleUrl);
    assert.equal(result.reason,'PUBLISHER_ARTICLE_URL_NOT_ALLOWED',articleUrl);
  }
});
test('canonical mismatch, missing canonical and contradictory structured URL fail closed',()=>{
  const mismatched='https://th.investing.com/news/stock-market-news/other-story-654321';
  assert.equal(inspect(rss(),{canonical:mismatched}).reason,'ARTICLE_CANONICAL_MISMATCH');
  assert.equal(inspect(rss(),{includeCanonical:false}).reason,'ARTICLE_CANONICAL_REQUIRED');
  assert.equal(inspect(rss(),{structuredUrl:mismatched}).reason,'ARTICLE_STRUCTURED_URL_MISMATCH');
  assert.equal(inspect(rss(),{includeStructured:false}).reason,'ARTICLE_STRUCTURED_IDENTITY_UNVERIFIED');
});
test('headline, publisher metadata and article dates must match',()=>{
  assert.equal(inspect(rss(),{heading:'Unrelated headline'}).reason,'ARTICLE_HEADLINE_UNVERIFIED');
  assert.equal(inspect(rss(),{published:'2026-11-02T03:30:00.000Z'}).reason,'ARTICLE_PUBLICATION_DATE_MISMATCH');
  assert.equal(evaluate({...rss(),sourceName:'Other outlet'},{articleUrl:url,html:html()}).reason,'RSS_PUBLISHER_OR_WRAPPER_UNVERIFIED');
  assert.equal(evaluate({...rss(),url:'https://example.com/invalid'},{articleUrl:url,html:html()}).reason,'RSS_PUBLISHER_OR_WRAPPER_UNVERIFIED');
});
test('HTML without reliable articleBody is not accepted from related-story or page text',()=>{
  const item=rss(),related=html({articleBody:'',body:thaiBody});
  const result=evaluate(item,{articleUrl:url,html:related});
  assert.equal(result.status,'UNVERIFIED');
  assert.equal(result.reason,'ARTICLE_TEXT_INSUFFICIENT');
  assert.equal(inspect(item,{body:'verify you are human'}).status,'UNVERIFIED');
});
test('offline adapter returns no display trust and does not mutate original RSS evidence',()=>{
  const item=rss(),before=JSON.stringify(item);
  const result=inspect(item);
  assert.equal(JSON.stringify(item),before);
  assert.equal(item.verification,undefined);
  assert.equal(result.verification,undefined);
  assert.equal(result.displayPolicy,undefined);
  assert.equal(reviewNewsItem(item).status,'UNVERIFIED');
});
test('existing runtime Google RSS publisher remains disabled and does not fetch Investing articles',async()=>{
  let calls=0;
  const service=createNewsService({env:{SETSCOPE_P1_DISPLAY_GATE:'off',SETSCOPE_GOOGLE_NEWS_RPC:'off'},
    fetchImpl:async()=>new Response('<rss><channel><item><title>'+thaiTitle+'</title><link>'+wrapper+'</link><source>Investing.com</source><pubDate>'+date+'</pubDate><description>'+thaiTitle+' &amp;nbsp;&amp;nbsp; Investing.com</description></item></channel></rss>'),
    articleFetch:async()=>{calls++;throw Error('Article IO must remain disabled');}});
  await service.getNews();
  assert.equal(calls,0);
});
