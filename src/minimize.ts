import { simulate } from './engine';
import { outcomeEqual } from './regression';
import type { Rule, Simulation } from './types';

/** 无法缩减的原因：输入 URL 非法 / 原始模拟没有任何规则命中 */
export type MinimizeFailureReason = 'invalid-url' | 'no-hit';

/** 缩减成功的报告：所有引用的规则都来自生成时冻结的同一份规则快照 */
export interface MinimizeReport {
  /** 冻结的请求方法（已转大写） */
  method: string;
  /** 冻结的请求 URL（原文） */
  url: string;
  /** 生成时刻（ISO 时间戳，仅用于展示） */
  frozenAt: string;
  /** 完整规则表深拷贝快照（含停用规则，原顺序）；之后编辑不影响本报告 */
  rules: Rule[];
  /** 缩减前：完整规则表上的原始模拟 */
  original: Simulation;
  /** 缩减后：剔除被删除规则后的完整模拟（轨迹允许与原始不同） */
  minimized: Simulation;
  /** 保留下来的启用规则（保持在快照中的相对顺序） */
  kept: Rule[];
  /** 被剔除的启用规则（按试探中接受删除的先后顺序排列） */
  removed: Rule[];
  /** 未参与试探的停用规则（原相对顺序；始终留在试探规则表中，对模拟无影响） */
  disabled: Rule[];
  /** 完整模拟总次数：首次原始模拟 + 每次删除试探 + 缩减后复跑 */
  trials: number;
}

export type MinimizeOutcome =
  | { ok: true; report: MinimizeReport }
  | { ok: false; reason: MinimizeFailureReason; original: Simulation };

/**
 * 用「保留下来的启用规则在快照中的下标」构造试探规则表：
 * 剔除被删除的启用规则，其余规则（含停用规则）保持快照中的原始位置，
 * 然后从头完整模拟一次——每次试探都重新模拟，允许命中轨迹发生变化
 * （避免重写后首命中转移却仍给出相同可观察结果时被误判）。
 */
function buildTrialRules(snapshot: Rule[], keptIdx: ReadonlySet<number>): Rule[] {
  return snapshot.filter((rule, i) => !rule.enabled || keptIdx.has(i));
}

/**
 * 请求最小复现：在完整规则表上找到仍能复现同一可观察结果的最小（1-最小）启用规则子集。
 *
 * 流程：
 * 1. 深拷贝规则表、方法与 URL（冻结输入），用 {@link simulate} 跑原始模拟；
 *    原始模拟 URL 非法（invalid-url）或没有任何规则命中时直接判定无法缩减。
 * 2. 对启用规则按原顺序做分块删除试探：块长从「当前保留数的一半（向上取整）」
 *    开始，一轮无删除就减半，块长降到 1 后进入逐条复核；接受删除的块整块剔除。
 * 3. 逐条复核：逐条尝试单条删除，可观察结果不变就剔除，并从头再来一轮，
 *    直到任意单条删除都会改变可观察结果（1-最小）。
 *
 * 可观察结果是否一致复用回归对比的 {@link outcomeEqual}：终止类型必须相同，
 * final 比较最终 URL，redirect 比较状态码与 Location，stopped 与各类失败只比较终止类型。
 */
export function minimizeRules(
  rules: Rule[],
  method: string,
  url: string,
): MinimizeOutcome {
  // 生成时冻结：完整规则表深拷贝，之后编辑不影响本次结果
  const snapshot = structuredClone(rules);
  const m = method.toUpperCase();
  const original = simulate(snapshot, m, url);
  let trials = 1;

  if (original.status === 'invalid-url') {
    return { ok: false, reason: 'invalid-url', original };
  }
  if (original.steps.length === 0) {
    return { ok: false, reason: 'no-hit', original };
  }

  const disabled = snapshot.filter((r) => !r.enabled);
  // 候选只含启用规则；用其在快照中的下标跟踪，避免依赖 rule.id 唯一
  let keptIdx = snapshot
    .map((_, i) => i)
    .filter((i) => snapshot[i].enabled);
  const removed: Rule[] = [];

  const preserved = (keep: ReadonlySet<number>): boolean => {
    trials += 1;
    return outcomeEqual(original, simulate(buildTrialRules(snapshot, keep), m, url));
  };

  // 第 1 阶段：分块删除试探（按原顺序切连续块，逐块试探，块长至少为 2）
  let chunkSize = Math.max(2, Math.ceil(keptIdx.length / 2));
  while (chunkSize >= 2 && keptIdx.length >= 2) {
    let progressed = false;
    let i = 0;
    while (i < keptIdx.length) {
      const chunk = keptIdx.slice(i, i + chunkSize);
      if (chunk.length < 2) break; // 末尾不足一块的单条留给逐条复核
      const keep = new Set(keptIdx);
      for (const idx of chunk) keep.delete(idx);
      if (preserved(keep)) {
        // 整块可删：接受删除，下标 i 不前进（下一块自然滑入）
        removed.push(...chunk.map((idx) => snapshot[idx]));
        keptIdx.splice(i, chunk.length);
        progressed = true;
      } else {
        i += chunk.length;
      }
    }
    // 有删除就按缩小后的保留集重新切块；否则缩小块长继续试探
    chunkSize = progressed
      ? Math.max(2, Math.ceil(keptIdx.length / 2))
      : Math.floor(chunkSize / 2);
  }

  // 第 2 阶段：逐条复核，直到任意单条删除都会改变可观察结果
  let progressed = true;
  while (progressed) {
    progressed = false;
    let i = 0;
    while (i < keptIdx.length) {
      const keep = new Set(keptIdx);
      keep.delete(keptIdx[i]);
      if (preserved(keep)) {
        removed.push(snapshot[keptIdx[i]]);
        keptIdx.splice(i, 1);
        progressed = true;
      } else {
        i += 1;
      }
    }
  }

  // 缩减后的完整模拟（与保留集严格对应，供展示缩减后轨迹）
  const finalKeep = new Set(keptIdx);
  trials += 1;
  const minimized = simulate(buildTrialRules(snapshot, finalKeep), m, url);

  return {
    ok: true,
    report: {
      method: m,
      url,
      frozenAt: new Date().toISOString(),
      rules: snapshot,
      original,
      minimized,
      kept: keptIdx.map((i) => snapshot[i]),
      removed,
      disabled,
      trials,
    },
  };
}
