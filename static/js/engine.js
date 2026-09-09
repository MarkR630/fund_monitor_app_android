/**
 * 手机本地量化策略引擎
 * 核心架构:
 * 1. [画像自适应分层]:
 *    - 基于前期真实历史年化波动率 (sigma) 客观分类:
 *      * 低波型 (sigma <= 18%): 45天 / 20% 阈值 / 3倍共振加码
 *      * 中波型 (18% < sigma <= 28%): 90天 / 20% 阈值 / 4倍共振加码
 *      * 高波型 (sigma > 28%): 100天 / 30% 宽阈值 / 5倍共振加码
 *    - 支持自定义策略 (用户可针对单只基金自由调整天数、阈值与倍数)
 * 2. [主策略·定方向]: 近 N 天相对位置标尺 (决定做不做)
 * 3. [增强因子·定力度]: 近 30 天大幅波动分位数 (决定做多少，3~5倍动态加码)
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

  // 计算前期历史日收益率年化波动率 (取最近 135 个交易日，约半年)
  calculateAnnualizedVolatility(historyPoints) {
    if (!historyPoints || historyPoints.length < 15) return 20.0;
    const sample = historyPoints.slice(-135);
    const returns = [];
    for (const item of sample) {
      const r = parseFloat(item.equityReturn);
      if (!isNaN(r)) returns.push(r);
    }
    if (returns.length < 10) return 20.0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    const annVol = std * Math.sqrt(250);
    return parseFloat(annVol.toFixed(1));
  },

  // 解析匹配基金适用的策略参数 (智能自适应 vs 自定义参数)
  resolveFundStrategy(fundItem, historyPoints, globalBaseAmount = 100) {
    const annVol = this.calculateAnnualizedVolatility(historyPoints);
    const isCustom = fundItem.strategy_mode === 'custom';

    if (isCustom) {
      const days = parseInt(fundItem.custom_days) || 90;
      const threshold = parseFloat(fundItem.custom_threshold) || 20.0;
      const multiplier = parseInt(fundItem.custom_multiplier) || 4;
      const baseAmount = parseFloat(fundItem.custom_base_amount) || globalBaseAmount || 100;
      return {
        profileKey: 'custom',
        profileName: '自定义策略',
        profileBadge: '⚙️ 自定义',
        profileDesc: `自定义: ${days}天 / ${threshold}% / ${multiplier}倍加码`,
        days,
        threshold,
        multiplier,
        baseAmount,
        volatility: annVol,
        isCustom: true
      };
    }

    // 默认：智能波动率自适应 (低波 <= 18%, 中波 18% ~ 28%, 高波 > 28%)
    let profileKey = 'mid';
    let profileName = '中波型';
    let profileBadge = '中波型';
    let days = 90;
    let threshold = 20.0;
    let multiplier = 4;
    let profileDesc = '中波型: 90天 / 20% / 4倍加码';

    if (annVol <= 18.0) {
      profileKey = 'low';
      profileName = '低波型';
      profileBadge = '低波型';
      days = 45;
      threshold = 20.0;
      multiplier = 3;
      profileDesc = '低波型: 45天 / 20% / 3倍加码';
    } else if (annVol > 28.0) {
      profileKey = 'high';
      profileName = '高波型';
      profileBadge = '高波型';
      days = 100;
      threshold = 30.0;
      multiplier = 5;
      profileDesc = '高波型: 100天 / 30% / 5倍加码';
    }

    const baseAmount = parseFloat(fundItem.custom_base_amount) || globalBaseAmount || 100;
    return {
      profileKey,
      profileName,
      profileBadge,
      profileDesc,
      days,
      threshold,
      multiplier,
      baseAmount,
      volatility: annVol,
      isCustom: false
    };
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
    let actionDesc = '常态波动';

    if (currentChange > 0 && currentChange >= topGainThreshold && topGainThreshold !== Infinity) {
      signal = 'SELL';
      actionDesc = '极值超涨 (减仓强化)';
    } else if (currentChange < 0 && currentChange <= topLossThreshold && topLossThreshold !== -Infinity) {
      signal = 'BUY';
      actionDesc = '恐慌超跌 (加仓强化)';
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

  evaluateStrategy2(historyPoints, currentNav, currentChange, days = 90, threshold = 20.0) {
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

    const lowBound = threshold;
    const highBound = 100.0 - threshold;

    let signal = null;
    let actionDesc = '中位观望区';

    if (posRatio >= highBound) {
      signal = 'SELL';
      actionDesc = `高位减仓区 (≥${highBound}%)`;
    } else if (posRatio <= lowBound) {
      signal = 'BUY';
      actionDesc = `低位加仓区 (≤${lowBound}%)`;
    }

    return {
      signal,
      action_desc: actionDesc,
      est_nav: parseFloat(estNav.toFixed(4)),
      pos_ratio: parseFloat(posRatio.toFixed(1)),
      highest: parseFloat(highest.toFixed(4)),
      highest_date: highestDate,
      lowest: parseFloat(lowest.toFixed(4)),
      lowest_date: lowestDate,
      days,
      threshold,
      low_bound: lowBound,
      high_bound: highBound
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

    // 获取全局设置与策略参数
    const settings = StorageManager.getSettings();
    const globalBaseAmount = settings.baseUnitAmount || 100;
    const stratConfig = this.resolveFundStrategy(fundItem, history, globalBaseAmount);

    // [主策略·定方向]: 根据自适应或自定义的回溯天数与极值阈值计算
    const s2 = this.evaluateStrategy2(history, currentNav, currentChange, stratConfig.days, stratConfig.threshold);
    // [增强因子·定力度]: 近30天大幅波动分位数 (90%分位超涨, 10%分位超跌)
    const s1 = this.evaluateStrategy1(history, currentChange, 30);

    const baseAmt = stratConfig.baseAmount;
    const resonanceAmt = baseAmt * stratConfig.multiplier;

    let finalAdvice = '处于中位平稳区间，未达调仓阈值，继续持有观望';
    let adviceType = 'HOLD';
    let adviceTag = '持有观望';
    let suggestedUnits = 0;
    let suggestedAmount = 0;

    if (s2 && s2.pos_ratio <= s2.low_bound) {
      // 处于低位加仓区 (<= low_bound) -> 准许买入
      if (s1 && s1.signal === 'BUY') {
        // 叠加当日大幅超跌 -> 双重共振强力买入
        adviceType = 'STRONG_BUY';
        suggestedUnits = stratConfig.multiplier;
        suggestedAmount = resonanceAmt;
        finalAdvice = `🔥 处于低位区 + 当日恐慌超跌共振，建议【强力加仓 ${suggestedUnits} 份 (¥${suggestedAmount})】`;
        adviceTag = `强力加仓 ${suggestedUnits} 份`;
      } else {
        adviceType = 'BUY';
        suggestedUnits = 1;
        suggestedAmount = baseAmt;
        finalAdvice = `🌱 处于历史低位区，建议【逢低常规加仓 1 份 (¥${suggestedAmount})】`;
        adviceTag = '常规加仓 1 份';
      }
    } else if (s2 && s2.pos_ratio >= s2.high_bound) {
      // 处于高位减仓区 (>= high_bound) -> 准许卖出
      if (s1 && s1.signal === 'SELL') {
        // 叠加当日大幅超涨 -> 双重共振强力卖出
        adviceType = 'STRONG_SELL';
        suggestedUnits = stratConfig.multiplier;
        suggestedAmount = resonanceAmt;
        finalAdvice = `🚨 处于高位区 + 当日加速冲高共振，建议【强力减仓 ${suggestedUnits} 份 (¥${suggestedAmount})】`;
        adviceTag = `强力减仓 ${suggestedUnits} 份`;
      } else {
        adviceType = 'SELL';
        suggestedUnits = 1;
        suggestedAmount = baseAmt;
        finalAdvice = `🍂 处于历史高位区，建议【逢高常规减仓 1 份 (¥${suggestedAmount})】`;
        adviceTag = '常规减仓 1 份';
      }
    } else {
      // 处于正常中位区 -> 无论日内涨跌多大，一律滤除噪音，避免追涨杀跌
      adviceType = 'HOLD';
      adviceTag = '持有观望';
      suggestedUnits = 0;
      suggestedAmount = 0;
      if (s1 && s1.signal === 'BUY') {
        finalAdvice = `☕ 标的未进入低位区 (≤${s2 ? s2.low_bound : stratConfig.threshold}%)，单日大跌已自动滤除，继续持有观望`;
      } else if (s1 && s1.signal === 'SELL') {
        finalAdvice = `☕ 标的未进入高位区 (≥${s2 ? s2.high_bound : (100 - stratConfig.threshold)}%)，单日大涨已自动滤除，继续持有观望`;
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
      strat_config: stratConfig,
      s1,
      s2,
      final_advice: finalAdvice,
      advice_type: adviceType,
      advice_tag: adviceTag,
      suggested_units: suggestedUnits,
      suggested_amount: suggestedAmount,
      evaluated_at: timeStr
    };
  },

  formatPortfolioTextReport(results) {
    const lines = [];
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    lines.push(`【基金智能策略提醒】监控报告 (生成时间: ${timeStr})`);
    lines.push(`策略法则：位置定方向 · 波动定力度 | 基准买 1 份，暴跌共振买多份\n`);

    const strongBuyFunds = [];
    const regularBuyFunds = [];
    const strongSellFunds = [];
    const regularSellFunds = [];

    for (const res of results) {
      const units = res.suggested_units || 1;
      const amt = res.suggested_amount || res.strat_config.baseAmount;
      const desc = `${res.fund_name}(${res.fund_code}) [${units}份/¥${amt}]`;
      if (res.advice_type === 'STRONG_BUY') strongBuyFunds.push(desc);
      else if (res.advice_type === 'BUY') regularBuyFunds.push(desc);
      else if (res.advice_type === 'STRONG_SELL') strongSellFunds.push(desc);
      else if (res.advice_type === 'SELL') regularSellFunds.push(desc);
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
    lines.push('【全部基金量化透视 (需操作优先)】');
    lines.push('='.repeat(30) + '\n');

    for (const res of results) {
      const fund = res.fund_code;
      const name = res.fund_name;
      const change = res.current_change;
      const s1 = res.s1;
      const s2 = res.s2;
      const cfg = res.strat_config;

      lines.push(name);
      lines.push(`基金代码：${fund}`);
      if (res.etf_code) {
        lines.push(`联接场内ETF：${res.etf_code}`);
      }
      lines.push(`策略画像：${cfg.profileDesc} (前期年化波动率: ${cfg.volatility}%)`);
      lines.push(`交易基准：1份 = ¥${cfg.baseAmount} | 共振加码 = ${cfg.multiplier}倍 (¥${cfg.baseAmount * cfg.multiplier})`);
      const sign = change > 0 ? '+' : '';
      lines.push(`今日预估涨跌幅：${sign}${change.toFixed(2)}% (${res.estimate_source})`);

      if (s2) {
        const s2Status = s2.pos_ratio <= s2.low_bound ? `处于低位加仓区 (≤${s2.low_bound}%)！` : (s2.pos_ratio >= s2.high_bound ? `处于高位减仓区 (≥${s2.high_bound}%)！` : '处于中位平稳区');
        lines.push(`  [主策略·定方向] 近${s2.days}天相对位置: ${s2Status}`);
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

      lines.push(`  > 决策结论：${res.final_advice}`);
      lines.push('-'.repeat(30));
    }

    return lines.join('\n');
  }
};
