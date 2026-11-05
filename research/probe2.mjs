// 探针 2：找"小肥鱼/大肥鱼"人设线索（B站简介/评论、GitHub、Bing、百度）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json, text/plain, */*' };

async function jget(url, headers = H) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 300), __status: r.status }; }
}

const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '');

// 1) B站：几个关键视频的简介 + 热门评论
const bvs = ['BV1Lbn16CEZS', 'BV11Txk6ZETr', 'BV19RnW6LECy', 'BV1ZSnU6REuC', 'BV1YNxz6YEJa'];
for (const bv of bvs) {
  const v = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${bv}`);
  if (v?.code === 0) {
    console.log(`\n=== ${bv} ${v.data.title} | UP=${v.data.owner?.name} | aid=${v.data.aid}`);
    console.log('简介:', strip(v.data.desc).slice(0, 500).replace(/\n+/g, ' / '));
    const rep = await jget(`https://api.bilibili.com/x/v2/reply?type=1&oid=${v.data.aid}&sort=2&ps=8`);
    if (rep?.code === 0 && rep.data?.replies) {
      for (const r of rep.data.replies.slice(0, 6)) {
        console.log(` 评论[${r.like}]:`, strip(r.content?.message).slice(0, 160));
      }
    }
  } else {
    console.log(`\n=== ${bv} FAIL ${JSON.stringify(v).slice(0, 120)}`);
  }
}

// 2) GitHub 仓库搜索
for (const q of ['大肥鱼', '小肥鱼', 'feiyu deepseek qq bot']) {
  const g = await jget(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=8&sort=stars`, {
    'User-Agent': 'probe', Accept: 'application/vnd.github+json',
  });
  console.log(`\n=== GitHub "${q}" total=${g?.total_count}`);
  for (const it of g?.items ?? []) console.log(`  ★${it.stargazers_count} ${it.full_name} :: ${String(it.description).slice(0, 110)}`);
}

// 3) Bing HTML
const bing = await fetch('https://www.bing.com/search?q=' + encodeURIComponent('大肥鱼 人设 提示词 deepseek') + '&setlang=zh-hans&cc=cn', {
  headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
}).then((r) => r.text()).catch((e) => 'ERR ' + e.message);
console.log('\n=== bing len', bing.length);
const bres = [...bing.matchAll(/<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/g)].slice(0, 8);
for (const m of bres) console.log('  -', strip(m[2]).slice(0, 90), '|', m[1].slice(0, 80));

// 4) 百度
const bd = await fetch('https://www.baidu.com/s?wd=' + encodeURIComponent('大肥鱼 人设 提示词'), {
  headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000),
}).then((r) => r.text()).catch((e) => 'ERR ' + e.message);
console.log('\n=== baidu len', bd.length, 'contains 肥鱼:', bd.includes('肥鱼'));
const bdTitles = [...bd.matchAll(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g)].slice(0, 8).map((m) => strip(m[1]).trim());
console.log('baidu titles:', JSON.stringify(bdTitles, null, 1));
