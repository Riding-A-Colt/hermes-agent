/**
 * 朗读队列：一段一段入队，念过的出队。
 *
 * 2026-11-08 一天里所有重复的根都是同一件事：朗读从「消息存储里现算这一轮还没
 * 念什么」，而这个范围会变——工具调用折叠气泡、封口只剩最后一段、一次会话横跨
 * 好几段。游标能保证「同样的字不送第二遍」，却管不住「要念的范围本身翻倍」：实测
 * 客户端送出的文本一路涨到 439 字（那一轮实际只有 150 字），随后从中间整段重念。
 *
 * 队列换一个方向：**范围由气泡自己决定**。每个助手气泡是一个独立条目，按「开头
 * 文字」认身份——流式时只会往后长，开头不变；气泡后来被折叠、被重切、整轮拼接
 * 变了，都影响不到已经入队的条目。
 *
 * 记录**不因换轮清空**：任何「轮」的凭据（消息 id、气泡序号、用户消息条数）都在
 * 一轮内会变，一变就等于没念过——hold 等上几秒就会触发，实测整个后半段念两遍
 * （21:02 那轮）。记录只在超时闲置时过期，真正的「再念一次」隔了不止这几分钟。
 */

export interface SpeechBubble {
  /** 这条气泡当前的全文 */
  text: string
  /** 是否已定稿（不再增长） */
  sealed: boolean
}

export interface QueueItem {
  /** 气泡身份 */
  key: string
  /** 这次要送出去的文字 */
  chunk: string
}

interface Entry {
  /** 已经送出去多少字 */
  sent: number
  /** 上一次看到的全文 */
  text: string
  /** 最后一次用它的时刻 */
  at: number
}

const entries = new Map<string, Entry>()

/** 认身份用的开头字数：够区分，又不至于被流式增长影响 */
const IDENTITY_CHARS = 16

/** 开头至少重合这么多字，才算同一条气泡 */
const MIN_IDENTITY = 6

/** 超过这么久没有新文字进来，这条记录过期（真正的「再念一次」会重新开口） */
const ENTRY_TTL_MS = 10 * 60_000

function fingerprint(text: string): string {
  const head = text.slice(0, IDENTITY_CHARS)
  let hash = 0x811c9dc5

  for (let index = 0; index < head.length; index += 1) {
    hash ^= head.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `${head.length}:${(hash >>> 0).toString(36)}`
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0

  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1
  }

  return index
}

/** 折叠/聚合覆盖判据：一段文字若能被「已有条目按顺序拼出来」（中间容忍最多
 *  两个空白字符）就当念过——水合折叠把整轮折成一个大气泡、收取文本从轮中间
 *  开始，两种形状都会产生这样的尾巴/聚合（2026-11-09 13:26 实测折叠加了 99 字
 *  的已念内容被当新字整段重念）。真正的新增长永远拼不出来，照常开口。 */
function coveredBySequence(text: string, now: number): boolean {
  let offset = 0

  while (offset < text.length) {
    let matched = false

    for (const entry of entries.values()) {
      if (now - entry.at > ENTRY_TTL_MS || !entry.text) {
        continue
      }

      // 容忍两个空白字符的分隔
      let at = offset

      while (at < offset + 2 && /\s/.test(text[at] ?? '')) {
        at += 1
      }

      if (text.startsWith(entry.text, at)) {
        offset = at + entry.text.length
        matched = true

        break
      }
    }

    if (!matched) {
      return false
    }
  }

  return true
}

/**
 * 找这条气泡对应的记录。指纹只是快路径：气泡短于 16 字时，指纹会随增长而变，
 * 所以要再按「开头重合」找一遍，不然同一段会被当成新气泡整段重发（实测叠字）。
 */
