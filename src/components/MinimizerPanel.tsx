import { useMemo, useState } from 'react';
import type { Rule, Simulation } from '../types';
import { minimizeRules, type MinimizeOutcome, type MinimizeReport } from '../minimize';
import { StepCard } from './TraceView';

const ACTION_LABEL: Record<Rule['action']['type'], string> = {
  rewrite: '重写',
  redirect: '重定向',
  stop: '停止',
};

/** 一侧的可观察结果：终止类型 + 该类型对应的可观察字段（不展示原因文案） */
function OutcomeView({ sim }: { sim: Simulation }) {
  return (
    <div className="outcome">
      <div className="outcome-head">
        <span className={`tag status-${sim.status}`}>{sim.status}</span>
        <span className="outcome-steps">{sim.steps.length} 步</span>
      </div>
      {sim.status === 'final' && <code className="url-to">{sim.finalUrl}</code>}
      {sim.status === 'redirect' && (
        <span className="outcome-redirect">
          {sim.redirectStatus} → <code className="url-to">{sim.redirectLocation}</code>
        </span>
      )}
    </div>
  );
}

/** 规则引用：快照中的序号（1 起）、名称、动作与匹配条件摘要 */
function RuleRef({ index, rule, tag }: { index: number; rule: Rule; tag?: string }) {
  return (
    <div className="mz-rule">
      <span className="cov-rule-order">#{index + 1}</span>
      <span className="pi-rule-name">{rule.name}</span>
      <span className={`tag action-${rule.action.type}`}>
        {ACTION_LABEL[rule.action.type]}
      </span>
      <code className="mz-rule-cond">
        {rule.method} · {rule.host.trim() === '' ? '（任意主机）' : rule.host} ·{' '}
        {rule.pathTemplate.trim() === '' ? '（任意路径）' : rule.pathTemplate}
      </code>
      {tag && <span className="tag tag-same">{tag}</span>}
    </div>
  );
}

/** 一侧轨迹：完整步骤 + 终止结果 */
function TraceColumn({ title, sim }: { title: string; sim: Simulation }) {
  return (
    <div className="trace-col">
      <h4>{title}</h4>
      {sim.steps.length === 0 && <p className="empty">（无命中步骤）</p>}
      {sim.steps.map((s) => (
        <StepCard key={s.n} step={s} />
      ))}
      <p className="cov-reason">{sim.reason}</p>
      <OutcomeView sim={sim} />
    </div>
  );
}

function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString();
}

