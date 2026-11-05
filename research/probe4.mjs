// 探针 4：多镜像抓取关键文件（raw.githubusercontent 直连不稳，改用 jsdelivr 兜底）
import { writeFile, mkdir } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '');
await mkdir('research/repos', { recursive: true });

async function fetchText(url, ms = 12000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

async function getFile(repo, branch, path) {
  const urls = [
    `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}`,
    `https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
    `https://ghproxy.net/https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
  ];
  for (const u of urls) {
    const t = await fetchText(u);
    if (t && !/^\s*<!DOCTYPE|<html/i.test(t.slice(0, 200))) return { text: t, via: u.split('/')[2] };
  }
  return null;
}

async function json(url, headers = { 'User-Agent': 'probe', Accept: 'application/vnd.github+json' }) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return null; }
  } catch { return null; }
}

const repo = 'aureth-labs/dsh-aurabot-qq';
const meta = await json(`https://api.github.com/repos/${repo}`);
const branch = meta?.default_branch ?? 'main';
console.log(`repo=${repo} branch=${branch} ★${meta?.stargazers_count}`);

const wanted = [
  'personas/dafeiyu.md',
  'README.md',
  'cordis.patch.yml',
  'package.json',
  'docs/USER-MANUAL.md',
  'docs/DESIGN.md',
  'src/bili/api.js',
];
for (const p of wanted) {
  const got = await getFile(repo, branch, p);
  if (!got) { console.log(`\n--- ${p} :: FETCH FAILED`); continue; }
  const safe = p.replace(/\//g, '__');
  await writeFile(`research/repos/aurabot__${safe}`, got.text, 'utf8');
  console.log(`\n--- ${p} via=${got.via} chars=${got.text.length}`);
  console.log(got.text.slice(0, p.endsWith('dafeiyu.md') ? 6000 : 1500));
}

// 找 X/Twitter、B站相关的 DSH 插件
for (const q of ['dsh-plugin bilibili', 'dsh-plugin twitter', 'dsh-plugin x', 'dsh b站 插件', 'dafeiyu dsh plugin']) {
  const g = await json(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=8&sort=stars`);
  console.log(`\n=== search "${q}" total=${g?.total_count}`);
  for (const it of g?.items ?? []) console.log(`  ★${it.stargazers_count} ${it.full_name} :: ${String(it.description).slice(0, 130)}`);
}
