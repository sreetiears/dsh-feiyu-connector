#!/usr/bin/env node
/**
 * tools/check-bundle.mjs
 * feiyu-connector 静态检查（零依赖）。
 *
 * 依据：docs/spec-feiyu-connector.md §2（目录）、§3（package.json）、§4（cordis.patch.yml）、
 *       §5（lib/bili.js 内部要求）、§6（index.js 注册与静态检查项）、§7（验证交付）。
 * 用法：node tools/check-bundle.mjs [--json]
 *   --json  : 只输出一份 JSON 结果（供验证报告生成用）
 * 退出码：0 = 无 FAIL（SKIP 不算失败）；1 = 有 FAIL，或 feiyu-connector 尚未就绪。
 *
 * 约束：只读，不修改 feiyu-connector/，不写任何文件；YAML 用内置迷你解析器（不装依赖）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const JSON_MODE = process.argv.includes('--json')
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIR = join(ROOT, 'feiyu-connector')

const results = []
const clip = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const record = (id, status, detail = '') => results.push({ id, status, detail: clip(detail) })
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const pass = (id, d = '') => record(id, 'PASS', d)
const fail = (id, e) => record(id, 'FAIL', e?.message ?? e)
const skip = (id, d = '') => record(id, 'SKIP', d)
const check = (id, fn) => {
  try {
    const d = fn()
    if (d && typeof d === 'object' && d.skip) record(id, 'SKIP', d.detail)
    else pass(id, d ?? '')
  } catch (e) {
    fail(id, e)
  }
}
const read = (rel) => {
  try {
    return readFileSync(join(DIR, rel), 'utf8')
  } catch {
    return null
  }
}

/** 从 fromIndex 之后第一个 `{` 开始，返回大括号配平的切片（用于切 output 段）。 */
function sliceBraced(src, fromIndex) {
  const start = src.indexOf('{', fromIndex)
  if (start < 0) return null
  let depth = 0
  for (let k = start; k < src.length; k++) {
    const ch = src[k]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, k + 1)
    }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 迷你 YAML 解析器：只覆盖 spec §4 用到的子集
 *   - 块状 map / seq、行内 map 项（"- id: x"）、缩进式 seq、空 {} / []
 *   - 字面量块标量 | |- |+ / > >- >+
 *   - 引号标量、注释、文档分隔符 --- / ...
 * 够用即可；解析失败会以 FAIL 暴露，不会崩栈。
 * ------------------------------------------------------------------ */
