// B 站只读 HTTP 客户端：零 npm 依赖（只用 node:crypto 与全局 fetch）。
// 约定：导出函数全部 async；网络/解析失败抛 Error（message 为中文短句）；
//       UA 用桌面 Chrome、带 Referer、单次 10s 超时、失败重试 1 次、进程内 TTL 缓存 5 分钟。
// 可选参数 signal：调用方（工具执行器）传入的取消信号，会与内部超时合并。
import { createHash } from 'node:crypto'

const API = 'https://api.bilibili.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const TIMEOUT_MS = 10_000
const RETRIES = 1
const CACHE_TTL_MS = 5 * 60_000
const WBI_TTL_MS = 10 * 60_000

// ---------- 进程内缓存 ----------

const cache = new Map()
let wbiKeysCache = { at: 0, value: null }

function cacheKey(fn, args) {
  try {
    return `${fn}:${JSON.stringify(args ?? {})}`
  } catch {
    return `${fn}:`
  }
}

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return hit.value
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value })
  return value
}

// 清空 TTL 缓存（测试与调试用）
function cacheClear() {
  cache.clear()
  wbiKeysCache = { at: 0, value: null }
}

// ---------- 基础工具 ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max, fallback) {
  const number = Math.trunc(asNumber(value, fallback))
  return Math.min(Math.max(number, min), max)
}