function resolve(text: string, now: number): { entry: Entry; key: string } | undefined {
  const key = fingerprint(text)
  const exact = entries.get(key)

  if (exact) {
    return now - exact.at > ENTRY_TTL_MS ? undefined : { entry: exact, key }
  }

  let best: { entry: Entry; key: string; shared: number } | undefined

  for (const [candidateKey, entry] of entries) {
    const shared = commonPrefixLength(entry.text, text)

    if (shared < Math.min(IDENTITY_CHARS, text.length, entry.text.length) || shared < MIN_IDENTITY) {
      continue
    }

    if (!best || shared > best.shared) {
      best = { entry, key: candidateKey, shared }
    }
  }

  return best
}

/**
 * 已念内容里就包含这段文字吗？气泡的文字会被中途改写（工具行折叠、hydration
 * 重排，开头的「第二段：」没了之类），按开头认不出它时，先看它是不是落在某条
 * 已念内容里面——是就当念过（2026-11-08 21:33 实测第二、三段因此各念两遍）。
 */
function alreadyCovered(text: string, now: number): boolean {
  if (text.length < MIN_IDENTITY) {
    return false
  }

  for (const entry of entries.values()) {
    if (now - entry.at > ENTRY_TTL_MS) {
      continue
    }

    if (entry.sent >= text.length && entry.text.includes(text)) {
      return true
    }
  }

  return false
}

/** 折叠空白再比对：hydration 会在行首行尾添空格，原样匹配会认丢同一段 */
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

export function takeQueue(sessionId: string | null | undefined, bubbles: SpeechBubble[], now: number = Date.now()): QueueItem[] {
  const items: QueueItem[] = []

  for (const bubble of bubbles) {
    const text = normalize(bubble.text)

    if (!text) {
      continue
    }

    // 流式开头太短认不了身份：指纹必然变，开头重合又不足 MIN_IDENTITY，等它长过
    // 门槛再整段入队——不然 3 字前缀先发一遍、长大后又整段发一遍（2026-11-09
    // 实测「第一段第一段，书架…」的来源）。已定稿的短气泡除外（那是正文）。
    if (text.length < MIN_IDENTITY && !bubble.sealed) {
      continue
    }

    const found = resolve(text, now)

    if (!found && alreadyCovered(text, now)) {
      continue
    }

    if (!found) {
      // 聚合态：整段文字正好由已念条目按序拼出来（换轮把锚点挪进轮中间，收取
      // 从第二段开始的那种）——当念过，入账但不出声。
      if (coveredBySequence(text, now)) {
        entries.set(fingerprint(text), { at: now, sent: text.length, text })

        continue
      }

      const fresh = fingerprint(text)

      entries.set(fresh, { at: now, sent: text.length, text })
      console.error(`[asdiag] queue fresh ${text.slice(0, 12)}…`)
      items.push({ chunk: text, key: fresh })

      continue
    }

    const { entry, key } = found

    entry.at = now

    if (text.length > entry.sent) {
      const chunk = text.slice(entry.sent).trim()

      entry.sent = text.length
      entry.text = text

      if (chunk && !coveredBySequence(chunk, now)) {
        console.error(`[asdiag] queue grew "${text.slice(0, 12)}…" sent=${entry.sent}`)
        items.push({ chunk, key })
      }

      continue
    }

    // 变短或改写：不重发，也别把「已送字数」缩回去——存储下一帧往往又把整段还
    // 回来，缩过的话中间的字会被重送（实测叠字）。记录保持最长的那份。
    //
    // 这里刻意不动 entry：|$entry.sent| 以上都送过了。
  }

  return items
}

/** 收尾补读、回退整段这类路径用它把某段标成已送。 */
export function noteQueued(sessionId: string | null | undefined, text: string): void {
  const trimmed = normalize(text)
  const now = Date.now()

  if (!trimmed) {
    return
  }

  entries.set(fingerprint(trimmed), { at: now, sent: trimmed.length, text: trimmed })
}

export function readQueueEntry(text: string): Entry | undefined {
  return resolve(normalize(text), Date.now())?.entry
}

export function clearSpeechQueueForTests(): void {
  entries.clear()
}