function parseYaml(text) {
  const lines = String(text).split(/\r?\n/).map((raw, idx) => {
    const indent = (raw.match(/^ */) || [''])[0].length
    return { raw, idx, indent, text: raw.slice(indent) }
  })
  let i = 0
  const isIgnorable = (ln) =>
    ln.text.trim() === '' || ln.text.trimStart().startsWith('#') || ln.text.trim() === '---' || ln.text.trim() === '...'

  function skip() {
    while (i < lines.length && isIgnorable(lines[i])) i++
  }

  function stripComment(s) {
    let q = null
    for (let k = 0; k < s.length; k++) {
      const c = s[k]
      if (q) {
        if (c === '\\' && q === '"') {
          k++
          continue
        }
        if (c === q) q = null
      } else if (c === '"' || c === "'") q = c
      else if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd()
    }
    return s.trimEnd()
  }

  function scalar(v) {
    v = String(v).trim()
    if (v === '') return null
    if (v === '{}') return {}
    if (v === '[]') return []
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null' || v === '~') return null
    if (/^-?\d+$/.test(v)) return Number(v)
    if (/^-?\d*\.\d+$/.test(v)) return Number(v)
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      const inner = v.slice(1, -1)
      return v[0] === '"' ? inner.replace(/\\n/g, '\n').replace(/\\"/g, '"') : inner.replace(/''/g, "'")
    }
    if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
      try {
        return JSON.parse(v.replace(/'/g, '"'))
      } catch {
        return v
      }
    }
    return v
  }

  function blockScalar(parentIndent, style) {
    const collected = []
    let minIndent = Infinity
    while (i < lines.length) {
      const ln = lines[i]
      if (ln.text.trim() === '') {
        collected.push({ blank: true, raw: '' })
        i++
        continue
      }
      if (ln.indent <= parentIndent) break
      minIndent = Math.min(minIndent, ln.indent)
      collected.push({ blank: false, raw: ln.raw })
      i++
    }
    while (collected.length && collected[collected.length - 1].blank) collected.pop()
    const body = collected
      .map((c) => (c.blank ? '' : c.raw.slice(minIndent === Infinity ? 0 : minIndent)))
      .join('\n')
    if (style.startsWith('>')) return body.split('\n').join(' ').trim()
    return body
  }

  function parseSeq(ind) {
    const arr = []
    for (;;) {
      skip()
      if (i >= lines.length) break
      const ln = lines[i]
      if (ln.indent !== ind) break
      const isItem = ln.text.startsWith('- ') || ln.text.trim() === '-'
      if (!isItem) break
      const body = ln.text.trim() === '-' ? '' : ln.text.slice(2).trim()
      i++
      if (body === '') arr.push(parseNode(ind + 1))
      else if (/^[^:]+:(\s|$)/.test(body) && !/^['"]/.test(body)) arr.push(parseInlineMap(body, ind))
      else arr.push(scalar(body))
    }
    return arr
  }

  function parseInlineMap(firstBody, seqIndent) {
    const mapIndent = seqIndent + 2
    const obj = {}
    let body = firstBody
    for (;;) {
      const m = /^([^:]+):(.*)$/.exec(body)
      if (!m) throw new Error(`YAML 无法解析的行：${body}`)
      const key = m[1].trim().replace(/^['"]|['"]$/g, '')
      const tail = stripComment(m[2]).trim()
      if (/^[|>][+-]?$/.test(tail)) {
        obj[key] = blockScalar(seqIndent, tail)
      } else if (tail === '') {
        skip()
        if (i < lines.length && lines[i].indent > mapIndent) obj[key] = parseNode(lines[i].indent)
        else if (i < lines.length && lines[i].indent === mapIndent && (lines[i].text.startsWith('- ') || lines[i].text.trim() === '-')) obj[key] = parseSeq(mapIndent)
        else obj[key] = null
      } else obj[key] = scalar(tail)
      skip()
      if (i >= lines.length) break
      const ln = lines[i]
      if (ln.indent !== mapIndent) break
      if (ln.text.startsWith('- ') || ln.text.trim() === '-') break
      body = ln.text
      i++
    }
    return obj
  }

  function parseMap(ind) {
    const obj = {}
    for (;;) {
      skip()
      if (i >= lines.length) break
      const ln = lines[i]
      if (ln.indent !== ind) break
      if (ln.text.startsWith('- ') || ln.text.trim() === '-') break
      const m = /^([^:]+):(.*)$/.exec(ln.text)
      if (!m) throw new Error(`YAML 第 ${ln.idx + 1} 行无法解析：${clip(ln.text, 80)}`)
      const key = m[1].trim().replace(/^['"]|['"]$/g, '')
      const tail = stripComment(m[2]).trim()
      i++
      if (/^[|>][+-]?$/.test(tail)) {
        obj[key] = blockScalar(ind, tail)
      } else if (tail === '') {
        skip()
        if (i < lines.length && lines[i].indent > ind) obj[key] = parseNode(lines[i].indent)
        else if (i < lines.length && lines[i].indent === ind && (lines[i].text.startsWith('- ') || lines[i].text.trim() === '-')) obj[key] = parseSeq(ind)
        else obj[key] = null
      } else obj[key] = scalar(tail)
    }
    return obj
  }

  function parseNode(indent) {
    skip()
    if (i >= lines.length) return null
    const ln = lines[i]
    if (ln.indent < indent) return null
    const ind = ln.indent
    if (ln.text.startsWith('- ') || ln.text.trim() === '-') return parseSeq(ind)
    return parseMap(ind)
  }

  skip()
  if (i >= lines.length) return null
  return parseNode(lines[i].indent)
}

/* ------------------------------------------------------------------ *
 * 输出 / 未就绪
 * ------------------------------------------------------------------ */
function emit() {
  const p = results.filter((r) => r.status === 'PASS').length
  const f = results.filter((r) => r.status === 'FAIL').length
  const s = results.filter((r) => r.status === 'SKIP').length
  const ok = f === 0
  if (JSON_MODE) {
    console.log(JSON.stringify({ ok, bundleDir: DIR, pass: p, fail: f, skip: s, results }, null, 2))
  } else {
    console.log(`feiyu-connector 静态检查：${DIR}`)
    for (const r of results) console.log(`[${r.status}] ${r.id.padEnd(22)} ${r.detail}`)
    console.log('')
    console.log(`PASS ${p} / FAIL ${f} / SKIP ${s}`)
    console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`)
  }
  process.exitCode = ok ? 0 : 1
}

function notReady(reason) {
  record('bundle-dir', 'SKIP', reason)
  if (JSON_MODE) {
    console.log(JSON.stringify({ ok: false, ready: false, reason, bundleDir: DIR, pass: 0, fail: 0, skip: 1, results }, null, 2))
  } else {
    console.log(`[SKIP] bundle-dir             ${reason}`)
    console.log('')
    console.log('PASS 0 / FAIL 0 / SKIP 1')
    console.log('RESULT: NOT_READY（feiyu-connector 尚未就绪）')
    console.log('')
    console.log(`feiyu-connector 尚未就绪：待构建方产出 ${DIR} 后重新运行本脚本。`)
  }
  process.exit(1)
}

if (!existsSync(DIR)) notReady('缺少 feiyu-connector/ 目录')

/* ------------------------------------------------------------------ *
 * §2 目录结构
 * ------------------------------------------------------------------ */
pass('bundle-dir', DIR)

const REQUIRED_FILES = [
  'package.json',
  'cordis.patch.yml',
  'index.js',
  'lib/bili.js',
  'locale/zh.json',
  'locale/en.json',
  'icon.svg',
  'README.md',
]
const missingFiles = REQUIRED_FILES.filter((f) => !existsSync(join(DIR, f)))
check('bundle-files', () => {
  assert(missingFiles.length === 0, `缺少：${missingFiles.join(', ')}`)
  return `${REQUIRED_FILES.length} 个必备文件齐全`
})

/* ------------------------------------------------------------------ *
 * §3 package.json
 * ------------------------------------------------------------------ */
let pkg = null
const pkgRaw = read('package.json')
if (!pkgRaw) skip('pkg-parse', '缺少 package.json')
else {
  try {
    pkg = JSON.parse(pkgRaw)
    pass('pkg-parse', 'JSON 合法')
  } catch (e) {
    fail('pkg-parse', `JSON 解析失败：${e.message}`)
  }
}

function pkgCheck(id, fn) {
  if (!pkg) return skip(id, 'package.json 不可用')
  check(id, fn)
}

pkgCheck('pkg-name', () => {
  assert(pkg.name === '@local/feiyu-connector', `name = ${clip(pkg.name)}，期望 @local/feiyu-connector`)
  return pkg.name
})
pkgCheck('pkg-version', () => {
  assert(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), `version 非法：${clip(pkg.version)}`)
  return `version ${pkg.version}`
})
pkgCheck('pkg-type', () => {
  assert(pkg.type === 'module', `type = ${clip(pkg.type)}，期望 module`)
  return 'type=module'
})
pkgCheck('pkg-private', () => {
  assert(pkg.private === true, `private = ${clip(pkg.private)}，期望 true`)
  return 'private=true'
})
pkgCheck('pkg-exports', () => {
  const ex = pkg.exports ?? {}
  const want = { '.': './index.js', './locale/*.json': './locale/*.json', './icon': './icon.svg' }
  for (const [k, v] of Object.entries(want)) assert(ex[k] === v, `exports["${k}"] = ${clip(ex[k])}，期望 ${v}`)
  return 'exports . / ./locale/*.json / ./icon 正确'
})
pkgCheck('pkg-files', () => {
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const want = ['index.js', 'lib', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md']
  const miss = want.filter((w) => !files.includes(w))
  assert(miss.length === 0, `files 缺：${miss.join(', ')}`)
  return `files 覆盖 ${want.length} 项`
})
pkgCheck('pkg-bundle-patch', () => {
  assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', `dsh.bundle.patch = ${clip(pkg.dsh?.bundle?.patch)}，期望 ./cordis.patch.yml`)
  return 'dsh.bundle.patch=./cordis.patch.yml'
})
pkgCheck('pkg-engines', () => {
  const node = String(pkg.engines?.node ?? '')
  assert(/22/.test(node), `engines.node = ${clip(node)}，期望 >=22`)
  return `engines.node=${node}`
})
pkgCheck('pkg-no-deps', () => {
  const bad = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].filter(
    (k) => pkg[k] && Object.keys(pkg[k]).length > 0,
  )
  assert(bad.length === 0, `不应有 npm 依赖，实际存在：${bad.join(', ')}`)
  return '无任何 npm 依赖'
})

/* ------------------------------------------------------------------ *
 * locale / icon / README
 * ------------------------------------------------------------------ */
check('locale', () => {
  const out = []
  for (const [lang, rel] of [['zh', 'locale/zh.json'], ['en', 'locale/en.json']]) {
    const raw = read(rel)
    assert(raw !== null, `缺少 ${rel}`)
    let j
    try {
      j = JSON.parse(raw)
    } catch (e) {
      throw new Error(`${rel} JSON 解析失败：${e.message}`)
    }
    assert(typeof j?.meta?.title === 'string' && j.meta.title.trim(), `${rel} 缺 meta.title`)
    assert(typeof j?.meta?.description === 'string' && j.meta.description.trim(), `${rel} 缺 meta.description`)
    out.push(`${lang}:「${clip(j.meta.title, 24)}」`)
  }
  return out.join('，')
})
check('icon', () => {
  const svg = read('icon.svg')
  assert(svg !== null, '缺少 icon.svg')
  assert(/<svg[\s>]/i.test(svg), 'icon.svg 内未找到 <svg 根元素')
  assert(/<\/svg>/i.test(svg), 'icon.svg 内未找到 </svg>')
  return `icon.svg ${svg.length} 字节`
})
check('readme', () => {
  const md = read('README.md')
  assert(md !== null, '缺少 README.md')
  assert(md.length > 200, `README.md 仅 ${md.length} 字符，过短（应含安装方式/工具说明/已知限制）`)
  assert(/[\u4e00-\u9fa5]/.test(md), 'README.md 不含中文（spec 要求中文说明）')
  return `${md.length} 字符，含中文`
})

/* ------------------------------------------------------------------ *
 * §4 cordis.patch.yml
 * ------------------------------------------------------------------ */
let patch = null
const yamlRaw = read('cordis.patch.yml')
if (yamlRaw === null) skip('yaml-parse', '缺少 cordis.patch.yml')
else {
  try {
    patch = parseYaml(yamlRaw)
    pass('yaml-parse', Array.isArray(patch) ? `解析为数组（${patch.length} 项）` : `解析为 ${typeof patch}`)
  } catch (e) {
    fail('yaml-parse', `解析失败：${e.message}`)
  }
}

const inserts = Array.isArray(patch) ? patch.flatMap((n) => (Array.isArray(n?.insert) ? n.insert : [])) : []
const patchEntry = inserts.find((e) => e?.id === 'feiyu-connector')
const preset = inserts.find((e) => e?.id === 'preset-feiyu')

if (!Array.isArray(patch)) {
  for (const id of ['patch-insert-list', 'patch-entry', 'patch-preset', 'preset-config', 'preset-plugins', 'persona-prefix']) skip(id, 'cordis.patch.yml 未成功解析')
} else {
  check('patch-insert-list', () => {
    assert(patch.length > 0, 'patch 是空数组')
    assert(inserts.length >= 2, `insert 条目仅 ${inserts.length} 个，期望 ≥2（feiyu-connector + preset-feiyu）`)
    return `${patch.length} 个顶层节点，共 ${inserts.length} 条 insert`
  })
  check('patch-entry', () => {
    assert(patchEntry, 'insert 里找不到 id: feiyu-connector')
    assert(patchEntry.name === '@local/feiyu-connector', `name = ${clip(patchEntry.name)}，期望 @local/feiyu-connector`)
    assert(patchEntry.config && typeof patchEntry.config === 'object', '缺 config 字段')
    return "id/name/config 正确"
  })
  check('patch-preset', () => {
    assert(preset, 'insert 里找不到 id: preset-feiyu')
    assert(preset.name === '@deepseek-ai/dsh-agent-preset', `name = ${clip(preset.name)}，期望 @deepseek-ai/dsh-agent-preset`)
    return 'id=preset-feiyu，name=@deepseek-ai/dsh-agent-preset'
  })

  const pcfg = preset?.config
  check('preset-config', () => {
    assert(pcfg && typeof pcfg === 'object', 'preset-feiyu 缺 config')
    assert(pcfg.id === 'feiyu', `config.id = ${clip(pcfg.id)}，期望 feiyu`)
    assert(pcfg.name === '小肥鱼', `config.name = ${clip(pcfg.name)}，期望 小肥鱼`)
    assert(typeof pcfg.description === 'string' && pcfg.description.trim(), 'config.description 为空')
    assert(typeof pcfg.order === 'number', `config.order 非 number：${clip(pcfg.order)}`)
    return `id=feiyu，name=小肥鱼，order=${pcfg.order}`
  })

  check('preset-plugins', () => {
    const plugins = pcfg?.plugins
    assert(Array.isArray(plugins), 'config.plugins 不是数组')
    const persona = plugins.find((p) => p?.id === 'persona')
    const sched = plugins.find((p) => p?.id === 'tool-schedule')
    assert(persona, 'plugins 缺 id: persona')
    assert(persona.name === '@deepseek-ai/dsh-persona', `persona.name = ${clip(persona.name)}`)
    assert(sched, 'plugins 缺 id: tool-schedule')
    assert(sched.name === '@deepseek-ai/dsh-tool-schedule', `tool-schedule.name = ${clip(sched.name)}`)
    return `${plugins.length} 个插件（persona + tool-schedule）`
  })

  check('persona-prefix', () => {
    const persona = Array.isArray(pcfg?.plugins) ? pcfg.plugins.find((p) => p?.id === 'persona') : null
    const prefix = persona?.config?.prefix
    assert(typeof prefix === 'string', 'persona.config.prefix 不是字符串')
    assert(prefix.length > 800, `prefix 长度 ${prefix.length} ≤ 800（应含角色卡全文 + 规则块）`)
    const need = ['【工具', '【主动开口', '[不说]', 'bili_hot', 'bili_comments']
    const miss = need.filter((s) => !prefix.includes(s))
    assert(miss.length === 0, `prefix 缺规则块要素：${miss.join(', ')}`)
    assert(!/(^|\n)\s*---\s*(\n|$)/.test(prefix), 'prefix 含 YAML front-matter 分隔线 ---（应已剥离）')
    assert(!prefix.includes('<!--'), 'prefix 含 HTML 注释（应已剥离）')
    return `长度 ${prefix.length}，含角色卡 + 「工具/主动开口」规则块`
  })

  check('persona-complete', () => {
    const persona = Array.isArray(pcfg?.plugins) ? pcfg.plugins.find((p) => p?.id === 'persona') : null
    assert(persona?.config?.complete === true, `persona.config.complete = ${clip(persona?.config?.complete)}，期望 true`)
    return 'complete=true（纯 RP）'
  })
}

/* ------------------------------------------------------------------ *
 * §6 index.js 工具注册静态检查
 * ------------------------------------------------------------------ */
const indexSrc = read('index.js')
if (indexSrc === null) {
  for (const id of ['index-name', 'index-inject', 'index-apply', 'index-definetool', 'index-import-style', 'index-tools5', 'index-tool-desc', 'index-tool-required', 'index-tool-output', 'index-schema-required', 'index-no-console', 'index-no-require', 'index-exec-signal', 'index-no-npm']) skip(id, '缺少 index.js')
} else {
  check('index-name', () => {
    assert(/export\s+const\s+name\s*=\s*['"]feiyu-connector['"]/.test(indexSrc), "未找到 export const name = 'feiyu-connector'")
    return "name='feiyu-connector'"
  })
  check('index-inject', () => {
    const m = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(indexSrc)
    assert(m, '未找到 export const inject = [...]')
    assert(/['"]tools['"]/.test(m[1]), `inject 不含 'tools'：${clip(m[1])}`)
    return `inject=[${clip(m[1], 60)}]`
  })
  check('index-apply', () => {
    assert(/export\s+(async\s+)?function\s+apply\s*\(/.test(indexSrc), '未找到 export function apply(ctx)')
    return 'apply(ctx) 已导出'
  })
  check('index-definetool', () => {
    const ref = /(?:from\s+['"]@deepseek-ai\/dsh-tools['"]|import\s*\(\s*['"]@deepseek-ai\/dsh-tools['"]\s*\))/.test(indexSrc)
    assert(ref, "未引用 '@deepseek-ai/dsh-tools'")
    assert(/defineTool\s*\(/.test(indexSrc), '未使用 defineTool(')
    return 'defineTool 来自 @deepseek-ai/dsh-tools（静态/动态 import 均可）'
  })
  check('index-import-style', () => {
    const staticImport = /import\s*\{[^}]*\bdefineTool\b[^}]*\}\s*from\s*['"]@deepseek-ai\/dsh-tools['"]/s.test(indexSrc)
    if (staticImport) return "符合 spec §6：静态 import { defineTool } from '@deepseek-ai/dsh-tools'"
    return { skip: true, detail: '偏离 spec §6：未用静态 import，改为动态 import + 恒等兜底（功能可能等价，是否接受需 Lead 判定）' }
  })

  const TOOL_NAMES = ['bili_hot', 'bili_ranking', 'bili_search', 'bili_video', 'bili_comments']
  const blocks = {}
  {
    const re = /name:\s*['"](bili_(?:hot|ranking|search|video|comments))['"]/g
    const marks = []
    let m
    while ((m = re.exec(indexSrc))) marks.push({ name: m[1], at: m.index })
    marks.forEach((p, k) => {
      blocks[p.name] = indexSrc.slice(p.at, k + 1 < marks.length ? marks[k + 1].at : indexSrc.length)
    })
  }

  check('index-tools5', () => {
    const miss = TOOL_NAMES.filter((n) => !blocks[n])
    assert(miss.length === 0, `未注册：${miss.join(', ')}`)
    return `5 个 bili_* 工具已注册（${Object.keys(blocks).length} 个 name 匹配）`
  })
  check('index-tool-desc', () => {
    for (const n of TOOL_NAMES) {
      const src = blocks[n] ?? ''
      const m = /description:\s*(['"`])([\s\S]*?)\1/.exec(src)
      assert(m && m[2].trim(), `${n} 的 description 为空或缺失`)
      assert(m[2].trim().length >= 8, `${n} 的 description 过短（${m[2].trim().length} 字符），应说清"什么时候用"`)
    }
    return '5 个工具 description 非空'
  })
  check('index-tool-required', () => {
    for (const n of ['bili_search', 'bili_video', 'bili_comments']) {
      const src = blocks[n] ?? ''
      assert(/required:\s*true/.test(src), `${n} 的 parameters 缺 required: true（keyword/bvid 必填）`)
    }
    return 'bili_search / bili_video / bili_comments 均有必填参数'
  })
  check('index-tool-output', () => {
    for (const n of TOOL_NAMES) {
      const src = blocks[n] ?? ''
      assert(/output:\s*\{/.test(src), `${n} 缺 output 字段`)
      assert(/schema\s*:/.test(src), `${n} 的 output 缺 schema`)
      assert(/render\s*[:(]/.test(src), `${n} 的 output 缺 render`)
    }
    return '5 个工具均有 output{schema,render}'
  })
  // 回归检查：DSH 的 JsonSchemaError 不接受 output.schema 里的字段级 `required: true`，
  // 必填必须写成对象级 `required: ['a','b']`（本包曾因该问题首次激活失败）。
  check('index-schema-required', () => {
    for (const n of TOOL_NAMES) {
      const src = blocks[n] ?? ''
      const at = src.indexOf('output:')
      assert(at >= 0, `${n} 缺 output 字段`)
      const outputSrc = sliceBraced(src, at)
      assert(outputSrc, `${n} 的 output 大括号不闭合，无法检查 schema`)
      assert(
        !/required\s*:\s*true/.test(outputSrc),
        `${n} 的 output.schema 含字段级 required: true（DSH JsonSchemaError 不支持，应改为对象级 required: ['a','b']）`,
      )
      assert(/required\s*:\s*\[/.test(outputSrc), `${n} 的 output.schema 缺对象级 required 数组`)
    }
    return 'output.schema 均为对象级 required 数组（回归 JsonSchemaError）'
  })
  check('index-no-console', () => {
    assert(!/console\.log/.test(indexSrc), 'index.js 含 console.log（spec 要求异常交给框架，不打印）')
    return '无 console.log'
  })
  check('index-no-require', () => {
    assert(!/\brequire\s*\(/.test(indexSrc), 'index.js 含 require(（应为 ESM import）')
    return '无 require('
  })
  check('index-exec-signal', () => {
    assert(/exec\.signal/.test(indexSrc), 'execute 未把 exec.signal 传给内部请求')
    return 'execute 使用 exec.signal'
  })
  check('index-no-npm', () => {
    const specs = [...indexSrc.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    const bare = specs.filter((s) => !s.startsWith('.') && !s.startsWith('node:') && !s.startsWith('@deepseek-ai/'))
    assert(bare.length === 0, `出现非法裸模块依赖：${bare.join(', ')}`)
    return `仅 import ${specs.length} 个模块（node: 与 @deepseek-ai/*）`
  })
}

/* ------------------------------------------------------------------ *
 * §5 lib/bili.js 内部要求（静态）
 * ------------------------------------------------------------------ */
const libSrc = read('lib/bili.js')
if (libSrc === null) {
  for (const id of ['lib-exports', 'lib-sources', 'lib-ua-referer', 'lib-timeout', 'lib-retry', 'lib-cache', 'lib-no-console', 'lib-errors', 'lib-wbi', 'lib-no-npm']) skip(id, '缺少 lib/bili.js')
} else {
  check('lib-exports', () => {
    const fns = ['hotSearch', 'ranking', 'searchVideos', 'videoDetail', 'videoComments']
    const miss = fns.filter((f) => !new RegExp(`export\\s+async\\s+function\\s+${f}\\s*\\(`).test(libSrc))
    assert(miss.length === 0, `缺少 export async function：${miss.join(', ')}`)
    assert(/export\s+const\s+__test__/.test(libSrc), '缺少 export const __test__')
    return '5 个 async 函数 + __test__ 已导出'
  })
  check('lib-sources', () => {
    const need = ['search/square', 'ranking/v2', 'wbi/search/type', 'web-interface/view', 'x/v2/reply', 'web-interface/nav']
    const miss = need.filter((s) => !libSrc.includes(s))
    assert(miss.length === 0, `数据源端点缺失：${miss.join(', ')}`)
    return '6 个 B 站端点均已出现'
  })
  check('lib-ua-referer', () => {
    assert(/Mozilla\/5\.0[\s\S]*Chrome\//.test(libSrc), '未找到桌面 Chrome UA')
    assert(/Referer/i.test(libSrc) && /bilibili\.com/.test(libSrc), '未找到 Referer: https://www.bilibili.com/')
    return 'UA=Chrome，Referer=bilibili.com'
  })
  check('lib-timeout', () => {
    assert(/AbortSignal\.timeout|AbortController/.test(libSrc), '未找到超时实现（AbortSignal.timeout / AbortController）')
    return '请求带超时 signal'
  })
  check('lib-retry', () => {
    assert(/retry|重试/i.test(libSrc), '未找到失败重试逻辑（spec：失败重试 1 次）')
    return '含重试逻辑'
  })
  check('lib-cache', () => {
    assert(/cache/i.test(libSrc), '未找到缓存实现')
    assert(/300_?000|5\s*\*\s*60_?000|5\s*分钟|TTL/i.test(libSrc), '未找到 5 分钟 TTL（默认缓存时长）')
    return '含进程内 TTL 缓存'
  })
  check('lib-no-console', () => {
    assert(!/console\.log/.test(libSrc), 'lib/bili.js 含 console.log（spec：不要打日志到 stdout）')
    return '无 console.log'
  })
  check('lib-errors', () => {
    for (const msg of ['不能为空', '视频不存在或已失效']) assert(libSrc.includes(msg), `缺中文错误文案：${msg}`)
    return '关键错误文案符合 §5'
  })
  check('lib-wbi', () => {
    assert(/mixinKey|w_rid|wbi/i.test(libSrc), '未找到 wbi 签名实现（mixinKeyEncTab / w_rid）')
    return '含 wbi 签名逻辑'
  })
  check('lib-no-npm', () => {
    const specs = [...libSrc.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
    const bad = specs.filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
    assert(bad.length === 0, `lib/bili.js 出现非法依赖：${bad.join(', ')}（只允许 node: 内置模块）`)
    return `仅 import ${specs.length} 个 node: 内置模块`
  })
}

/* ------------------------------------------------------------------ *
 * §7.2 允许真实 import('@deepseek-ai/dsh-tools')，失败则 SKIP
 * ------------------------------------------------------------------ */
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod.defineTool === 'function') pass('dsh-tools-import', "defineTool 可解析（typeof === 'function'）")
  else fail('dsh-tools-import', "import 成功但未导出 defineTool 函数")
} catch (err) {
  skip('dsh-tools-import', `工作区无法 import('@deepseek-ai/dsh-tools')（安装到 profile 后由 Host 解析）：${clip(err?.message ?? err, 100)}`)
}

emit()