/** 下载仅含保留规则的 JSON（与规则表「导出 JSON」完全相同的导入格式） */
function downloadKeptRules(report: MinimizeReport) {
  const blob = new Blob([JSON.stringify(report.kept, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'url-rules-minimized.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function ReportView({ report }: { report: MinimizeReport }) {
  // 快照序号（0 起）：保留集在完整规则表中的原始位置（同一快照中规则对象唯一）
  const indexOf = new Map(report.rules.map((r, i) => [r, i]));
  return (
    <div className="mz-report">
      <div className="mz-summary">
        <span className="tag tag-same">保留 {report.kept.length} 条</span>
        <span className="tag tag-changed">剔除 {report.removed.length} 条</span>
        {report.disabled.length > 0 && (
          <span className="tag cov-tag-off">停用 {report.disabled.length} 条（未参与）</span>
        )}
        <span className="mz-trials">共完整模拟 {report.trials} 次</span>
      </div>

      <h4 className="mz-list-title">保留规则（{report.kept.length} 条，原顺序）</h4>
      {report.kept.map((r) => {
        const i = indexOf.get(r) ?? 0;
        return <RuleRef key={`k-${i}`} index={i} rule={r} />;
      })}

      <h4 className="mz-list-title">剔除规则（{report.removed.length} 条）</h4>
      {report.removed.length === 0 ? (
        <p className="empty">没有规则可剔除：任意单条删除都会改变该请求的可观察结果。</p>
      ) : (
        report.removed.map((r) => {
          const i = indexOf.get(r) ?? 0;
          return <RuleRef key={`r-${i}`} index={i} rule={r} tag="已剔除" />;
        })
      )}

      <div className="mz-traces-head">
        <h4 className="mz-list-title">缩减前后轨迹</h4>
        <button className="primary" onClick={() => downloadKeptRules(report)}>
          下载保留规则 JSON
        </button>
      </div>
      <p className="baseline-info">
        两侧终止类型与可观察结果一致（final 比最终 URL，redirect 比状态码与 Location，
        其余类型只比终止类型）；命中轨迹允许不同——这正是逐条删除试探时每次都重新
        完整模拟的原因。下载的 JSON 与规则表「导入 JSON」格式一致，仅含保留规则
        （保持原顺序与启停状态），可直接导入验证。
      </p>
      <div className="trace-cols">
        <TraceColumn
          title={`缩减前轨迹（${report.original.steps.length} 步）`}
          sim={report.original}
        />
        <TraceColumn
          title={`缩减后轨迹（${report.minimized.steps.length} 步）`}
          sim={report.minimized}
        />
      </div>
    </div>
  );
}

interface Props {
  rules: Rule[];
  /** 模拟器中的当前方法（与模拟输入共用同一份 App 状态） */
  method: string;
  /** 模拟器中的当前 URL */
  url: string;
}

/**
 * 请求最小复现面板：直接使用右上角模拟请求栏的「方法 + URL」与当前规则表，
 * 找到仍能复现同一可观察结果的最小启用规则子集。输入与结果只保留在当前页面
 * 会话（内存）；规则或请求一旦变化，上次结果立即标记为已过期。
 */
export function MinimizerPanel({ rules, method, url }: Props) {
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<{
    stamp: string;
    method: string;
    url: string;
    outcome: MinimizeOutcome;
  } | null>(null);

  // 输入指纹：规则或请求（方法 / URL）变化后，上次结果标记为过期
  const stamp = useMemo(() => JSON.stringify({ rules, method, url }), [rules, method, url]);
  const stale = lastRun !== null && lastRun.stamp !== stamp;

  const run = () => {
    if (url.trim() === '' || busy) return;
    // 冻结输入：minimizeRules 内部深拷贝规则表并记录方法 / URL；
    // 用 setTimeout 让忙碌状态先绘制（试探期间每次都重新完整模拟，规则多时会稍慢）
    setBusy(true);
    setTimeout(() => {
      const outcome = minimizeRules(rules, method, url);
      setLastRun({ stamp, method: method.toUpperCase(), url, outcome });
      setBusy(false);
    }, 0);
  };

  const frozenAt =
    lastRun?.outcome.ok === true ? fmtTime(lastRun.outcome.report.frozenAt) : '';

  return (
    <section className="panel mz-panel">
      <div className="panel-title">
        <h2>请求最小复现</h2>
        <div className="toolbar">
          <button className="primary" onClick={run} disabled={busy || url.trim() === ''}>
            {busy ? '正在缩减…' : '生成最小复现'}
          </button>
        </div>
      </div>
      <p className="baseline-info">
        直接使用右上角模拟请求栏的<strong>当前方法与 URL</strong>以及当前规则表：
        生成时冻结输入并复用 simulate 取得原始结果，再对<strong>已启用规则按原顺序</strong>
        做分块删除试探与逐条复核，直到任意单条删除都会改变可观察结果
        （终止类型必须相同：final 比最终 URL，redirect 比状态码与 Location，其余只比终止类型）。
        每次试探都重新完整模拟，允许命中轨迹改变。停用规则不参与。
      </p>

      <div className="mz-request">
        <span className="tag case-method">{method}</span>
        <code className="case-url">{url || '（请先在模拟请求栏填写 URL）'}</code>
      </div>

      {lastRun && (
        <div className="mz-results">
          {stale && (
            <div className="banner warn">
              ⚠️ 规则或请求在上次生成后已变更，以下结果可能已过期，请重新生成。
            </div>
          )}
          <p className="mz-frozen">
            生成时冻结：<code>{lastRun.method} {lastRun.url}</code>
            {frozenAt !== '' && ` · 生成于 ${frozenAt}`}
          </p>
          {lastRun.outcome.ok ? (
            <ReportView report={lastRun.outcome.report} />
          ) : (
            <div className="banner error">
              {lastRun.outcome.reason === 'invalid-url' ? (
                <>
                  <strong>❌ 无法缩减：输入的 URL 非法。</strong>
                  <p>{lastRun.outcome.original.reason}</p>
                </>
              ) : (
                <>
                  <strong>🔍 无法缩减：该请求没有命中任何规则。</strong>
                  <p>
                    原始模拟没有任何规则命中（按原始请求直接放行），空规则表即可得到同一
                    「放行」结果，没有需要保留的规则。
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
