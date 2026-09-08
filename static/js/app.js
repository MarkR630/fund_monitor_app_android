// 基金智能监控 (纯手机单机版) 主交互逻辑
let cachedFunds = [];
let lastGeneratedPortfolioText = '';
let lastPortfolioResults = [];

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    const remainingActive = document.querySelectorAll('.modal-overlay.active');
    if (remainingActive.length === 0) {
      document.body.style.overflow = '';
    }
  }
}

function handleOverlayClick(event, modalId) {
  if (event.target && event.target.id === modalId) {
    closeModal(modalId);
  }
}

let toastTimer = null;
function showToast(msg, duration = 2500) {
  const toast = document.getElementById('toastBox');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

function loadFunds() {
  cachedFunds = StorageManager.getFunds();
  document.getElementById('fundCount').textContent = `${cachedFunds.length} 只`;

  const container = document.getElementById('fundList');
  if (cachedFunds.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
        <div style="font-size: 32px; margin-bottom: 8px;">📂</div>
        <div style="font-size: 14px;">暂无监控基金</div>
        <div style="font-size: 12px; margin-top: 4px;">点击上方“添加监控基金”开始监控吧</div>
      </div>
    `;
    return;
  }

  container.innerHTML = cachedFunds.map(fund => `
    <div class="fund-card" id="card-${fund.id}">
      <div class="fund-card-top">
        <div>
          <div class="fund-card-title">${escapeHtml(fund.fund_name)}</div>
          <div class="fund-card-code">
            <span>${fund.fund_code}</span>
            ${fund.etf_code ? `<span class="etf-tag">联接 ${fund.etf_code}</span>` : ''}
          </div>
        </div>
        <div class="fund-card-actions">
          <button class="btn-card-mini btn-card-monitor" id="btn-monitor-${fund.id}" onclick="handleSingleMonitor('${fund.id}')">
            🎯 监控
          </button>
          <button class="btn-card-mini" onclick="openEditFundModal('${fund.id}')" title="编辑">
            ✏️
          </button>
          <button class="btn-card-mini" onclick="handleDeleteFund('${fund.id}', '${escapeHtml(fund.fund_name)}')" title="删除" style="color: #f87171;">
            🗑️
          </button>
        </div>
      </div>
    </div>
  `).join('');
}

// 单基即时量化体检 (从主列表点击【🎯 监控】进入)
async function handleSingleMonitor(fundId) {
  const fund = cachedFunds.find(f => f.id === fundId);
  if (!fund) return;

  const btn = document.getElementById(`btn-monitor-${fundId}`);
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 计算中';

  try {
    const report = await StrategyEngine.diagnoseFund(fund);
    renderSingleFundReport(report);
    openModal('monitorModal');
  } catch (e) {
    showToast('体检异常: ' + (e.message || '网络连接失败'));
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// 从汇总报告中点击任意基金，直接秒级呼出该基金的全部详细信息 (数据已现成算好)
function openFundDetailFromReport(fundCode) {
  const item = lastPortfolioResults.find(r => r.fund_code === fundCode);
  if (!item) {
    const fund = cachedFunds.find(f => f.fund_code === fundCode);
    if (fund) {
      handleSingleMonitor(fund.id);
      return;
    }
    showToast('未找到该基金报告详情');
    return;
  }
  renderSingleFundReport(item);
  openModal('monitorModal');
}

// 渲染单基金全套监控报告详细信息
function renderSingleFundReport(r) {
  const content = document.getElementById('monitorContent');
  const change = r.current_change || 0;
  const isUp = change > 0;
  const isDown = change < 0;
  const changeClass = isUp ? 'color-up' : (isDown ? 'color-down' : 'color-neutral');
  const changeSign = isUp ? '+' : '';

  // [主策略·定方向] 近90天相对位置标尺
  const s2 = r.s2;
  let s2Html = '<div style="color: var(--text-muted); font-size: 13px;">历史数据不足，未能完成主策略评估</div>';
  if (s2) {
    let s2Trigger = 'trigger-no';
    let s2TriggerText = '中位观望区 (滤除单日波动)';
    if (s2.pos_ratio <= 20.0) {
      s2Trigger = 'trigger-yes';
      s2TriggerText = '🟢 进入低位加仓区 (≤20%)';
    } else if (s2.pos_ratio >= 80.0) {
      s2Trigger = 'trigger-yes';
      s2TriggerText = '🔴 进入高位减仓区 (≥80%)';
    }
    const posRatioClamped = Math.min(100, Math.max(0, s2.pos_ratio));

    s2Html = `
      <div class="strategy-title-row">
        <span class="strategy-name">🎯 [主策略·定方向] 近90天相对位置标尺</span>
        <span class="trigger-tag ${s2Trigger}">${s2TriggerText}</span>
      </div>
      <div class="strategy-metric-row">
        <span>今日预估净值位置</span>
        <span class="strategy-metric-val">${s2.est_nav} (前收: ${r.current_nav})</span>
      </div>
      <div class="strategy-metric-row">
        <span>区间相对位置百分比</span>
        <span class="strategy-metric-val" style="color: var(--primary); font-size: 15px; font-weight: 700;">${s2.pos_ratio}%</span>
      </div>
      <div class="gauge-wrapper">
        <div class="gauge-track">
          <div class="gauge-zones">
            <div class="zone-buy"></div>
            <div class="zone-normal"></div>
            <div class="zone-sell"></div>
          </div>
          <div class="gauge-pin" style="left: ${posRatioClamped}%;"></div>
        </div>
        <div class="gauge-markers">
          <span>0% (低位加仓 &le;20%)</span>
          <span>高位减仓 &ge;80% (100%)</span>
        </div>
      </div>
      <div class="strategy-metric-row" style="margin-top: 8px;">
        <span>近90天最高点</span>
        <span class="strategy-metric-val">${s2.highest} (${s2.highest_date})</span>
      </div>
      <div class="strategy-metric-row">
        <span>近90天最低点</span>
        <span class="strategy-metric-val">${s2.lowest} (${s2.lowest_date})</span>
      </div>
    `;
  }

  // [增强因子·定力度] 近30天大幅波动分位数
  const s1 = r.s1;
  let s1Html = '<div style="color: var(--text-muted); font-size: 13px;">历史数据不足，未能完成增强策略评估</div>';
  if (s1) {
    let s1Trigger = 'trigger-no';
    let s1TriggerText = '常态波动 (无强化)';
    if (s1.signal === 'BUY') {
      s1Trigger = 'trigger-yes';
      s1TriggerText = '🔥 恐慌超跌 (加仓强化)';
    } else if (s1.signal === 'SELL') {
      s1Trigger = 'trigger-yes';
      s1TriggerText = '🚨 极值超涨 (减仓强化)';
    }
    s1Html = `
      <div class="strategy-title-row">
        <span class="strategy-name">⚡ [增强因子·定力度] 近30天波动分位数</span>
        <span class="trigger-tag ${s1Trigger}">${s1TriggerText}</span>
      </div>
      <div class="strategy-metric-row">
        <span>仓位强化效果</span>
        <span class="strategy-metric-val" style="color:${s1.signal === 'BUY' ? '#ff6b6b' : (s1.signal === 'SELL' ? '#34d399' : 'var(--text-muted)')}; font-weight: 600;">
          ${s1.signal === 'BUY' ? '低位遇恐慌暴跌 ➔ 加大加仓力度' : (s1.signal === 'SELL' ? '高位遇冲高狂热 ➔ 加大止盈力度' : '正常波动，按主策略基准执行')}
        </span>
      </div>
      <div class="strategy-metric-row">
        <span>近30天最大涨幅</span>
        <span class="strategy-metric-val">${s1.max_gain > 0 ? '+' : ''}${s1.max_gain}% ${s1.max_gain_date ? `(${s1.max_gain_date})` : ''}</span>
      </div>
      <div class="strategy-metric-row">
        <span>近30天最大跌幅</span>
        <span class="strategy-metric-val">${s1.max_loss}% ${s1.max_loss_date ? `(${s1.max_loss_date})` : ''}</span>
      </div>
      ${s1.top_gain_threshold ? `
      <div class="strategy-metric-row">
        <span>90%超涨分位阈值</span>
        <span class="strategy-metric-val">+${s1.top_gain_threshold}%</span>
      </div>` : ''}
      ${s1.top_loss_threshold ? `
      <div class="strategy-metric-row">
        <span>10%超跌分位阈值</span>
        <span class="strategy-metric-val">${s1.top_loss_threshold}%</span>
      </div>` : ''}
    `;
  }

  content.innerHTML = `
    <div class="report-hero">
      <div class="report-fund-title">${escapeHtml(r.fund_name)}</div>
      <div class="report-fund-sub">代码: ${r.fund_code} ${r.etf_code ? `| 联接: ${r.etf_code}` : ''} | 数据来源: ${r.estimate_source}</div>
      <div class="report-change-badge ${changeClass}">
        ${changeSign}${change.toFixed(2)}%
      </div>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">今日实时预估涨跌</div>
    </div>

    <div class="report-advice-banner advice-${r.advice_type}">
      <span>💡</span>
      <span>${r.final_advice}</span>
    </div>

    <div class="strategy-box">
      ${s2Html}
    </div>

    <div class="strategy-box">
      ${s1Html}
    </div>

    <div style="font-size: 11px; color: var(--text-muted); text-align: right; margin-top: 10px;">
      评估生成时间: ${r.evaluated_at}
    </div>
  `;
}

// 一键全组合汇总报告生成 (优先将需要操作的排在最前)
async function generateVisualPortfolioReport() {
  if (cachedFunds.length === 0) {
    showToast('当前尚未添加监控基金');
    return;
  }

  openModal('portfolioVisualModal');

  document.getElementById('statTotal').textContent = cachedFunds.length;
  document.getElementById('statAction').textContent = '...';
  document.getElementById('statBuy').textContent = '...';
  document.getElementById('statSell').textContent = '...';
  document.getElementById('urgentAlertSection').style.display = 'none';
  document.getElementById('portfolioVisualList').innerHTML = `
    <div style="text-align: center; padding: 30px; color: var(--text-muted);">
      <span class="spinner" style="width: 22px; height: 22px; margin-bottom: 8px;"></span>
      <div>正在执行全组合 ${cachedFunds.length} 只基金量化双策略体检...</div>
    </div>
  `;
  document.getElementById('portfolioPlainText').textContent = '计算中...';

  const results = [];
  let buyCount = 0;
  let sellCount = 0;
  let actionCount = 0;
  const urgentItems = [];

  for (const fund of cachedFunds) {
    try {
      const res = await StrategyEngine.diagnoseFund(fund);
      results.push(res);
      if (res.advice_type === 'STRONG_BUY' || res.advice_type === 'BUY') {
        buyCount++;
        actionCount++;
        urgentItems.push({ code: res.fund_code, name: res.fund_name, advice: res.final_advice, type: res.advice_type });
      } else if (res.advice_type === 'STRONG_SELL' || res.advice_type === 'SELL') {
        sellCount++;
        actionCount++;
        urgentItems.push({ code: res.fund_code, name: res.fund_name, advice: res.final_advice, type: res.advice_type });
      }
    } catch (e) {
      console.error(`计算 ${fund.fund_code} 失败:`, e);
    }
  }

  // 核心排序：强力加仓(1) > 常规加仓(2) > 强力减仓(3) > 常规减仓(4) > 观望持有(5)
  results.sort((a, b) => {
    const getPriority = (item) => {
      if (item.advice_type === 'STRONG_BUY') return 1;
      if (item.advice_type === 'BUY') return 2;
      if (item.advice_type === 'STRONG_SELL') return 3;
      if (item.advice_type === 'SELL') return 4;
      return 5; // HOLD
    };
    const priA = getPriority(a);
    const priB = getPriority(b);
    if (priA !== priB) return priA - priB;

    // 默认同优先级按预估涨跌幅绝对值降序排列 (波动越大的排在前面)
    return Math.abs(b.current_change || 0) - Math.abs(a.current_change || 0);
  });

  // 存入全局缓存，供后续点击基金卡片时秒级调取全套详细数据
  lastPortfolioResults = results;

  document.getElementById('statTotal').textContent = results.length;
  document.getElementById('statAction').textContent = actionCount;
  document.getElementById('statBuy').textContent = buyCount;
  document.getElementById('statSell').textContent = sellCount;

  // 需操作重点监控警报区 (点击任意一条也可直接呼出详细报告)
  const alertBox = document.getElementById('urgentAlertSection');
  const alertList = document.getElementById('urgentAlertList');
  if (urgentItems.length > 0) {
    alertBox.style.display = 'block';
    alertList.innerHTML = urgentItems.map(item => `
      <div style="cursor: pointer; padding: 4px 0; display: flex; justify-content: space-between; align-items: center;" onclick="openFundDetailFromReport('${item.code}')">
        <span>• <b>${escapeHtml(item.name)}</b> (${item.code})：${escapeHtml(item.advice)}</span>
        <span style="font-size: 11px; text-decoration: underline; color: #fca5a5; flex-shrink: 0; margin-left: 8px;">查看详情 ›</span>
      </div>
    `).join('');
  } else {
    alertBox.style.display = 'none';
  }

  // 渲染全部基金可视化卡片列表 (高优先级带有独特彩色标识条与醒目标签)
  const listContainer = document.getElementById('portfolioVisualList');
  listContainer.innerHTML = results.map(r => {
    const change = r.current_change || 0;
    const isUp = change > 0;
    const isDown = change < 0;
    const changeClass = isUp ? 'color-up' : (isDown ? 'color-down' : 'color-neutral');
    const changeSign = isUp ? '+' : '';
    const posRatioClamped = r.s2 ? Math.min(100, Math.max(0, r.s2.pos_ratio)) : 50;

    let s2Badge = '';
    if (r.s2) {
      if (r.s2.pos_ratio <= 20.0) {
        s2Badge = `<span class="trigger-tag trigger-yes">🎯 低位加仓区 ${r.s2.pos_ratio}%</span>`;
      } else if (r.s2.pos_ratio >= 80.0) {
        s2Badge = `<span class="trigger-tag trigger-yes">🎯 高位减仓区 ${r.s2.pos_ratio}%</span>`;
      } else {
        s2Badge = `<span class="trigger-tag trigger-no">🎯 中位区 ${r.s2.pos_ratio}%</span>`;
      }
    }

    let s1Badge = '';
    if (r.s1 && r.s1.signal) {
      const s1Txt = r.s1.signal === 'BUY' ? '⚡ 恐慌超跌强化' : '⚡ 极值超涨强化';
      s1Badge = `<span class="trigger-tag trigger-yes">${s1Txt}</span>`;
    }

    let actionClass = '';
    let actionTag = '';
    if (r.advice_type === 'STRONG_BUY') {
      actionClass = 'visual-fund-action-strong-buy';
      actionTag = '<span class="action-priority-tag tag-strong-buy">🔥 强力加仓</span>';
    } else if (r.advice_type === 'BUY') {
      actionClass = 'visual-fund-action-buy';
      actionTag = '<span class="action-priority-tag tag-buy">🌱 常规加仓</span>';
    } else if (r.advice_type === 'STRONG_SELL') {
      actionClass = 'visual-fund-action-strong-sell';
      actionTag = '<span class="action-priority-tag tag-strong-sell">🚨 强力减仓</span>';
    } else if (r.advice_type === 'SELL') {
      actionClass = 'visual-fund-action-sell';
      actionTag = '<span class="action-priority-tag tag-sell">🍂 常规减仓</span>';
    }

    return `
      <div class="visual-fund-item ${actionClass}" onclick="openFundDetailFromReport('${r.fund_code}')" title="点击查看【${escapeHtml(r.fund_name)}】全套详细监控报告">
        <div class="visual-item-header">
          <div>
            <div class="visual-item-name">
              ${actionTag}
              <span>${escapeHtml(r.fund_name)}</span>
              <span class="detail-link-tag">详细报告 ›</span>
            </div>
            <div class="visual-item-code">代码: ${r.fund_code} ${r.etf_code ? `| 联接: ${r.etf_code}` : ''}</div>
          </div>
          <div class="visual-item-badge ${changeClass}">
            ${changeSign}${change.toFixed(2)}%
          </div>
        </div>

        <div style="display: flex; gap: 6px; margin: 6px 0; flex-wrap: wrap;">
          ${s1Badge}
          ${s2Badge}
          <span class="report-advice-banner advice-${r.advice_type}" style="padding: 2px 8px; font-size: 11px; margin: 0;">
            ${r.final_advice}
          </span>
        </div>

        ${r.s2 ? `
          <div class="gauge-wrapper" style="margin-top: 8px;">
            <div class="gauge-track">
              <div class="gauge-zones">
                <div class="zone-buy"></div>
                <div class="zone-normal"></div>
                <div class="zone-sell"></div>
              </div>
              <div class="gauge-pin" style="left: ${posRatioClamped}%;"></div>
            </div>
            <div class="gauge-markers">
              <span>低位区间 (&le;20%)</span>
              <span style="color: var(--text-main); font-weight: 600;">相对位置: ${r.s2.pos_ratio}%</span>
              <span>高位区间 (&ge;80%)</span>
            </div>
          </div>
        ` : ''}

        <div class="visual-card-hint">
          <span>📊 点击查看完整策略明细与历史极值</span>
          <span>详细报告 ›</span>
        </div>
      </div>
    `;
  }).join('');

  lastGeneratedPortfolioText = StrategyEngine.formatPortfolioTextReport(results);
  document.getElementById('portfolioPlainText').textContent = lastGeneratedPortfolioText;
}

function togglePlainTextSection() {
  const pre = document.getElementById('portfolioPlainText');
  const arrow = document.getElementById('plainTextToggleArrow');
  if (pre.style.display === 'none') {
    pre.style.display = 'block';
    arrow.textContent = '▲';
  } else {
    pre.style.display = 'none';
    arrow.textContent = '▼';
  }
}

function copyPortfolioTextReport() {
  if (!lastGeneratedPortfolioText) {
    showToast('暂无报告可复制');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(lastGeneratedPortfolioText).then(() => {
      showToast('✅ 报告文本已复制到剪贴板！');
    }).catch(() => {
      fallbackCopy(lastGeneratedPortfolioText);
    });
  } else {
    fallbackCopy(lastGeneratedPortfolioText);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  showToast('✅ 报告文本已复制到剪贴板！');
}

async function lookupFundName() {
  const code = document.getElementById('inputFundCode').value.trim();
  if (!code || code.length < 4) {
    showToast('请先输入至少4位基金代码');
    return;
  }
  showToast('正在在线查询基金名称...');
  try {
    const name = await MarketService.lookupFundNameOnline(code);
    if (name) {
      document.getElementById('inputFundName').value = name;
      showToast(`已成功匹配: ${name}`);
    } else {
      showToast('未能自动查到名称，请手动输入');
    }
  } catch (e) {
    showToast('查询失败，请手动输入');
  }
}

function openAddFundModal() {
  document.getElementById('fundModalTitle').textContent = '添加监控基金';
  document.getElementById('editFundId').value = '';
  document.getElementById('inputFundCode').value = '';
  document.getElementById('inputFundCode').disabled = false;
  document.getElementById('inputFundName').value = '';
  document.getElementById('inputEtfCode').value = '';
  openModal('fundModal');
}

function openEditFundModal(fundId) {
  const fund = cachedFunds.find(f => f.id === fundId);
  if (!fund) return;
  document.getElementById('fundModalTitle').textContent = '编辑监控基金';
  document.getElementById('editFundId').value = fund.id;
  document.getElementById('inputFundCode').value = fund.fund_code;
  document.getElementById('inputFundCode').disabled = true;
  document.getElementById('inputFundName').value = fund.fund_name;
  document.getElementById('inputEtfCode').value = fund.etf_code || '';
  openModal('fundModal');
}

function handleFundSubmit(event) {
  event.preventDefault();
  const editId = document.getElementById('editFundId').value;
  const fund_code = document.getElementById('inputFundCode').value.trim();
  const fund_name = document.getElementById('inputFundName').value.trim();
  const etf_code = document.getElementById('inputEtfCode').value.trim();

  try {
    if (editId) {
      StorageManager.updateFund(editId, { fund_name, etf_code });
      showToast('更新成功！');
    } else {
      StorageManager.addFund({ fund_code, fund_name, etf_code });
      showToast('添加成功！');
    }
    closeModal('fundModal');
    loadFunds();
  } catch (e) {
    showToast(e.message);
  }
}

function handleDeleteFund(fundId, fundName) {
  if (confirm(`确定要移除“${fundName}”吗？`)) {
    StorageManager.deleteFund(fundId);
    showToast('已移除');
    loadFunds();
  }
}

function openBackupModal() {
  document.getElementById('backupInput').value = '';
  openModal('backupModal');
}

function exportBackupData() {
  const jsonStr = StorageManager.exportBackup();
  fallbackCopy(jsonStr);
}

function importBackupData() {
  const input = document.getElementById('backupInput').value.trim();
  if (!input) {
    showToast('请先粘贴备份内容');
    return;
  }
  try {
    StorageManager.importBackup(input);
    showToast('✅ 还原成功！');
    closeModal('backupModal');
    loadFunds();
  } catch (e) {
    showToast(e.message);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', () => {
  loadFunds();
});
