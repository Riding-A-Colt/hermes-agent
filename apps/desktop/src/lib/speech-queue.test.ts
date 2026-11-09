import { afterEach, describe, expect, it } from 'vitest'

import { clearSpeechQueueForTests, readQueueEntry, takeQueue } from './speech-queue'

const S = 'session-under-test'

const S1 = '第一段：回来的时候电梯正好在检修，只能走楼梯上来。'
const S2 = '第二段：桌上的水杯空了一下午，忘了倒水。'
const S3 = '第三段：阳台外面风大了，晾的毛巾被吹到栏杆上。'
const S4 = '第四段：冰箱门上那张便利贴该撕了，字都看不清。'

const b = (text: string, sealed = false) => ({ sealed, text })
const spoken = (items: { chunk: string }[]) => items.map(item => item.chunk)

/**
 * 每一条都对应 2026-11-08 真实日志里的一次失败。队列的输入是**这一轮的气泡列表**，
 * 不是跨轮拼起来的整段——「范围会自己变大」这件事从结构上就不该发生。
 */
describe('takeQueue — 气泡级入队', () => {
  afterEach(() => {
    clearSpeechQueueForTests()
  })

  it('20:35 整段重念：存储越积越长，队列只按气泡发，各一遍', () => {
    // 当时客户端送出的文本一路涨到 439 字，随后从中间重念了整个后半段
    expect(spoken(takeQueue(S, [b(S1), b(S2)]))).toEqual([S1, S2])

    expect(spoken(takeQueue(S, [b(S1), b(S2), b(S3)]))).toEqual([S3])
    expect(spoken(takeQueue(S, [b(S1), b(S2), b(S3), b(S4)]))).toEqual([S4])
  })

  it('封口只剩最后一段：不重念', () => {
    takeQueue(S, [b(S1), b(S2), b(S3, true)])

    expect(spoken(takeQueue(S, [b(S3, true)]))).toEqual([])
  })

  it('同一段被读了两次（短的那次在前）：不叠字', () => {
    // 实测念出「第三第三段,」：先送「第三段：阳台」，下一帧送回整段
    expect(spoken(takeQueue(S, [b('第三段：阳台')]))).toEqual(['第三段：阳台'])
    expect(spoken(takeQueue(S, [b(S3)]))).toEqual(['外面风大了，晾的毛巾被吹到栏杆上。'])
  })

  it('气泡被折叠隐藏后又出现：不重念', () => {
    takeQueue(S, [b(S1), b(S2)])

    // 工具调用把第一段折走了，只剩第二段
    expect(spoken(takeQueue(S, [b(S2)]))).toEqual([])

    // 折叠展开，两段又都在
    expect(spoken(takeQueue(S, [b(S1), b(S2)]))).toEqual([])
  })

  it('流式增长：每帧只发新增的字', () => {
    expect(spoken(takeQueue(S, [b('第一段：回来的时候')]))).toEqual(['第一段：回来的时候'])
    expect(spoken(takeQueue(S, [b('第一段：回来的时候电梯正好在检修')]))).toEqual(['电梯正好在检修'])
    expect(spoken(takeQueue(S, [b('第一段：回来的时候电梯正好在检修')]))).toEqual([])
  })

  it('新的一条气泡从零开始，不受上一条影响', () => {
    takeQueue(S, [b(S1)])

    expect(spoken(takeQueue(S, [b(S1), b(S2)]))).toEqual([S2])
  })

  it('文本被改写（不是变长）：不重发已经念过的前半截', () => {
    takeQueue(S, [b('第一段：回来的时候电梯在检修')])

    expect(spoken(takeQueue(S, [b('第一段：回来的时候电梯在检修，只能走楼梯。')]))).toEqual(['，只能走楼梯。'])
  })

  it('记录能查到：同一条气泡的已送字数', () => {
    takeQueue(S, [b(S1)])

    expect(readQueueEntry(S1)?.sent).toBe(S1.length)
    expect(readQueueEntry(S1)?.text).toBe(S1)
  })

  // 队列不再按「换轮」清空（任何轮凭据在一轮内都会变，一变就重念整段）。
  // 记录只在闲置 TTL 过期后失效：隔几分钟再要同样的内容会重新开口。
  it('同一句话在同一轮里反复出现：只念一遍（四次重读折腾也一样）', () => {
    expect(spoken(takeQueue(S, [b(S3)]))).toEqual([S3])

    for (const again of [S3, ` ${S3}`, S3.slice(0, 10), S3]) {
      expect(spoken(takeQueue(S, [b(again.trim())]))).toEqual([])
    }
  })

  it('TTL 过期后同样的内容会重新开口', () => {
    expect(spoken(takeQueue(S, [b(S4)]))).toEqual([S4])

    // 10 分钟后再来同样的字，视为新一轮
    expect(spoken(takeQueue(S, [b(S4)], Date.now() + 11 * 60_000))).toEqual([S4])
  })

  // 21:33 实测：第二、三段各念两遍——气泡文字被中途改写（开头的「第二段：」
  // 被折叠掉），按开头认不出，当成新气泡整段重发。
  it('气泡文字被改写后（少了开头的「第二段：」）：不重念', () => {
    expect(spoken(takeQueue(S, [b(S2)]))).toEqual([S2])

    const rewritten = S2.replace('第二段：', '')

    expect(spoken(takeQueue(S, [b(rewritten)]))).toEqual([])
    expect(spoken(takeQueue(S, [b(S2)]))).toEqual([])
  })

  // 22:00 实测：hydration 重排后在行首补了空白，同一段按开头比对认丢，整段重念。
  it('带上多余空白的重读：还是同一段，不重念', () => {
    expect(spoken(takeQueue(S, [b(S2), b(S3)]))).toEqual([S2, S3])

    expect(spoken(takeQueue(S, [b(` ${S2}`), b(`\n\n${S3} `)]))).toEqual([])
  })

  // 2026-11-09 13:26 实测：流式五段各一条账（每条已念），封口时水合把整轮折成
  // 一个 124 字大气泡——折叠尾巴（段二到段五）由「已念条目按序拼出」，判覆盖不重念。
  it('折叠尾巴（已念条目按序拼出）：不重念，真正的新增长照念', () => {
    takeQueue(S, [b(S1), b(S2), b(S3), b(S4)])

    // 水合折叠：整轮四段连写成一个气泡
    expect(spoken(takeQueue(S, [b(`${S1}${S2}${S3}${S4}`)]))).toEqual([])

    // 折叠气泡上再长出没念过的新字：照念
    expect(spoken(takeQueue(S, [b(`${S1}${S2}${S3}${S4}锦上添花的一句收尾。`)])))
      .toEqual(['锦上添花的一句收尾。'])
  })

  // 2026-11-09 12:55 实测：换轮把锚点挪进轮中间，收取文本从第二段开始——聚合态
  // 由已念条目按序拼出（空行分隔也容忍），不重念。
  it('聚合收取（从段二开始的整段）：由已念条目拼出，不重念', () => {
    takeQueue(S, [b(S1), b(S2), b(S3), b(S4)])

    expect(spoken(takeQueue(S, [b(`${S2}\n\n${S3}\n\n${S4}`)]))).toEqual([])
  })

  it('流式开头太短：先不入账，长过门槛后整段只念一遍', () => {
    expect(spoken(takeQueue(S, [b('第一段')]))).toEqual([])

    expect(spoken(takeQueue(S, [b('第一段：书架顶层那本字典漆掉了皮，翻起来咯吱响。')])))
      .toEqual(['第一段：书架顶层那本字典漆掉了皮，翻起来咯吱响。'])

    expect(spoken(takeQueue(S, [b('第一段：书架顶层那本字典漆掉了皮，翻起来咯吱响。')])))
      .toEqual([])
  })

  it('短但已定稿的短句是正文：照念', () => {
    expect(spoken(takeQueue(S, [b('好的', true)]))).toEqual(['好的'])
    expect(spoken(takeQueue(S, [b('好的', true)]))).toEqual([])
  })
})
