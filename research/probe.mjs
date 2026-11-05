// 一次性探针：验证 B站公开接口可用性 + 搜索"小肥鱼"人设线索
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json, text/plain, */*' };

async function get(url, headers = H) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  return { status: r.status, text };
}

async function bili(label, url) {
  try {
    const { status, text } = await get(url);
    let j;
    try { j = JSON.parse(text); } catch { console.log(`[${label}] status=${status} NON-JSON: ${text.slice(0, 160)}`); return; }
    console.log(`[${label}] status=${status} code=${j.code} msg=${j.message ?? ''}`);
    return j;
  } catch (e) { console.log(`[${label}] ERR ${e.message}`); }
}

const hot = await bili('hot-search', 'https://api.bilibili.com/x/web-interface/search/square?limit=10');
if (hot?.data?.trending?.list) {
  console.log('  热搜:', hot.data.trending.list.map((x) => x.keyword).join(' | '));
}

const rank = await bili('ranking', 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all');
if (rank?.data?.list) {
  for (const v of rank.data.list.slice(0, 5)) console.log(`  #${v.stat.view} ${v.title} -- ${v.owner?.name}`);
}

const pop = await bili('popular', 'https://api.bilibili.com/x/web-interface/popular?ps=5&pn=1');
if (pop?.data?.list) {
  for (const v of pop.data.list.slice(0, 5)) console.log(`  pop ${v.stat?.view} ${v.title} -- ${v.owner?.name}`);
}

for (const kw of ['小肥鱼', '小肥鱼 qq机器人', '小肥鱼 人设']) {
  const s = await bili(`search:${kw}`, `https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=${encodeURIComponent(kw)}`);
  if (s?.data?.result) {
    for (const v of s.data.result.slice(0, 8)) {
      console.log(`  - [${v.author}] ${String(v.title).replace(/<[^>]+>/g, '')} (${v.bvid})`);
    }
  }
}

const d = await get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent('小肥鱼 qq机器人 人设'), {
  'User-Agent': UA, Referer: 'https://duckduckgo.com/',
});
console.log(`[ddg] status=${d.status} len=${d.text.length}`);
const titles = [...d.text.matchAll(/result__a[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 10).map((m) => m[1].replace(/<[^>]+>/g, '').trim());
console.log('ddg titles:', JSON.stringify(titles, null, 1));
