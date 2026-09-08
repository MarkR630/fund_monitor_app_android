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
      created_at: new Date().toISOString()
    },
    {
      id: 'fund_default_2',
      fund_code: '020096',
      fund_name: '富国中证绿色电力ETF发起式联接C',
      etf_code: 'sh561170',
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

  addFund({ fund_code, fund_name, etf_code }) {
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
      created_at: new Date().toISOString()
    };
    list.unshift(newFund);
    this.saveFunds(list);
    return newFund;
  },

  updateFund(id, { fund_name, etf_code }) {
    const list = this.getFunds();
    const idx = list.findIndex(f => f.id === id);
    if (idx === -1) throw new Error('未找到该基金');
    list[idx].fund_name = fund_name.trim();
    list[idx].etf_code = etf_code ? etf_code.trim() : '';
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
      version: '1.0.0',
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
    try {
      const raw = localStorage.getItem(this.KEYS.SETTINGS);
      return raw ? JSON.parse(raw) : {
        strategy1Days: 30,
        strategy2Days: 90,
        strategy2HighRatio: 80,
        strategy2LowRatio: 20
      };
    } catch (e) {
      return {
        strategy1Days: 30,
        strategy2Days: 90,
        strategy2HighRatio: 80,
        strategy2LowRatio: 20
      };
    }
  },

  saveSettings(settings) {
    try {
      localStorage.setItem(this.KEYS.SETTINGS, JSON.stringify(settings));
      return true;
    } catch (e) {
      return false;
    }
  }
};
