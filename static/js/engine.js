/**
 * 手机本地量化策略引擎
 * 完全移植自 Python 核心算法:
 * 1. [策略一] 近30天大幅波动分位数策略 (90%上涨分位减仓, 10%下跌分位加仓)
 * 2. [策略二] 近90天相对位置策略 (区间相对位置 >=80%减仓, <=20%加仓)
 */
const StrategyEngine = {
  percentile(arr, p) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    const weight = idx - lower;
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  },

  formatDate(msOrStr) {
    if (!msOrStr) return '';
    const d = new Date(msOrStr);
    if (isNaN(d.getTime())) return String(msOrStr).slice(0, 10);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  evaluateStrategy1(historyPoints, currentChange, days = 30) {
    if (!historyPoints || historyPoints.length === 0) return null;
    const recent = historyPoints.slice(-days);
    if (recent.length === 0) return null;

    const gains = [];
    const losses = [];
    let maxGain = -Infinity;
    let maxGainDate = '';
    let maxLoss = Infinity;
    let maxLossDate = '';

    for (const item of recent) {
      const ch = parseFloat(item.equityReturn);
      if (isNaN(ch)) continue;
      const dateStr = this.formatDate(item.x);

      if (ch > 0) {
        gains.push(ch);
        if (ch > maxGain) {
          maxGain = ch;
          maxGainDate = dateStr;
        }
      } else if (ch < 0) {
        losses.push(ch);
        if (ch < maxLoss) {
          maxLoss = ch;
          maxLossDate = dateStr;
        }
      }
    }

    const topGainThreshold = gains.length > 0 ? this.percentile(gains, 0.90) : Infinity;
    const topLossThreshold = losses.length > 0 ? this.percentile(losses, 0.10) : -Infinity;

    let signal = null;
    let actionDesc = '观望';

    if (currentChange > 0 && currentChange >= topGainThreshold && topGainThreshold !== Infinity) {
      signal = 'SELL';
      actionDesc = '建议减仓 (SELL)';
    } else if (currentChange < 0 && currentChange <= topLossThreshold && topLossThreshold !== -Infinity) {
      signal = 'BUY';
      actionDesc = '建议加仓 (BUY)';
    }

    return {
      signal,
      action_desc: actionDesc,
      top_gain_threshold: topGainThreshold !== Infinity ? parseFloat(topGainThreshold.toFixed(2)) : null,
      top_loss_threshold: topLossThreshold !== -Infinity ? parseFloat(topLossThreshold.toFixed(2)) : null,
      max_gain: maxGain !== -Infinity ? parseFloat(maxGain.toFixed(2)) : 0.0,
      max_gain_date: maxGainDate,
      max_loss: maxLoss !== Infinity ? parseFloat(maxLoss.toFixed(2)) : 0.0,
      max_loss_date: maxLossDate
    };
  },

  evaluateStrategy2(historyPoints, currentNav, currentChange, days = 90) {
    if (!historyPoints || historyPoints.length < 2) return null;
    const recent = historyPoints.slice(-days);
    if (recent.length === 0) return null;

    let highest = -Infinity;
    let highestDate = '';
    let lowest = Infinity;
    let lowestDate = '';

    for (const item of recent) {
      const nav = parseFloat(item.y);
      if (isNaN(nav)) continue;
      const dateStr = this.formatDate(item.x);

      if (nav > highest) {
        highest = nav;
        highestDate = dateStr;
      }
      if (nav < lowest) {
        lowest = nav;
        lowestDate = dateStr;
      }
    }

    if (highest <= lowest) return null;

    const estNav = currentNav * (1 + currentChange / 100);
    const posRatio = ((estNav - lowest) / (highest - lowest)) * 100.0;

    let signal = null;
    let actionDesc = '观望';

    if (posRatio >= 80.0) {
      signal = 'SELL';
      actionDesc = '建议减仓 (SELL)';
    } else if (posRatio <= 20.0) {
      signal = 'BUY';
      actionDesc = '建议加仓 (BUY)';
    }

    return {
      signal,
      action_desc: actionDesc,
      est_nav: parseFloat(estNav.toFixed(4)),
      pos_ratio: parseFloat(posRatio.toFixed(1)),
      highest: parseFloat(highest.toFixed(4)),
      highest_date: highestDate,
      lowest: parseFloat(lowest.toFixed(4)),
      lowest_date: lowestDate
    };
  },

  async diagnoseFund(fundItem) {
    const detail = await MarketService.getFundDetailData(fundItem.fund_code);
    const fundName = detail.fundName || fundItem.fund_name;
    const history = detail.history || [];

    const latestPoint = history.length > 0 ? history[history.length - 1] : null;
    const currentNav = latestPoint ? parseFloat(latestPoint.y) : 1.0;

    const estimate = await MarketService.estimateRealtimeChange(
      fundItem.fund_code,
      fundItem.etf_code,
      detail.stockCodes
    );

    const currentChange = estimate.change;
    const estimateSource = estimate.source;

    // [主策略·定方向]: 近90天区间相对位置标尺 (>=80%高位减仓区, <=20%低位加仓区)
    const s2 = this.evaluateStrategy2(history, currentNav, currentChange, 90);
    // [增强因子·定力度]: 近30天大幅波动分位数 (90%分位超涨, 10%分位超跌)
    const s1 = this.evaluateStrategy1(history, currentChange, 30);

    let finalAdvice = '处于中位平稳区间，未达调仓阈值，继续持有观望';
    let adviceType = 'HOLD';
    let adviceTag = '持有观望';

    if (s2 && s2.pos_ratio <= 20.0) {
      // 处于低位加仓区 (<= 20%) -> 准许买入
      if (s1 && s1.signal === 'BUY') {
        // 叠加当日大幅超跌 -> 双重共振强力买入
        adviceType = 'STRONG_BUY';
        finalAdvice = '🔥 处于历史低位区 + 当日恐慌超跌，建议【强力加仓 / 加大定投】';
        adviceTag = '强力加仓';
      } else {
        adviceType = 'BUY';
        finalAdvice = '🌱 处于历史低位区，建议【逢低常规加仓】';
        adviceTag = '常规加仓';
      }
    } else if (s2 && s2.pos_ratio >= 80.0) {
      // 处于高位减仓区 (>= 80%) -> 准许卖出
      if (s1 && s1.signal === 'SELL') {
        // 叠加当日大幅超涨 -> 双重共振强力卖出
        adviceType = 'STRONG_SELL';
        finalAdvice = '🚨 处于历史高位区 + 当日加速冲高，建议【强力减仓 / 大幅止盈】';
        adviceTag = '强力减仓';
      } else {
        adviceType = 'SELL';
        finalAdvice = '🍂 处于历史高位区，建议【逢高分批减仓】';
        adviceTag = '常规减仓';
      }
    } else {
      // 处于正常中位区 (20% ~ 80%) -> 无论日内涨跌多大，一律滤除噪音，避免追涨杀跌
      adviceType = 'HOLD';
      adviceTag = '持有观望';
      if (s1 && s1.signal === 'BUY') {
        finalAdvice = '☕ 标的未进入低位区，单日大跌已自动滤除，建议继续持有观望';
      } else if (s1 && s1.signal === 'SELL') {
        finalAdvice = '☕ 标的未进入高位区，单日大涨已自动滤除，建议继续持有观望';
      } else {
        finalAdvice = '☕ 处于正常中位平稳区间，未达调仓阈值，继续持有观望';
      }
    }

    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    return {
      fund_code: fundItem.fund_code,
      fund_name: fundName,
      etf_code: fundItem.etf_code || '',
      current_change: currentChange,
      estimate_source: estimateSource,
      current_nav: currentNav,
      s1,
      s2,
      final_advice: finalAdvice,
      advice_type: adviceType,
      advice_tag: adviceTag,
      evaluated_at: timeStr
    };
  },

  formatPortfolioTextReport(results) {
    const lines = [];
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    lines.push(`【基金智能策略提醒】监控报告 (生成时间: ${timeStr})\n`);

    const strongBuyFunds = [];
    const regularBuyFunds = [];
    const strongSellFunds = [];
    const regularSellFunds = [];

    for (const res of results) {
      if (res.advice_type === 'STRONG_BUY') strongBuyFunds.push(`${res.fund_name}(${res.fund_code})`);
      else if (res.advice_type === 'BUY') regularBuyFunds.push(`${res.fund_name}(${res.fund_code})`);
      else if (res.advice_type === 'STRONG_SELL') strongSellFunds.push(`${res.fund_name}(${res.fund_code})`);
      else if (res.advice_type === 'SELL') regularSellFunds.push(`${res.fund_name}(${res.fund_code})`);
    }

    const urgentActionLines = [];
    if (strongBuyFunds.length > 0) urgentActionLines.push(`🔥【强力加仓】: ${strongBuyFunds.join(', ')}`);
    if (regularBuyFunds.length > 0) urgentActionLines.push(`🌱【常规加仓】: ${regularBuyFunds.join(', ')}`);
    if (strongSellFunds.length > 0) urgentActionLines.push(`🚨【强力减仓】: ${strongSellFunds.join(', ')}`);
    if (regularSellFunds.length > 0) urgentActionLines.push(`🍂【常规减仓】: ${regularSellFunds.join(', ')}`);

    if (urgentActionLines.length > 0) {
      lines.push('【⚠️ 需重点操作基金】:');
      lines.push(...urgentActionLines);
      lines.push('');
    } else {
      lines.push('【⚠️ 需重点操作基金】: 无 (全部标的处于中位观望区)\n');
    }

    lines.push('='.repeat(30));
    lines.push('【全部基金实时情况 (需操作优先)】');
    lines.push('='.repeat(30) + '\n');

    for (const res of results) {
      const fund = res.fund_code;
      const name = res.fund_name;
      const change = res.current_change;
      const s1 = res.s1;
      const s2 = res.s2;

      lines.push(name);
      lines.push(`基金代码：${fund}`);
      if (res.etf_code) {
        lines.push(`联接场内ETF：${res.etf_code}`);
      }
      const sign = change > 0 ? '+' : '';
      lines.push(`今日预估涨跌幅：${sign}${change.toFixed(2)}% (${res.estimate_source})`);

      if (s2) {
        const s2Status = s2.pos_ratio <= 20.0 ? '处于低位加仓区！' : (s2.pos_ratio >= 80.0 ? '处于高位减仓区！' : '处于中位平稳区');
        lines.push(`  [主策略·定方向] 近90天相对位置: ${s2Status}`);
        lines.push(`  > 相对位置百分比：${s2.pos_ratio.toFixed(1)}% (预估净值: ${s2.est_nav.toFixed(4)})`);
        lines.push(`  > 参考区间：最高点 ${s2.highest.toFixed(4)} (${s2.highest_date}) | 最低点 ${s2.lowest.toFixed(4)} (${s2.lowest_date})`);
      }

      if (s1) {
        const s1Trigger = s1.signal ? `触发${s1.signal === 'BUY' ? '恐慌超跌(加仓强化)' : '极值超涨(减仓强化)'}！` : '未触发强化';
        lines.push(`  [增强因子·定力度] 近30天大幅波动: ${s1Trigger}`);
        const gainDate = s1.max_gain_date ? ` (${s1.max_gain_date})` : '';
        const lossDate = s1.max_loss_date ? ` (${s1.max_loss_date})` : '';
        const maxGainSign = s1.max_gain > 0 ? '+' : '';
        lines.push(`  > 参考极值：最大涨幅 ${maxGainSign}${s1.max_gain.toFixed(2)}%${gainDate} | 最大跌幅 ${s1.max_loss.toFixed(2)}%${lossDate}`);
      }

      lines.push(`  > 综合结论：${res.final_advice}`);
      lines.push('-'.repeat(30));
    }

    return lines.join('\n');
  }
};
