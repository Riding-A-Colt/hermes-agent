/**
 * 本轮锚点闸 v2：按「锚点行的新鲜度」放行，不数行数。
 *
 * 2026-11-08/09 实测：转录会被一张**滞后的快照**整体替换，随后事件重放把缺的行逐条
 * 补回来——这个窗口不是亚秒级闪断（实测静止 37 秒以上），重放还会持续更久。行数
 * 高水位挡得住替换帧，挡不住「静止超时后误判真截断」和「重放补行时每帧行数在涨」。
 *
 * 稳定的判据是锚点用户行自己：
 * - **新轮的用户行时间戳就在眼前**（乐观行 `Date.now()/1000`，水合行带后端时间戳，
 *   单位都是秒）——30 秒内算新鲜，放行；
 * - **锚点文本就是当前轮**——同一轮跑多久都放行（长轮次、重放补回当前轮的用户行）；
 * - 其余情况（锚点是重放出来的旧行、快照里的上一轮）一律静音：pendingResponse 返回
 *   null、turnBubbles 返回空。静音只是延迟，队列按气泡记账，水位回来后增量照送。
 *
 * 时间戳缺失当新鲜处理：乐观行和水合行都带时间戳，缺失是极端兜底，宁可放行也不
 * 把新轮永久静音。
 */

const NO_SESSION = '\0'

/** 锚点用户行距现在多久内算「新轮」（秒） */
export const ANCHOR_FRESH_S = 30

export interface TurnAnchorMessage {
  hidden?: boolean
  role: string
  /** Unix 秒（带小数也行；毫秒会自动归一） */
  timestamp?: number
  parts?: readonly { type: unknown; text?: string }[]
}

interface AnchorState {
  /** 当前轮锚点（最后一条用户行）的归一化文本 */
  current: string | null
  /** 本轮静音是否已打过日志（逐帧打会刷屏） */
  muted: boolean
}

const bySession = new Map<string, AnchorState>()

function sessionKey(sessionId: string | null | undefined): string {
  return sessionId ?? NO_SESSION
}

const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim()

function anchorText(message: TurnAnchorMessage): string {
  return normalizeText(
    (message.parts ?? [])
      .filter(part => part.type === 'text')
      .map(part => part.text ?? '')
      .join('')
  )
}

function timestampSeconds(value: number | undefined): number | null {
  if (value === undefined) {
    return null
  }

  // 容错：个别路径给了毫秒。
  return value > 1e12 ? value / 1000 : value
}

/**
 * 这一帧的裁决。`stable`＝可以当真；`liveTail`＝锚点是旧行、但行后跟着带新鲜
 * 时间戳的助手行——存储把当前轮的用户行弄丢了（快照替换后没补回），这时只放行
 * 新鲜行，旧行一律不入队（回放重放的旧行时间戳旧，在 `turnBubbles` 里被滤掉，
 * 就算朗读队列空着也不会重念历史）。
 */
export interface TurnAnchorVerdict {
  stable: boolean
  liveTail: boolean
}

export function turnAnchor(
  sessionId: string | null | undefined,
  messages: readonly TurnAnchorMessage[],
  now: number = Date.now()
): TurnAnchorVerdict {
  const key = sessionKey(sessionId)
  const lastUser = messages.findLastIndex(message => message.role === 'user')

  // 没有锚点（hydration 空窗）：静音，绝不把「全部消息」当本轮。
  if (lastUser < 0) {
    return { stable: false, liveTail: false }
  }

  const row = messages[lastUser]
  const text = anchorText(row)
  const ts = timestampSeconds(row.timestamp)
  const fresh = ts === null || now / 1000 - ts <= ANCHOR_FRESH_S

  let state = bySession.get(key)

  if (!state) {
    state = { current: null, muted: false }
    bySession.set(key, state)
  }

  if (fresh || text === state.current) {
    state.current = text
    state.muted = false

    return { stable: true, liveTail: false }
  }

  // 锚点旧行 + 行后跟新鲜助手行：存储丢了当前轮的用户行（引导快照替换之后
  // 重放没把它补回来），按活尾巴放行。
  const liveTail = messages
    .slice(lastUser + 1)
    .some(message => message.role === 'assistant' && timestampSeconds(message.timestamp) !== null && (timestampSeconds(message.timestamp) as number) >= now / 1000 - ANCHOR_FRESH_S)

  if (liveTail) {
    state.muted = false

    return { stable: true, liveTail: true }
  }

  if (!state.muted) {
    state.muted = true
    const age = ts === null ? '?' : `${Math.round(now / 1000 - ts)}s`
    console.error(`[asdiag] anchor stale: "${text.slice(0, 12)}…" age=${age} muted`)
  }

  return { stable: false, liveTail: false }
}

/**
 * 锚点用户行是不是「刚刚新到的」。给「渲染进程刚起、还没念过任何东西」的场景用：
 * 新鲜锚点之前的内容属于上一个渲染进程念过的（或者根本是历史），标掉，别重念。
 * 时间戳缺失当不新鲜——这里宁可少标也不多标。
 */
export function turnAnchorIsFresh(
  messages: readonly TurnAnchorMessage[],
  now: number = Date.now()
): boolean {
  const lastUser = messages.findLastIndex(message => message.role === 'user')

  if (lastUser < 0) {
    return false
  }

  const ts = timestampSeconds(messages[lastUser].timestamp)

  return ts !== null && now / 1000 - ts <= ANCHOR_FRESH_S
}

/** 单行时间戳是不是新鲜的（活尾巴过滤用：只放行带新鲜时间戳的助手行）。 */
export function rowTimestampFresh(message: TurnAnchorMessage, now: number = Date.now()): boolean {
  const ts = timestampSeconds(message.timestamp)

  return ts !== null && now / 1000 - ts <= ANCHOR_FRESH_S
}

/**
 * 会话拿到真实 id（null → created）时迁移当前轮锚点，与 spoken-reply 的 adopt 同形：
 * 不跨两个真实会话复制，`\0` 桶迁移后即删——留着会把下一个新会话的锚点误当当前轮。
 */
export function adoptTurnAnchorSession(
  fromSessionId: string | null | undefined,
  toSessionId: string | null | undefined
): void {
  const fromKey = sessionKey(fromSessionId)
  const toKey = sessionKey(toSessionId)

  if (fromKey !== NO_SESSION || toKey === NO_SESSION) {
    return
  }

  const from = bySession.get(fromKey)

  if (!from) {
    return
  }

  bySession.delete(fromKey)

  if (!bySession.has(toKey)) {
    bySession.set(toKey, from)
  }
}

export function clearTurnAnchorsForTests(): void {
  bySession.clear()
}
