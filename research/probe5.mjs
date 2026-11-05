// 探针 5：抓取候选插件的 README，落到 research/repos/ 供本地检索
import { writeFile, mkdir } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
await mkdir('research/repos', { recursive: true });

async function fetchText(url, ms = 12000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

async function repoMeta(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: { 'User-Agent': 'probe', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return null;
  return r.json();
}

async function getFile(repo, path) {
  for (const b of ['main', 'master']) {
    for (const u of [`https://cdn.jsdelivr.net/gh/${repo}@${b}/${path}`, `https://raw.githubusercontent.com/${repo}/${b}/${path}`]) {
      const t = await fetchText(u);
      if (t && !/<html/i.test(t.slice(0, 100))) return t;
    }
  }
  return null;
}

const repos = [
  ['whiteguo233/OpenBiliClaw', ['README.md', 'docs/INSTALL.md']],
  ['c1overzz/dsh-bili-scroll', ['README.md']],
  ['huaizhuanghub/dsh-persona-dafeiyu', ['README.md']],
  ['GooDAnDReaDY/dsh-grok-xsearch', ['README.md']],
  ['InariNGT-Ofiicial/dsh-bili-humanism', ['README.md']],
  ['minedalang/dsh-dafeiyu-life', ['README.md']],
  ['luckui/dsh-livestream', ['README.md']],
];

for (const [repo, files] of repos) {
  const meta = await repoMeta(repo);
  const safe = repo.replace('/', '__');
  console.log(`\n########## ${repo} ★${meta?.stargazers_count} :: ${String(meta?.description ?? '').slice(0, 140)}`);
  console.log('topics:', (meta?.topics ?? []).join(', '));
  for (const f of files) {
    const t = await getFile(repo, f);
    if (!t) { console.log(`  [${f}] FAILED`); continue; }
    await writeFile(`research/repos/${safe}__${f.replace(/\//g, '__')}`, t, 'utf8');
    console.log(`  [${f}] ${t.length} chars`);
  }
}
