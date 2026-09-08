/**
 * 手机本地金融行情直连适配器
 * 支持 Capacitor 原生 HTTP 请求 (跨域免限制) 与标准 Web 通道
 */
const MarketService = {
  // 原生或标准 HTTP GET 请求封装 (支持自动跟随重定向与 HTTPS 强制升级)
  async httpGet(url, options = {}) {
    if (url.startsWith('http://fund.eastmoney.com')) {
      url = url.replace('http://fund.eastmoney.com', 'https://fund.eastmoney.com');
    } else if (url.startsWith('http://fundsuggest.eastmoney.com')) {
      url = url.replace('http://fundsuggest.eastmoney.com', 'https://fundsuggest.eastmoney.com');
    } else if (url.startsWith('http://qt.gtimg.cn')) {
      url = url.replace('http://qt.gtimg.cn', 'https://qt.gtimg.cn');
    }

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      try {
        const res = await window.Capacitor.Plugins.CapacitorHttp.get({
          url,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/110.0.0.0',
            ...(options.headers || {})
          }
        });

        if (res.status >= 300 && res.status < 400 && res.headers) {
          const redirectUrl = res.headers['Location'] || res.headers['location'];
          if (redirectUrl) {
            return await this.httpGet(redirectUrl, options);
          }
        }

        return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      } catch (e) {
        console.warn('CapacitorHttp 请求失败，回退到 fetch:', e);
      }
    }

    const resp = await fetch(url, options);
    return await resp.text();
  },

  normalizeMarketSymbol(symbol) {
    if (!symbol) return '';
    const s = String(symbol).trim().toLowerCase();
    if (s.startsWith('sh') || s.startsWith('sz') || s.startsWith('bj') || s.startsWith('hk') || s.startsWith('r_hk')) {
      return s;
    }
    if (s.startsWith('6') || s.startsWith('5') || s.startsWith('9')) {
      return `sh${s}`;
    }
    if (s.startsWith('0') || s.startsWith('3')) {
      return `sz${s}`;
    }
    return `sz${s}`;
  },

  async lookupFundNameOnline(fundCode) {
    const code = String(fundCode).trim();
    if (!code || code.length < 4) return null;
    const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${code}`;
    try {
      const text = await this.httpGet(url);
      const json = JSON.parse(text);
      const datas = json.Datas || [];
      for (const item of datas) {
        if (item.CODE === code && item.CATEGORYDESC === '基金') {
          return item.NAME;
        }
      }
      if (datas.length > 0 && datas[0].NAME) {
        return datas[0].NAME;
      }
    } catch (e) {
      console.warn('查询基金名称失败:', e);
    }
    return null;
  },

  async getFundDetailData(fundCode) {
    const code = String(fundCode).trim();
    const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js?rt=${Date.now()}`;
    let rawText = '';
    try {
      rawText = await this.httpGet(url);
    } catch (err) {
      console.warn('获取基金历史详情失败:', err);
    }

    let fundName = '';
    const nameMatch = rawText.match(/var\s+fS_name\s*=\s*"([^"]+)";/);
    if (nameMatch && nameMatch[1]) {
      fundName = nameMatch[1];
    }

    let netWorthList = [];
    const nwKeyword = 'Data_netWorthTrend';
    const nwStartIdx = rawText.indexOf(nwKeyword);
    if (nwStartIdx !== -1) {
      const arrayStart = rawText.indexOf('[', nwStartIdx);
      const arrayEnd = rawText.indexOf('];', arrayStart);
      if (arrayStart !== -1 && arrayEnd !== -1) {
        try {
          const jsonStr = rawText.substring(arrayStart, arrayEnd + 1);
          netWorthList = JSON.parse(jsonStr);
        } catch (e) {
          console.error('解析历史净值 JSON 失败:', e);
        }
      }
    }

    let stockCodes = [];
    const scKeyword = 'stockCodesNew';
    const scStartIdx = rawText.indexOf(scKeyword);
    if (scStartIdx !== -1) {
      const scArrayStart = rawText.indexOf('[', scStartIdx);
      const scArrayEnd = rawText.indexOf('];', scArrayStart);
      if (scArrayStart !== -1 && scArrayEnd !== -1) {
        try {
          const jsonStr = rawText.substring(scArrayStart, scArrayEnd + 1);
          stockCodes = JSON.parse(jsonStr);
        } catch (e) {
          console.error('解析重仓股 JSON 失败:', e);
        }
      }
    }

    return {
      fundCode: code,
      fundName,
      history: netWorthList,
      stockCodes
    };
  },

  async getTencentQuotes(symbols) {
    if (!symbols || symbols.length === 0) return {};
    const normalized = symbols.map(s => this.normalizeMarketSymbol(s));
    const url = `https://qt.gtimg.cn/q=${normalized.join(',')}`;
    const result = {};

    try {
      const text = await this.httpGet(url);
      const lines = text.split(';');
      for (const line of lines) {
        if (!line || !line.includes('~')) continue;
        const parts = line.split('~');
        if (parts.length > 32) {
          const code = parts[2];
          const pctChange = parseFloat(parts[32]);
          if (!isNaN(pctChange)) {
            result[code] = pctChange;
            const varNameMatch = line.match(/v_([a-zA-Z0-9_]+)=/);
            if (varNameMatch && varNameMatch[1]) {
              result[varNameMatch[1]] = pctChange;
            }
          }
        }
      }
    } catch (e) {
      console.warn('获取腾讯行情异常:', e);
    }
    return result;
  },

  async estimateRealtimeChange(fundCode, etfCode, stockCodes) {
    if (etfCode && etfCode.trim()) {
      const normEtf = this.normalizeMarketSymbol(etfCode.trim());
      const cleanCode = etfCode.trim().replace(/^[a-zA-Z]+/, '');
      const quotes = await this.getTencentQuotes([normEtf]);
      if (quotes[normEtf] !== undefined) {
        return { change: quotes[normEtf], source: `场内ETF (${normEtf})` };
      }
      if (quotes[cleanCode] !== undefined) {
        return { change: quotes[cleanCode], source: `场内ETF (${cleanCode})` };
      }
    }

    if (stockCodes && stockCodes.length > 0) {
      const symbolsToQuery = [];
      const stockList = [];

      for (const item of stockCodes.slice(0, 10)) {
        const parts = String(item).split('.');
        if (parts.length === 2) {
          const market = parts[0];
          const code = parts[1];
          let querySymbol = '';
          if (market === '1') querySymbol = `sh${code}`;
          else if (market === '0') querySymbol = `sz${code}`;
          else if (market === '116') querySymbol = `r_hk${code}`;
          else querySymbol = `sz${code}`;
          symbolsToQuery.push(querySymbol);
          stockList.push({ code, querySymbol });
        }
      }

      if (symbolsToQuery.length > 0) {
        const quotes = await this.getTencentQuotes(symbolsToQuery);
        let sumChange = 0;
        let validCount = 0;

        for (const s of stockList) {
          const ch = quotes[s.querySymbol] !== undefined ? quotes[s.querySymbol] : quotes[s.code];
          if (ch !== undefined && !isNaN(ch)) {
            sumChange += ch;
            validCount++;
          }
        }

        if (validCount > 0) {
          const avgChange = parseFloat((sumChange / validCount).toFixed(2));
          return { change: avgChange, source: '前十大重仓股平均' };
        }
      }
    }

    return { change: 0.0, source: '收盘净值' };
  }
};
