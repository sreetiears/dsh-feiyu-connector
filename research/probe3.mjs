// 探针 3：抓关键仓库 README / 文件树，并搜 DSH 生态里已有的 B站/X 插件
import { writeFile, mkdir } from 'node:fs/promises';

const GH = { 'User-Agent': 'probe', Accept: 'application/vnd.github+json' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36';
const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '');

async function json(url, headers = GH) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 200), __status: r.status }; }
}
async function text(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  return r.ok ? r.text() : `ERR ${r.status}`;
}

await mkdir('research/repos', { recursive: true });

const repos = [
  'aureth-labs/dsh-aurabot-qq',
  'whyever77/dafeiyu-astrbot',
  'EDMOK/blue-fish-archive',
  'SAKURAfan1023/dafeiyu-bot',
  'MerZlin/dsh-pet-indesktop',
];

for (const repo of repos) {
  const meta = await json(`https://api.github.com/repos/${repo}`);
  console.log(`\n########## ${repo}  ★${meta.stargazers_count}  ${meta.description ?? ''}`);
  console.log('topics:', (meta.topics ?? []).join(', '));
  const tree = await json(`https://api.github.com/repos/${repo}/git/trees/${meta.default_branch}?recursive=1`);
  const files = (tree.tree ?? []).filter((f) => f.type === 'blob').map((f) => f.path);
  console.log('fileCount:', files.length);
  console.log('files:', files.slice(0, 60).join('\n        '));
  const readme = files.find((f) => /^readme/i.test(f));
  if (readme) {
    const t = await text(`https://raw.githubusercontent.com/${repo}/${meta.default_branch}/${readme}`);
    const safe = repo.replace('/', '__');
    await writeFile(`research/repos/${safe}.README.md`, t, 'utf8');
    console.log(`README(${t.length} chars) saved. head:\n` + t.slice(0, 1800));
  }
}

// 生态里已有的相关插件
const queries = ['dsh bilibili', 'dsh 插件 b站', 'bilibili mcp', 'dsh-plugin x-twitter', 'dsh 大肥鱼 插件'];
for (const q of queries) {
  const g = await json(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10&sort=stars`);
  console.log(`\n=== search "${q}" total=${g?.total_count}`);
  for (const it of g?.items ?? []) console.log(`  ★${it.stargazers_count} ${it.full_name} :: ${String(it.description).slice(0, 120)}`);
}
