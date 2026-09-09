/**
 * 手机本地持久化存储管理器 (完全无需服务器)
 * 基于 localStorage 存储自选基金列表与配置
 */
const StorageManager = {
  KEYS: {
    FUNDS: 'fund_monitor_local_funds',
    SETTINGS: 'fund_monitor_settings'
  },

  DEFAULT_FUNDS: [
    {
      id: 'fund_default_1',
      fund_code: '005827',
      fund_name: '易方达蓝筹精选混合',
      etf_code: '',
      strategy_mode: 'auto',
      created_at: new Date().toISOString()
    },
    {
      id: 'fund_default_2',
      fund_code: '020096',
      fund_name: '富国中证绿色电力ETF发起式联接C',
      etf_code: 'sh561170',
      strategy_mode: 'auto',
      created_at: new Date().toISOString()
    }
  ],

  getFunds() {
    try {
      const raw = localStorage.getItem(this.KEYS.FUNDS);
      if (!raw) {
        this.saveFunds(this.DEFAULT_FUNDS);
        return [...this.DEFAULT_FUNDS];
      }
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.error('读取本地基金数据失败:', e);
      return [];
    }
  },

  saveFunds(funds) {
    try {
      localStorage.setItem(this.KEYS.FUNDS, JSON.stringify(funds));
      return true;
    } catch (e) {
      console.error('保存本地基金数据失败:', e);
      return false;
    }
  },

  addFund({ fund_code, fund_name, etf_code, strategy_mode = 'auto', custom_days = 90, custom_threshold = 20, custom_multiplier = 4, custom_base_amount = null }) {
    const list = this.getFunds();
    const code = String(fund_code).trim();
    if (list.some(f => f.fund_code === code)) {
      throw new Error(`基金代码 ${code} 已在您的监控目录中`);
    }
    const newFund = {
      id: 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      fund_code: code,
      fund_name: (fund_name || '').trim() || `基金_${code}`,
      etf_code: etf_code ? etf_code.trim() : '',
      strategy_mode: strategy_mode === 'custom' ? 'custom' : 'auto',
      custom_days: parseInt(custom_days) || 90,
      custom_threshold: parseFloat(custom_threshold) || 20,
      custom_multiplier: parseInt(custom_multiplier) || 4,
      custom_base_amount: custom_base_amount ? parseFloat(custom_base_amount) : null,
      created_at: new Date().toISOString()
    };
    list.unshift(newFund);
    this.saveFunds(list);
    return newFund;
  },

  updateFund(id, data) {
    const list = this.getFunds();
    const idx = list.findIndex(f => f.id === id);
    if (idx === -1) throw new Error('未找到该基金');
    list[idx].fund_name = data.fund_name ? data.fund_name.trim() : list[idx].fund_name;
    list[idx].etf_code = data.etf_code !== undefined ? data.etf_code.trim() : list[idx].etf_code;
    list[idx].strategy_mode = data.strategy_mode === 'custom' ? 'custom' : 'auto';
    if (data.custom_days !== undefined) list[idx].custom_days = parseInt(data.custom_days) || 90;
    if (data.custom_threshold !== undefined) list[idx].custom_threshold = parseFloat(data.custom_threshold) || 20;
    if (data.custom_multiplier !== undefined) list[idx].custom_multiplier = parseInt(data.custom_multiplier) || 4;
    list[idx].custom_base_amount = data.custom_base_amount ? parseFloat(data.custom_base_amount) : null;
    this.saveFunds(list);
    return list[idx];
  },

  deleteFund(id) {
    let list = this.getFunds();
    const initialLen = list.length;
    list = list.filter(f => f.id !== id);
    this.saveFunds(list);
    return list.length < initialLen;
  },

  exportBackup() {
    const data = {
      version: '1.1.0',
      exported_at: new Date().toISOString(),
      funds: this.getFunds(),
      settings: this.getSettings()
    };
    return JSON.stringify(data, null, 2);
  },

  importBackup(jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (!parsed || !Array.isArray(parsed.funds)) {
        throw new Error('备份格式不正确，缺少 funds 列表');
      }
      this.saveFunds(parsed.funds);
      if (parsed.settings) {
        this.saveSettings(parsed.settings);
      }
      return true;
    } catch (e) {
      throw new Error('导入失败: ' + (e.message || 'JSON 格式解析错误'));
    }
  },

  getSettings() {
    const defaults = {
      baseUnitAmount: 100, // 全局默认交易单位金额 (x元 / 1份)
      strategy1Days: 30
    };
    try {
      const raw = localStorage.getItem(this.KEYS.SETTINGS);
      return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
    } catch (e) {
      return defaults;
    }
  },

  saveSettings(settings) {
    try {
      const current = this.getSettings();
      const updated = { ...current, ...settings };
      localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify(updated));
      return true;
    } catch (e) {
      return false;
    }
  }
};
