/**
 * goal-metrics.js — 目标完成度的纯计算（无 DOM、无 store 依赖，便于单测）
 *
 * 为什么单独成文件：达标口径曾经混用"作答次数"和"卡片数"，
 * 导致界面出现"还差几十张 / 待复习 0"这种永远补不齐的账。
 * 把这条算术抽成纯函数，才能在离线 CI 里锁死它。
 */

/**
 * @param {{doneCards:number, dueNow:number, doneNew:number, newGoal:number,
 *          needTest:boolean, testDone:boolean, isRest:boolean,
 *          pausedNew:boolean, dailyMax:number}} o
 * @returns {{dueToday:number, goalReviews:number, reviewMet:boolean, parts:number[], pct:number}}
 */
export function goalCompletion(o) {
  const doneCards = Math.max(0, Number(o && o.doneCards) || 0)
  const dueNow = Math.max(0, Number(o && o.dueNow) || 0)
  const doneNew = Math.max(0, Number(o && o.doneNew) || 0)
  const newGoal = Math.max(0, Number(o && o.newGoal) || 0)
  const dailyMax = Math.max(0, Number(o && o.dailyMax) || 0)

  /* 分母 = 今天已复习的卡 + 此刻仍到期的卡。
     卡片被 FSRS 推到明天后 dueNow 归零，分母自动收缩到 doneCards，当天即闭合。 */
  const dueToday = doneCards + dueNow
  const goalReviews = dailyMax ? Math.min(dailyMax, Math.max(dueToday, doneCards)) : dueToday

  const parts = [goalReviews ? Math.min(1, doneCards / goalReviews) : 1]
  if (!o.isRest && !o.pausedNew) parts.push(newGoal ? Math.min(1, doneNew / newGoal) : 1)
  if (o.needTest) parts.push(o.testDone ? 1 : 0)

  const pct = Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100)
  return { dueToday, goalReviews, reviewMet: dueNow === 0, parts, pct }
}
