import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ChatMessage } from '@/lib/chat-messages'
import { collectUnspokenTurnSpeech } from '@/lib/chat-messages'
import { clearSpeechQueueForTests, takeQueue } from '@/lib/speech-queue'
import { markAssistantIdSpoken, resolveSpokenReply } from '@/lib/spoken-reply'
import {
  adoptTurnAnchorSession,
  clearTurnAnchorsForTests,
  rowTimestampFresh,
  turnAnchor,
  turnAnchorIsFresh
} from '@/lib/turn-anchor'

const assistant = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  parts: text ? [{ type: 'text', text }] : [],
  ...extra
})

const user = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
  ...extra
})

describe('turnAnchor（锚点行新鲜度）', () => {
  beforeEach(() => {
    clearTurnAnchorsForTests()
  })

  afterEach(() => {
    clearTurnAnchorsForTests()
  })

  it('accepts a fresh anchor and latches it as the current turn', () => {
    const s = 's1'
    const frame = [user('u1', '说一次五段试试。', { timestamp: 1_000 })]

    expect(turnAnchor(s, frame, 1_000 * 1000)).toEqual({ stable: true, liveTail: false })
    expect(turnAnchor(s, frame, 1_025 * 1000)).toEqual({ stable: true, liveTail: false })
  })

  it('keeps accepting the current turn anchor however old it gets (long turns)', () => {
    const s = 's1'
    const frame = [user('u1', '长轮次的提问。', { timestamp: 1_000 })]

    expect(turnAnchor(s, frame, 1_000 * 1000)).toEqual({ stable: true, liveTail: false })
    expect(turnAnchor(s, frame, 1_000 * 1000 + 15 * 60_000)).toEqual({ stable: true, liveTail: false })
  })

  it('mutes a stale anchor that is not the current turn (snapshot/replay frame)', () => {
    const s = 's1'
    const turn1 = user('u1', '上一轮的提问。', { timestamp: 1_000 })
    const turn2 = user('u2', '这一轮的提问。', { timestamp: 2_000 })

    expect(turnAnchor(s, [turn2], 2_000 * 1000)).toEqual({ stable: true, liveTail: false })

    // 滞后快照：锚点退回上一轮的用户行 → 静音。
    expect(turnAnchor(s, [turn1], 2_120 * 1000)).toEqual({ stable: false, liveTail: false })
    expect(turnAnchor(s, [turn1], 2_125 * 1000)).toEqual({ stable: false, liveTail: false })
    expect(turnAnchor(s, [turn2], 2_130 * 1000)).toEqual({ stable: true, liveTail: false })
  })

  it('liveTail: stale anchor but brand-new assistant rows after it → stable with liveTail', () => {
    const s = 's1'
    const turn1 = user('u1', '上一轮的提问。', { timestamp: 1_000 })
    const oldReply = assistant('a1', '旧旁白的行，时间戳很老不该再念。', { timestamp: 1_050 })
    const liveRow = assistant('a2', '新鲜旁白，时间戳就在眼前。', { timestamp: 2_120 })

    expect(turnAnchor(s, [turn1], 2_120 * 1000)).toEqual({ stable: false, liveTail: false })
    expect(turnAnchor(s, [turn1, oldReply], 2_120 * 1000)).toEqual({ stable: false, liveTail: false })
    // 存储丢了当前轮用户行的形状：旧行 + 新鲜助手行 → liveTail
    expect(turnAnchor(s, [turn1, oldReply, liveRow], 2_121 * 1000)).toEqual({
      stable: true,
      liveTail: true
    })
  })

  it('accepts a brand-new turn by its fresh timestamp (repeated wording counts as new)', () => {
    const s = 's1'
    const first = user('u1', '再说一次。', { timestamp: 1_000 })

    expect(turnAnchor(s, [first], 1_000 * 1000)).toEqual({ stable: true, liveTail: false })

    const repeat = user('u2', '再说一次。', { timestamp: 600_000 })

    expect(turnAnchor(s, [repeat], 600_000 * 1000)).toEqual({ stable: true, liveTail: false })
  })

  it('treats a missing timestamp as fresh', () => {
    const s = 's1'
    const frame = [user('u1', '没有时间戳的行。')]

    expect(turnAnchor(s, frame, 9_999_000 * 1000)).toEqual({ stable: true, liveTail: false })
  })

  it('mutes frames without any user row', () => {
    expect(turnAnchor('s1', [assistant('a1', '中间态没有用户行。')], 1_000)).toEqual({
      stable: false,
      liveTail: false
    })
  })

  describe('turnAnchorIsFresh / rowTimestampFresh', () => {
    it('turnAnchorIsFresh marks just-arrived anchors', () => {
      const fresh = [user('u1', '刚到。', { timestamp: 1_000 })]

      expect(turnAnchorIsFresh(fresh, 1_000 * 1000)).toBe(true)
      expect(turnAnchorIsFresh(fresh, 1_020 * 1000)).toBe(true)
      expect(turnAnchorIsFresh(fresh, 1_031 * 1000)).toBe(false)
      expect(turnAnchorIsFresh([user('u1', '没有时间戳。')], 1_000)).toBe(false)
      expect(turnAnchorIsFresh([assistant('a1', '没有用户行。')], 1_000)).toBe(false)
    })

    it('rowTimestampFresh handles missing timestamps', () => {
      expect(rowTimestampFresh(assistant('a', 'x', { timestamp: 1_000 }), 1_000 * 1000)).toBe(true)
      expect(rowTimestampFresh(assistant('a', 'x'), 9_999)).toBe(false)
    })
  })

  it('keeps sessions isolated and adopts null -> real id once', () => {
    const frame = [user('u1', '这条。', { timestamp: 1_000 })]

    expect(turnAnchor(null, frame, 1_000 * 1000)).toEqual({ stable: true, liveTail: false })
    expect(turnAnchor('s2', frame, 1_000 * 1000)).toEqual({ stable: true, liveTail: false })

    adoptTurnAnchorSession(null, 's1')

    // 迁移后的真实会话认得当前轮；\0 桶清空，新会话从零开始。
    expect(turnAnchor('s1', frame, 60_000 * 1000)).toEqual({ stable: true, liveTail: false })
    expect(turnAnchor(null, [user('u9', '别的。', { timestamp: 59_999 })], 60_000 * 1000)).toEqual({
      stable: true,
      liveTail: false
    })

    // 两个真实会话之间不复制。
    const before = turnAnchor('s2', frame, 60_000 * 1000)
    adoptTurnAnchorSession('s1', 's2')
    expect(turnAnchor('s2', frame, 60_000 * 1000)).toEqual(before)
  })
})

