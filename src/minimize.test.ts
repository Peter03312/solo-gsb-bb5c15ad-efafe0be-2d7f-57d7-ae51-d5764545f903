import { describe, expect, it } from 'vitest';
import { minimizeRules } from './minimize';
import type { Rule } from './types';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    query: [],
    action: { type: 'rewrite', target: '/', status: 302 },
    ...partial,
  };
}

const URL_A = 'http://example.com/a';
const URL_INVALID = 'not a url';

describe('minimizeRules（无法缩减的情形）', () => {
  it('URL 非法时返回 invalid-url 与原始模拟，不剔除任何规则', () => {
    const rules = [
      rule({ id: 'r1', action: { type: 'rewrite', target: '/b', status: 302 } }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_INVALID);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid-url');
    expect(outcome.original.status).toBe('invalid-url');
  });

  it('没有任何规则命中（无轨迹）时返回 no-hit', () => {
    const rules = [
      rule({ id: 'r1', host: 'other.com', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no-hit');
    expect(outcome.original.status).toBe('final');
    expect(outcome.original.steps).toHaveLength(0);
  });

  it('空规则表视为无命中', () => {
    const outcome = minimizeRules([], 'GET', URL_A);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('no-hit');
  });
});

describe('minimizeRules（保留与剔除）', () => {
  it('唯一命中规则不可剔除：保留 1 条、剔除 0 条', () => {
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { report } = outcome;
    expect(report.kept.map((r) => r.id)).toEqual(['r1']);
    expect(report.removed).toHaveLength(0);
    expect(report.minimized.status).toBe('stopped');
    expect(report.original.status).toBe('stopped');
  });

  it('删除不影响可观察结果的无关规则：链路前置规则与不相关规则都被剔除', () => {
    const rules = [
      rule({ id: 'dead-before', host: 'nope.com', action: { type: 'stop', target: '', status: 302 } }),
      rule({
        id: 'r1',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/b', status: 302 },
      }),
      rule({
        id: 'r2',
        pathTemplate: '/b',
        action: { type: 'rewrite', target: '/c', status: 302 },
      }),
      rule({
        id: 'dead-after',
        pathTemplate: '/zzz',
        action: { type: 'stop', target: '', status: 302 },
      }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(outcome.report.removed.map((r) => r.id).sort()).toEqual([
      'dead-after',
      'dead-before',
    ]);
    expect(outcome.report.minimized.finalUrl).toBe('http://example.com/c');
    expect(outcome.report.minimized.finalUrl).toBe(outcome.report.original.finalUrl);
  });

  it('只改变命中轨迹、不改最终 URL 时允许剔除（轨迹可完全不同）', () => {
    const rules = [
      // shortcut 一条把 /a 直接重写到 /c；mid1+mid2 链路同样能把 /a 带到 /c
      rule({
        id: 'shortcut',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/c', status: 302 },
      }),
      rule({
        id: 'mid1',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/b', status: 302 },
      }),
      rule({
        id: 'mid2',
        pathTemplate: '/b',
        action: { type: 'rewrite', target: '/c', status: 302 },
      }),
    ];
    const original = minimizeRules(rules, 'GET', URL_A);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    // 原始轨迹只有 shortcut 一步；删掉它后 mid1+mid2 链路接管，最终 URL 仍是 /c
    expect(original.report.original.steps.map((s) => s.rule.id)).toEqual(['shortcut']);
    expect(original.report.kept.map((r) => r.id)).toEqual(['mid1', 'mid2']);
    expect(original.report.removed.map((r) => r.id)).toEqual(['shortcut']);
    expect(original.report.minimized.steps.map((s) => s.rule.id)).toEqual(['mid1', 'mid2']);
    expect(original.report.minimized.finalUrl).toBe('http://example.com/c');
    expect(original.report.minimized.finalUrl).toBe(original.report.original.finalUrl);

    // 没有 shortcut 时，mid1+mid2 两条都必须保留
    const chained = minimizeRules([rules[1], rules[2]], 'GET', URL_A);
    expect(chained.ok).toBe(true);
    if (!chained.ok) return;
    expect(chained.report.kept.map((r) => r.id)).toEqual(['mid1', 'mid2']);
    expect(chained.report.removed).toHaveLength(0);
    expect(chained.report.minimized.finalUrl).toBe('http://example.com/c');
  });

  it('重写后首命中转移场景：删除轨迹上的规则后由后序规则接管但结果相同，仍然剔除', () => {
    const rules = [
      // 原始轨迹：r1（/a→/b）后命中 r3（/b→/c，排在 r2 前遮蔽它）；
      // 删除 r3 后 /b 由 r2 接管，同样到 /c
      rule({
        id: 'r1',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/b', status: 302 },
      }),
      rule({
        id: 'r3',
        pathTemplate: '/b',
        action: { type: 'rewrite', target: '/c', status: 302 },
      }),
      rule({
        id: 'r2',
        pathTemplate: '/b',
        action: { type: 'rewrite', target: '/c', status: 302 },
      }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // r3 在原始轨迹上（遮蔽 r2），但删掉它由 r2 接管，可观察结果不变 → 剔除 r3
    expect(outcome.report.original.steps.map((s) => s.rule.id)).toEqual(['r1', 'r3']);
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(outcome.report.removed.map((r) => r.id)).toEqual(['r3']);
    // 缩减后轨迹的首命中发生了转移：/b 上改由 r2 生效
    expect(outcome.report.minimized.steps.map((s) => s.rule.id)).toEqual(['r1', 'r2']);
  });

  it('redirect 结果：状态码或 Location 改变则规则必须保留', () => {
    const rules = [
      rule({
        id: 'r1',
        pathTemplate: '/a',
        action: { type: 'redirect', target: 'https://n.com/x', status: 301 },
      }),
      rule({
        id: 'r2',
        pathTemplate: '/a',
        action: { type: 'redirect', target: 'https://n.com/y', status: 302 },
      }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['r1']);
    expect(outcome.report.minimized.status).toBe('redirect');
    expect(outcome.report.minimized.redirectStatus).toBe(301);
    expect(outcome.report.minimized.redirectLocation).toBe('https://n.com/x');
  });

  it('stopped 只比较终止类型：由另一条 stop 规则接管时原规则可剔除', () => {
    const rules = [
      rule({ id: 's1', pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } }),
      rule({ id: 's2', pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // s1 命中；删除 s1 后 s2 接管，终止类型仍是 stopped → s1 可删
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['s2']);
    expect(outcome.report.minimized.status).toBe('stopped');
  });

  it('失败类型（loop）只比较终止类型：另一条规则造成同样循环时可剔除', () => {
    const rules = [
      rule({ id: 'loop1', pathTemplate: '/a', action: { type: 'rewrite', target: '/a', status: 302 } }),
      rule({ id: 'loop2', pathTemplate: '/a', action: { type: 'rewrite', target: '/a', status: 302 } }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.original.status).toBe('loop');
    expect(outcome.report.minimized.status).toBe('loop');
    expect(outcome.report.kept).toHaveLength(1);
  });

  it('终态不同（stopped vs final）不可剔除', () => {
    const rules = [
      rule({ id: 's1', pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['s1']);
  });
});

describe('minimizeRules（停用规则与冻结快照）', () => {
  it('停用规则不参与试探，原样列入 disabled，也不出现在导出的保留集中', () => {
    const rules = [
      rule({ id: 'on1', pathTemplate: '/a', action: { type: 'stop', target: '', status: 302 } }),
      rule({
        id: 'off1',
        enabled: false,
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/b', status: 302 },
      }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['on1']);
    expect(outcome.report.disabled.map((r) => r.id)).toEqual(['off1']);
    expect(outcome.report.removed.map((r) => r.id)).not.toContain('off1');
  });

  it('生成时冻结输入：生成后修改规则表不影响报告', () => {
    const rules = [
      rule({
        id: 'r1',
        pathTemplate: '/a',
        action: { type: 'rewrite', target: '/b', status: 302 },
      }),
      rule({
        id: 'r2',
        pathTemplate: '/b',
        action: { type: 'rewrite', target: '/c', status: 302 },
      }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    rules[0].action.target = '/hijacked';
    rules[1].enabled = false;
    expect(outcome.report.rules[0].action.target).toBe('/b');
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(outcome.report.minimized.finalUrl).toBe('http://example.com/c');
  });

  it('保留规则保持原始相对顺序', () => {
    const rules = [
      rule({ id: 'a', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'drop1', host: 'nope.com', action: { type: 'stop', target: '', status: 302 } }),
      rule({ id: 'b', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
      rule({ id: 'drop2', host: 'nope2.com', action: { type: 'stop', target: '', status: 302 } }),
      rule({ id: 'c', pathTemplate: '/c', action: { type: 'stop', target: '', status: 302 } }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(outcome.report.trials).toBeGreaterThanOrEqual(3);
  });

  it('结果是 1-最小：单条删除任意保留规则都会改变可观察结果', () => {
    // 构造 5 条全部必要的链路规则（不同路径模板，无法互相接管）
    const rules = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
      rule({ id: 'r3', pathTemplate: '/c', action: { type: 'rewrite', target: '/d', status: 302 } }),
      rule({ id: 'r4', pathTemplate: '/d', action: { type: 'rewrite', target: '/e', status: 302 } }),
      rule({ id: 'r5', pathTemplate: '/e', action: { type: 'rewrite', target: '/f', status: 302 } }),
    ];
    const outcome = minimizeRules(rules, 'GET', URL_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.kept.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(outcome.report.removed).toHaveLength(0);
    expect(outcome.report.minimized.finalUrl).toBe('http://example.com/f');
  });
});
