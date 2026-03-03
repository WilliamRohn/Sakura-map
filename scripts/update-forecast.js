/**
 * 每日 8:00（北京时间）由 GitHub Actions 调用
 * 拉取 Open-Meteo 最新天气预报，按物候学规则订正各地花期，写回 data.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_JS_PATH = path.join(__dirname, '..', 'data.js');

// 代表城市（用于拉取天气）：武汉-长江中下游，南京-华东，北京-华北
const WEATHER_STATIONS = [
  { name: 'wuhan', region: 'central', lat: 30.59, lon: 114.31 },
  { name: 'nanjing', region: 'east', lat: 32.06, lon: 118.80 },
  { name: 'beijing', region: 'north', lat: 39.90, lon: 116.41 },
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia%2FShanghai&past_days=31&forecast_days=7`;
  return fetch(url);
}

function extractCitiesFromDataJs(content) {
  const start = content.indexOf('const CHERRY_CITIES = [');
  if (start === -1) throw new Error('CHERRY_CITIES not found');
  let i = content.indexOf('[', start) + 1;
  const begin = i;
  let depth = 1;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) break; }
  }
  let arrStr = content.substring(begin - 1, i + 1);
  arrStr = arrStr.replace(/\/\/[^\n]*/g, '');
  // 将 JS 对象字面量键转为 JSON 键（加双引号）
  arrStr = arrStr.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
  arrStr = arrStr.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(arrStr);
}

function addDays(monthDay, deltaDays, year = 2026) {
  if (!monthDay || deltaDays === 0) return monthDay;
  const d = new Date(year, monthDay.month - 1, monthDay.day);
  d.setDate(d.getDate() + deltaDays);
  return { month: d.getMonth() + 1, day: d.getDate() };
}

function clampDay(monthDay, minDay = 1, maxDay = 31) {
  if (!monthDay) return monthDay;
  return { ...monthDay, day: Math.max(minDay, Math.min(maxDay, monthDay.day)) };
}

function getFebAvgMax(w) {
  const times = w.daily.time;
  const temps = w.daily.temperature_2m_max;
  let sum = 0, n = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i].startsWith('2026-02-') && temps[i] != null) {
      sum += temps[i]; n++;
    }
  }
  return n > 0 ? sum / n : 12;
}

function getMarEarlyAvg(w) {
  const times = w.daily.time;
  const temps = w.daily.temperature_2m_max;
  let sum = 0, n = 0;
  for (let i = 0; i < times.length; i++) {
    const day = times[i].startsWith('2026-03-') ? parseInt(times[i].slice(8, 10), 10) : 99;
    if (day <= 7 && temps[i] != null) { sum += temps[i]; n++; }
  }
  return n > 0 ? sum / n : 10;
}

async function main() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;

  console.log('Reading data.js...');
  const content = fs.readFileSync(DATA_JS_PATH, 'utf8');
  const cities = extractCitiesFromDataJs(content);
  const tailStart = content.indexOf('// 区域名称映射');
  const tail = content.substring(tailStart);

  console.log('Fetching weather...');
  const weatherByStation = {};
  for (const st of WEATHER_STATIONS) {
    const w = await fetchWeather(st.lat, st.lon);
    weatherByStation[st.name] = w;
    await new Promise((r) => setTimeout(r, 400));
  }

  const wuhan = weatherByStation.wuhan;
  const beijing = weatherByStation.beijing;
  const nanjing = weatherByStation.nanjing;

  const wuhanFeb = wuhan && wuhan.daily ? getFebAvgMax(wuhan) : 12;
  const beijingMar = beijing && beijing.daily ? getMarEarlyAvg(beijing) : 6;
  const nanjingMar = nanjing && nanjing.daily ? getMarEarlyAvg(nanjing) : 10;

  let centralFirst = 0, centralPeak = 0;
  if (wuhanFeb > 13) { centralFirst = -1; centralPeak = -1; }
  else if (wuhanFeb < 11) { centralFirst = 1; centralPeak = 1; }

  let northFirst = 0, northPeak = 0;
  if (beijingMar < 5) { northFirst = 1; northPeak = 1; }
  else if (beijingMar > 9) { northFirst = -1; northPeak = -1; }

  let eastFirst = 0, eastPeak = 0;
  if (nanjingMar > 11) { eastFirst = -1; eastPeak = -1; }
  else if (nanjingMar < 8) { eastFirst = 1; eastPeak = 1; }

  const regionDeltas = {
    central: { first: centralFirst, peak: centralPeak },
    east: { first: eastFirst, peak: eastPeak },
    north: { first: northFirst, peak: northPeak },
    southwest: { first: 0, peak: 0 },
    south: { first: 0, peak: 0 },
    northeast: { first: northFirst, peak: northPeak },
    northwest: { first: northFirst, peak: northPeak },
  };

  console.log('Region deltas:', regionDeltas);

  const year = now.getFullYear();
  for (const city of cities) {
    const d = regionDeltas[city.region];
    if (!d || (d.first === 0 && d.peak === 0)) continue;
    const y = city.firstBloom.month === 12 || city.firstBloom.month === 11 ? year - 1 : year;
    city.firstBloom = addDays(city.firstBloom, d.first, y);
    city.peakBloom = addDays(city.peakBloom, d.peak, y);
    city.firstBloom = clampDay(city.firstBloom, 1, 31);
    city.peakBloom = clampDay(city.peakBloom, 1, 31);
  }

  const header = `// 49个代表性赏樱城市数据
// 花期数据基于：南京林业大学《中国樱花预报2024》、各地历史气象数据及物候学模型
// 已根据 ${dateStr} 最新天气预报（Open-Meteo）自动订正：每日 8:00 更新
// 坐标：[纬度, 经度]
// 日期格式：月/日

`;

  const newContent = header + 'const CHERRY_CITIES = ' + JSON.stringify(cities, null, 2) + ';\n\n' + tail;
  fs.writeFileSync(DATA_JS_PATH, newContent, 'utf8');
  console.log('data.js updated. Date:', dateStr);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