describe('replay：滞后快照与重放不重念历史', () => {
  beforeEach(() => {
    clearTurnAnchorsForTests()
    clearSpeechQueueForTests()
  })

  afterEach(() => {
    clearTurnAnchorsForTests()
    clearSpeechQueueForTests()
  })

  /** 与 use-composer-voice 同形的取料口：锚点闸（含 liveTail）→ 吞没刚起进程的历史尾巴 → 逐气泡入队。 */
  const speakTextOf = (message: ChatMessage): string =>
    message.parts
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
      .trim()

  const isFreshRow = (message: ChatMessage, now: number): boolean =>
    message.timestamp !== undefined && now / 1000 - message.timestamp <= 30

  const pipeline = (sessionId: string, messages: ChatMessage[], now: number): string[] => {
    const verdict = turnAnchor(sessionId, messages, now)

    if (!verdict.stable) {
      return []
    }

    const lastUser = messages.findLastIndex(message => message.role === 'user')

    if (lastUser < 0) {
      return []
    }

    let spoken = resolveSpokenReply(sessionId, messages)

    // 同 pendingResponse：进程刚起没念过、锚点却是刚到的 → 锚点之前标已念。
    if (!spoken && turnAnchorIsFresh(messages, now)) {
      const before = messages.slice(0, lastUser).findLast(message => message.role === 'assistant' && !message.hidden && speakTextOf(message))

      if (before) {
        markAssistantIdSpoken(sessionId, messages, before.id)
        spoken = resolveSpokenReply(sessionId, messages)
      }
    }

    // liveTail：只认新鲜助手行；旧行（回放重放的历史）滤掉。
    const source = verdict.liveTail
      ? messages.filter(message => message.role === 'assistant' && !message.hidden && isFreshRow(message, now))
      : messages.slice(lastUser + 1).filter(message => message.role === 'assistant' && !message.hidden)

    const unspoken = collectUnspokenTurnSpeech(source, spoken?.id ?? null)

    if (!unspoken) {
      return []
    }

    const bubbles = source
      .map(message => ({ sealed: !message.pending, text: speakTextOf(message) }))
      .filter(bubble => bubble.text)

    return takeQueue(sessionId, bubbles, now).map(item => item.chunk)
  }

  it('boot snapshot + event replay: nothing of the old transcript is re-spoken (11:21 事故)', () => {
    const s = 's1'
    const now = 1_800_000 // 秒

    const morning = [
      user('u1', '读取桌面上的问题描述。', { timestamp: now - 4_000 }),
      assistant('a1', '继续。先按文档第五节的顺序来，这一段是昨晚写的长分析。'),
      user('u2', '昨天的提交都是什么？', { timestamp: now - 3_000 }),
      assistant('a2', '一共五个提交，桌面端一个、语音栈四个，都推上去了。')
    ]

    // ---- 重启第一帧：完整历史，锚点是旧的 → 静音。----
    expect(pipeline(s, morning, now * 1000)).toEqual([])

    // ---- 新的一轮：用户行新鲜 → 放行，流式两段照念。----
    const turn = [
      ...morning,
      user('u3', '说一次五段试试。', { timestamp: now }),
      assistant('a3', '第一段：上午的光从百叶窗斜进来，正好落在键盘左边。'),
      assistant('a4', '第二段：烧水壶刚跳了闸，屋里的声音一下子少了。')
    ]

    expect(pipeline(s, turn, (now + 5) * 1000)).toEqual([
      '第一段：上午的光从百叶窗斜进来，正好落在键盘左边。',
      '第二段：烧水壶刚跳了闸，屋里的声音一下子少了。'
    ])

    // ---- 转录被滞后快照替换（锚点退回旧用户行）→ 静音。----
    expect(pipeline(s, morning, (now + 8) * 1000)).toEqual([])

    // ---- 重放逐条补行：补到哪一轮，锚点都是旧行 → 全程静音。----
    const replay1 = [...morning, user('u3', '说一次五段试试。', { timestamp: now })]
    expect(pipeline(s, replay1, (now + 12) * 1000)).toEqual([])
    const replay2 = [...replay1, assistant('a3', '第一段：上午的光从百叶窗斜进来，正好落在键盘左边。')]
    expect(pipeline(s, replay2, (now + 13) * 1000)).toEqual([])

    // ---- 重放补回当前轮的助手行：锚点 == 当前轮 → 放行，但已念部分被队列挡住。----
    const replay3 = [...replay2, assistant('a4', '第二段：烧水壶刚跳了闸，屋里的声音一下子少了。')]
    expect(pipeline(s, replay3, (now + 14) * 1000)).toEqual([])
  })

  it('mid-session replace (22:33 事故): stale anchor is muted, only new deltas speak', () => {
    const s = 's1'
    const t0 = 2_000_000

    const t1 = [
      '第一段：楼下那只猫今晚蹲在车顶上，尾巴垂着没动。',
      '第二段：厨房的老抽快见底了，倒出来时声音变了。',
      '第三段：充电线的插头有点松，得按着才进电。',
      '第四段：阳台的绿植该挪进来过夜了，外面有风。',
      '第五段收尾：这轮顺利的话，我把改动提交进仓库。'
    ]

    const turn1 = [
      user('u1', '说一次五段试试。', { timestamp: t0 }),
      assistant('a1', t1[0]),
      assistant('a2', t1[1]),
      assistant('a3', t1[2]),
      assistant('a4', t1[3]),
      assistant('a5', t1[4])
    ]

    expect(pipeline(s, turn1, t0 * 1000)).toEqual(t1)
    markAssistantIdSpoken(s, turn1, 'a5')

    // ---- 120 秒后新一轮（措辞全新），流两段。----
    const t2 = ['第一段：楼道里的声控灯今晚只亮了一半。', '第二段：冰箱门上的磁贴换了新的。']

    const turn2Start = [
      ...turn1,
      user('u2', '再说一次五段试试。', { timestamp: t0 + 120 }),
      assistant('a6', t2[0]),
      assistant('a7', t2[1])
    ]

    expect(pipeline(s, turn2Start, (t0 + 120) * 1000)).toEqual(t2)

    // ---- 换轮瞬间转录被替换：锚点退回 u1（2 分钟前，≠当前轮）→ 静音。----
    expect(pipeline(s, turn1, (t0 + 125) * 1000)).toEqual([])
    expect(pipeline(s, turn1, (t0 + 130) * 1000)).toEqual([])

    // ---- 恢复：锚点 == 当前轮 → 放行，只送未念的增量。----
    const turn2End = [...turn2Start, assistant('a8', '第三段：书桌底下的接线板积了灰，顺手擦了一遍。')]

    expect(pipeline(s, turn2End, (t0 + 140) * 1000)).toEqual([
      '第三段：书桌底下的接线板积了灰，顺手擦了一遍。'
    ])

    // ---- 重放把当前轮的用户行晚 45 秒补回来：时间戳超窗，但 == 当前轮 → 放行。----
    const replayedAnchor = [
      ...turn1,
      user('u2', '再说一次五段试试。', { timestamp: t0 + 120 }),
      assistant('a6', t2[0]),
      assistant('a7', t2[1]),
      assistant('a8', '第三段：书桌底下的接线板积了灰，顺手擦了一遍。')
    ]

    expect(pipeline(s, replayedAnchor, (t0 + 165) * 1000)).toEqual([])
  })

  it('renderer restart mid-turn: fresh auto-continue row accepts, but the old narration is swallowed (11:39 事故)', () => {
    const s = 's1'
    const t0 = 3_000_000

    const turnSoFar = [
      user('u_old', '读取桌面上的问题描述，今天继续处理这个问题。', { timestamp: t0 - 600 }),
      assistant('a1', '闸起效了但暴露出新事实：滞后快照不是亚秒级闪断。'),
      assistant('a2', '关键时间线拿到了：替换窗口持续三十七秒以上。')
    ]

    // ---- 新渲染进程：旧锚点帧全部静音。----
    expect(pipeline(s, turnSoFar, t0 * 1000)).toEqual([])

    // ---- 重放插入 auto-continue 用户行（新鲜时间戳）→ 放行；空标记 + 新鲜锚点
    // 把锚点之前的旁白标掉：跨进程不重念。----
    const acFrame = [...turnSoFar, user('u_ac', '（自动继续）', { timestamp: t0 + 5, hidden: true })]
    expect(pipeline(s, acFrame, (t0 + 5) * 1000)).toEqual([])

    // ---- 新旁白落地：只念锚点之后的新内容。----
    const next = [...acFrame, assistant('a3', '补最后一刀：锚点新鲜且本进程没念过，就把之前的内容标成已念。')]
    expect(pipeline(s, next, (t0 + 8) * 1000)).toEqual([
      '补最后一刀：锚点新鲜且本进程没念过，就把之前的内容标成已念。'
    ])

    // ---- 再来一帧滞后快照（锚点退回 u_old）→ 静音。----
    expect(pipeline(s, turnSoFar, (t0 + 12) * 1000)).toEqual([])
  })

  it('store drops the current turn user row: live narration survives via liveTail (13:35 事故)', () => {
    const s = 's1'
    const t0 = 4_000_000

    // 当前回合已被 latched 成 current（13:24 的「重启了」帧）。
    const currentTurn = user('u_cur', '重启了。', { timestamp: t0 })
    const liveFrame = [currentTurn, assistant('a1', '连上了（十三点二十三分五十八秒）。', { timestamp: t0 + 2 })]

    expect(pipeline(s, liveFrame, (t0 + 2) * 1000)).toEqual(['连上了（十三点二十三分五十八秒）。'])
    markAssistantIdSpoken(s, liveFrame, 'a1')

    // ---- 引导快照把当前轮的用户行 + 旁白整批弄丢：锚点退回上轮（8 分钟前）。
    // 同时本回合的新旁白（新鲜时间戳）仍在入场 → liveTail 放行新鲜行、滤掉旧行。----
    const snapshot = [
      user('u_prev', '重新说一遍五段。', { timestamp: t0 - 500 }),
      assistant('a_prev', 'D 轮的旧回答，时间戳老，不该再念。', { timestamp: t0 - 480 }),
      assistant('a_new', '第一段：门口的地垫换了新位置。', { timestamp: t0 + 6 })
    ]

    expect(pipeline(s, snapshot, (t0 + 7) * 1000)).toEqual(['第一段：门口的地垫换了新位置。'])

    // 快照里只有旧行（活尾巴还没到）→ 静音，不重念历史。
    expect(
      pipeline(
        s,
        [
          user('u_prev', '重新说一遍五段。', { timestamp: t0 - 500 }),
          assistant('a_prev', 'D 轮的旧回答，时间戳老，不该再念。', { timestamp: t0 - 480 })
        ],
        (t0 + 9) * 1000
      )
    ).toEqual([])
  })
})