function stripHtml(input) {
  return String(input ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

function clip(input, max) {
  const text = String(input ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function httpsUrl(input) {
  const raw = String(input ?? '')
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  return raw.replace(/^http:\/\//i, 'https://')
}

function videoUrl(bvid) {
  return `https://www.bilibili.com/video/${bvid}`
}

function searchUrl(keyword) {
  return `https://search.bilibili.com/all?keyword=${encodeURIComponent(String(keyword ?? ''))}`
}

// 秒数 / "MM:SS" 统一成 "MM:SS" 或 "H:MM:SS"
function formatDuration(input) {
  if (typeof input === 'string' && /^\d+(:\d{2}){1,2}$/.test(input)) return input
  const total = Math.max(0, Math.round(asNumber(input, 0)))
  if (total <= 0) return '00:00'
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

// 允许传 BV 号，也允许传完整视频链接
function normalizeBvid(input) {
  const raw = String(input ?? '').trim()
  const matched = raw.match(/BV[0-9A-Za-z]{10}/)
  return matched ? matched[0] : raw
}

function normalizeError(error) {
  if (error instanceof Error && /^B 站/.test(error.message)) return error
  const name = error?.name
  if (name === 'TimeoutError') return Object.assign(new Error('B 站接口超时'), { retryable: true })
  if (name === 'AbortError') return Object.assign(new Error('B 站请求被取消'), { retryable: false })
  return Object.assign(new Error('B 站暂时连不上'), { retryable: true })
}

// 统一请求：10s 超时 + 失败重试 1 次；4xx 不重试
async function fetchJson(url, { signal } = {}) {
  let lastError
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('B 站请求被取消')
    try {
      const timeout = AbortSignal.timeout(TIMEOUT_MS)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: REFERER,
          Accept: 'application/json, text/plain, */*',
        },
        signal: combined,
      })
      if (!response.ok) {
        const retryable = response.status >= 500
        throw Object.assign(new Error(`B 站接口暂时用不了（HTTP ${response.status}）`), { retryable })
      }
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw Object.assign(new Error('B 站返回的数据看不懂'), { retryable: true })
      }
    } catch (error) {
      if (signal?.aborted) throw new Error('B 站请求被取消')
      lastError = normalizeError(error)
      const canRetry = error?.retryable !== false && attempt < RETRIES
      if (!canRetry) break
      await sleep(250)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('B 站暂时连不上')
}

// ---------- wbi 签名 ----------

// 官方的 64 位重排表
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

function keyFromUrl(input) {
  const base = String(input ?? '').split('/').pop() ?? ''
  return base.replace(/\.[a-z0-9]+$/i, '')
}

// 把 img_key + sub_key 混淆成 32 位 mixinKey（入参可以是 key，也可以是完整 URL）
export function mixinKey(imgKey, subKey) {
  const original = keyFromUrl(imgKey) + keyFromUrl(subKey)
  let mixed = ''
  for (const index of MIXIN_KEY_ENC_TAB) mixed += original[index] ?? ''
  return mixed.slice(0, 32)
}

// 返回已签名的查询串（含 wts 与 w_rid）
export function signParams(params = {}, key = '') {
  const wts = Math.floor(Date.now() / 1000)
  const merged = { ...params, wts }
  const query = Object.keys(merged)
    .sort()
    .map((name) => {
      const value = String(merged[name] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = createHash('md5').update(query + String(key ?? '')).digest('hex')
  return `${query}&w_rid=${wRid}`
}

// 不签名的查询串（签名不可用时的降级路径）
function plainQuery(params = {}) {
  return Object.keys(params)
    .sort()
    .map((name) => {
      const value = String(params[name] ?? '').replace(/[!'()*]/g, '')
      return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
    })
    .join('&')
}

async function getWbiKeys(signal) {
  if (wbiKeysCache.value && Date.now() - wbiKeysCache.at < WBI_TTL_MS) return wbiKeysCache.value
  const json = await fetchJson(`${API}/x/web-interface/nav`, { signal })
  const imgUrl = json?.data?.wbi_img?.img_url
  const subUrl = json?.data?.wbi_img?.sub_url
  if (!imgUrl || !subUrl) throw new Error('wbi 密钥拿不到')
  const value = mixinKey(imgUrl, subUrl)
  if (value.length < 32) throw new Error('wbi 密钥不完整')
  wbiKeysCache = { at: Date.now(), value }
  return value
}

// ---------- 5 个只读接口 ----------

// 全站热搜；带 keyword 时在本地过滤
export async function hotSearch({ limit = 10, keyword, signal } = {}) {
  const size = clamp(limit, 1, 50, 10)
  const word = typeof keyword === 'string' ? keyword.trim() : ''
  const key = cacheKey('hotSearch', { size, word })
  const cached = cacheGet(key)
  if (cached) return cached

  const json = await fetchJson(`${API}/x/web-interface/search/square?limit=${size}`, { signal })
  if (json?.code !== 0) throw new Error('热搜暂时拿不到')
  const list = json?.data?.trending?.list
  if (!Array.isArray(list)) throw new Error('热搜数据解析失败')

  const lowerWord = word.toLowerCase()
  const keywords = list
    .filter((item) => {
      const text = String(item?.keyword ?? '')
      return text && (!lowerWord || text.toLowerCase().includes(lowerWord))
    })
    .map((item) => {
      const text = String(item.keyword)
      const hot = asNumber(item.hot_value ?? item.hot_score, 0)
      return { keyword: text, url: searchUrl(text), ...(hot > 0 ? { hot } : {}) }
    })

  return cacheSet(key, { keywords })
}

// 排行榜（rid 为分区，0 = 全站）
export async function ranking({ rid = 0, limit = 20, signal } = {}) {
  const zone = Math.max(0, Math.trunc(asNumber(rid, 0)))
  const size = clamp(limit, 1, 50, 20)
  const key = cacheKey('ranking', { zone, size })
  const cached = cacheGet(key)
  if (cached) return cached

  const json = await fetchJson(`${API}/x/web-interface/ranking/v2?rid=${zone}&type=all`, { signal })
  if (json?.code !== 0) throw new Error('排行榜暂时拿不到')
  const list = json?.data?.list
  if (!Array.isArray(list)) throw new Error('排行榜数据解析失败')

  const items = list.slice(0, size).map((video) => {
    const bvid = String(video?.bvid ?? '')
    return {
      bvid,
      title: stripHtml(video?.title),
      owner: String(video?.owner?.name ?? ''),
      view: asNumber(video?.stat?.view),
      like: asNumber(video?.stat?.like),
      duration: formatDuration(video?.duration),
      videoUrl: videoUrl(bvid),
      cover: httpsUrl(video?.pic),
    }
  })

  return cacheSet(key, { items })
}

// 关键词搜索视频（wbi 签名，失败自动降级为不签名）
export async function searchVideos({ keyword, order = 'totalrank', page = 1, limit = 20, signal } = {}) {
  const word = String(keyword ?? '').trim()
  if (!word) throw new Error('keyword 不能为空')
  const size = clamp(limit, 1, 30, 20)
  const pageNo = Math.max(1, Math.trunc(asNumber(page, 1)))
  const key = cacheKey('searchVideos', { word, order, pageNo, size })
  const cached = cacheGet(key)
  if (cached) return cached

  const params = {
    search_type: 'video',
    keyword: word,
    order: String(order || 'totalrank'),
    page: pageNo,
    page_size: size,
    platform: 'pc',
  }
  const path = '/x/web-interface/wbi/search/type'

  // 先试签名请求；拿不到密钥或签名请求被拒就退回不签名请求
  let json = null
  try {
    const mixin = await getWbiKeys(signal)
    json = await fetchJson(`${API}${path}?${signParams(params, mixin)}`, { signal })
  } catch {
    json = null
  }
  if (!json || json.code !== 0) {
    json = await fetchJson(`${API}${path}?${plainQuery(params)}`, { signal })
  }
  if (json?.code !== 0) throw new Error('搜索暂时拿不到')

  const data = json?.data
  const list = Array.isArray(data?.result) ? data.result : []
  const items = list
    .filter((video) => video && video.bvid)
    .slice(0, size)
    .map((video) => ({
      bvid: String(video.bvid),
      title: stripHtml(video.title),
      owner: stripHtml(video.author),
      view: asNumber(video.play),
      like: asNumber(video.like),
      duration: formatDuration(video.duration),
      description: clip(stripHtml(video.description), 120),
      videoUrl: videoUrl(String(video.bvid)),
    }))

  return cacheSet(key, { total: asNumber(data?.numResults ?? data?.total), items })
}

// 视频详情
export async function videoDetail({ bvid, signal } = {}) {
  const id = normalizeBvid(bvid)
  if (!id) throw new Error('bvid 不能为空')
  const key = cacheKey('videoDetail', { id })
  const cached = cacheGet(key)
  if (cached) return cached

  const json = await fetchJson(`${API}/x/web-interface/view?bvid=${encodeURIComponent(id)}`, { signal })
  if (json?.code !== 0) throw new Error('视频不存在或已失效')
  const data = json?.data ?? {}
  const realBvid = String(data.bvid ?? id)

  return cacheSet(key, {
    bvid: realBvid,
    aid: asNumber(data.aid),
    title: stripHtml(data.title),
    owner: String(data.owner?.name ?? ''),
    view: asNumber(data.stat?.view),
    like: asNumber(data.stat?.like),
    coin: asNumber(data.stat?.coin),
    favorite: asNumber(data.stat?.favorite),
    share: asNumber(data.stat?.share),
    duration: formatDuration(data.duration),
    pubdate: asNumber(data.pubdate),
    description: clip(stripHtml(data.desc), 500),
    cover: httpsUrl(data.pic),
    videoUrl: videoUrl(realBvid),
  })
}

// 评论（先借 videoDetail 拿 aid；无评论返回空数组，不抛错）
export async function videoComments({ bvid, limit = 20, sort = 'hot', signal } = {}) {
  const id = normalizeBvid(bvid)
  if (!id) throw new Error('bvid 不能为空')
  const size = clamp(limit, 1, 50, 20)
  const order = String(sort ?? 'hot').toLowerCase() === 'new' ? 0 : 2
  const key = cacheKey('videoComments', { id, size, order })
  const cached = cacheGet(key)
  if (cached) return cached

  const detail = await videoDetail({ bvid: id, signal })
  if (!detail.aid) throw new Error('视频不存在或已失效')

  const json = await fetchJson(`${API}/x/v2/reply?type=1&oid=${detail.aid}&sort=${order}&ps=${size}&pn=1`, { signal })
  const data = json?.code === 0 ? json.data : null
  if (!data) return cacheSet(key, { count: 0, items: [] })

  const replies = Array.isArray(data.replies) ? data.replies : []
  const items = replies.slice(0, size).map((item) => ({
    user: String(item?.member?.uname ?? ''),
    message: clip(item?.content?.message, 300),
    like: asNumber(item?.like),
    time: asNumber(item?.ctime),
    replies: asNumber(item?.rcount),
  }))

  return cacheSet(key, { count: asNumber(data?.page?.count, items.length), items })
}

// 给测试用的内部钩子
export const __test__ = { cacheClear, mixinKey, signParams }
