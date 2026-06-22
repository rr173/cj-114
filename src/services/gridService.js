const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const { getTradingDayById, getTradingDayByDate } = require('./tradingDayService');
const { getParticipantById, listParticipants } = require('./participantService');
const { getPriceZoneById } = require('./priceZoneService');

function createBus(busData) {
  if (!busData.code || !busData.name || !busData.bus_type) {
    throw new Error('节点编号、名称、类型为必填项');
  }
  if (!['generator', 'load', 'tie'].includes(busData.bus_type)) {
    throw new Error('节点类型必须是 generator、load 或 tie');
  }
  if (busData.zone_id) {
    const zone = getPriceZoneById(busData.zone_id);
    if (!zone) throw new Error('所属电价区不存在');
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO grid_buses (id, code, name, zone_id, bus_type)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, busData.code, busData.name, busData.zone_id || null, busData.bus_type);
  return getBusById(id);
}

function getBusById(id) {
  const row = db.prepare(`
    SELECT gb.*, pz.code as zone_code, pz.name as zone_name
    FROM grid_buses gb
    LEFT JOIN price_zones pz ON gb.zone_id = pz.id
    WHERE gb.id = ?
  `).get(id);
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    zone_id: row.zone_id,
    zone_code: row.zone_code,
    zone_name: row.zone_name,
    bus_type: row.bus_type,
    created_at: row.created_at
  };
}

function getBusByCode(code) {
  const row = db.prepare(`
    SELECT gb.*, pz.code as zone_code, pz.name as zone_name
    FROM grid_buses gb
    LEFT JOIN price_zones pz ON gb.zone_id = pz.id
    WHERE gb.code = ?
  `).get(code);
  if (!row) return null;
  return getBusById(row.id);
}

function listBuses() {
  const rows = db.prepare(`
    SELECT gb.*, pz.code as zone_code, pz.name as zone_name
    FROM grid_buses gb
    LEFT JOIN price_zones pz ON gb.zone_id = pz.id
    ORDER BY gb.code
  `).all();
  return rows.map(row => ({
    id: row.id,
    code: row.code,
    name: row.name,
    zone_id: row.zone_id,
    zone_code: row.zone_code,
    zone_name: row.zone_name,
    bus_type: row.bus_type,
    created_at: row.created_at
  }));
}

function createLine(lineData) {
  if (!lineData.code || !lineData.from_bus_id || !lineData.to_bus_id ||
      lineData.reactance === undefined || lineData.thermal_limit === undefined) {
    throw new Error('线路编号、首末节点、电抗值、热稳定限额为必填项');
  }
  if (lineData.reactance <= 0) {
    throw new Error('电抗值必须大于0');
  }
  if (lineData.thermal_limit <= 0) {
    throw new Error('热稳定限额必须大于0');
  }
  if (!getBusById(lineData.from_bus_id)) throw new Error('首节点不存在');
  if (!getBusById(lineData.to_bus_id)) throw new Error('末节点不存在');
  if (lineData.from_bus_id === lineData.to_bus_id) {
    throw new Error('首末节点不能相同');
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO grid_lines (id, code, from_bus_id, to_bus_id, reactance, thermal_limit, status)
    VALUES (?, ?, ?, ?, ?, ?, 'in_service')
  `).run(id, lineData.code, lineData.from_bus_id, lineData.to_bus_id, lineData.reactance, lineData.thermal_limit);
  return getLineById(id);
}

function getLineById(id) {
  const row = db.prepare(`
    SELECT gl.*, 
           fb.code as from_bus_code, fb.name as from_bus_name,
           tb.code as to_bus_code, tb.name as to_bus_name
    FROM grid_lines gl
    JOIN grid_buses fb ON gl.from_bus_id = fb.id
    JOIN grid_buses tb ON gl.to_bus_id = tb.id
    WHERE gl.id = ?
  `).get(id);
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    from_bus_id: row.from_bus_id,
    from_bus_code: row.from_bus_code,
    from_bus_name: row.from_bus_name,
    to_bus_id: row.to_bus_id,
    to_bus_code: row.to_bus_code,
    to_bus_name: row.to_bus_name,
    reactance: row.reactance,
    thermal_limit: row.thermal_limit,
    status: row.status,
    created_at: row.created_at
  };
}

function listLines() {
  const rows = db.prepare(`
    SELECT gl.*, 
           fb.code as from_bus_code, fb.name as from_bus_name,
           tb.code as to_bus_code, tb.name as to_bus_name
    FROM grid_lines gl
    JOIN grid_buses fb ON gl.from_bus_id = fb.id
    JOIN grid_buses tb ON gl.to_bus_id = tb.id
    ORDER BY gl.code
  `).all();
  return rows.map(row => ({
    id: row.id,
    code: row.code,
    from_bus_id: row.from_bus_id,
    from_bus_code: row.from_bus_code,
    from_bus_name: row.from_bus_name,
    to_bus_id: row.to_bus_id,
    to_bus_code: row.to_bus_code,
    to_bus_name: row.to_bus_name,
    reactance: row.reactance,
    thermal_limit: row.thermal_limit,
    status: row.status,
    created_at: row.created_at
  }));
}

function attachParticipantToBus(busId, participantId) {
  const bus = getBusById(busId);
  if (!bus) throw new Error('电网节点不存在');
  const participant = getParticipantById(participantId);
  if (!participant) throw new Error('市场主体不存在');
  const id = uuidv4();
  try {
    db.prepare(`
      INSERT INTO grid_bus_participants (id, bus_id, participant_id)
      VALUES (?, ?, ?)
    `).run(id, busId, participantId);
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      throw new Error('该主体已挂接到此节点');
    }
    throw e;
  }
  return {
    id,
    bus_id: busId,
    participant_id: participantId,
    bus_code: bus.code,
    participant_code: participant.code,
    participant_name: participant.name
  };
}

function detachParticipantFromBus(busId, participantId) {
  const result = db.prepare(`
    DELETE FROM grid_bus_participants
    WHERE bus_id = ? AND participant_id = ?
  `).run(busId, participantId);
  if (result.changes === 0) {
    throw new Error('挂接关系不存在');
  }
  return { success: true };
}

function getBusParticipants(busId) {
  const rows = db.prepare(`
    SELECT gbp.*, mp.code as participant_code, mp.name as participant_name, mp.type as participant_type
    FROM grid_bus_participants gbp
    JOIN market_participants mp ON gbp.participant_id = mp.id
    WHERE gbp.bus_id = ?
    ORDER BY mp.code
  `).all(busId);
  return rows.map(row => ({
    id: row.id,
    bus_id: row.bus_id,
    participant_id: row.participant_id,
    participant_code: row.participant_code,
    participant_name: row.participant_name,
    participant_type: row.participant_type
  }));
}

function getParticipantBuses(participantId) {
  const rows = db.prepare(`
    SELECT gbp.*, gb.code as bus_code, gb.name as bus_name, gb.bus_type, gb.zone_id
    FROM grid_bus_participants gbp
    JOIN grid_buses gb ON gbp.bus_id = gb.id
    WHERE gbp.participant_id = ?
    ORDER BY gb.code
  `).all(participantId);
  return rows.map(row => ({
    id: row.id,
    bus_id: row.bus_id,
    bus_code: row.bus_code,
    bus_name: row.bus_name,
    bus_type: row.bus_type,
    zone_id: row.zone_id,
    participant_id: row.participant_id
  }));
}

function checkTopologyConnectivity() {
  const buses = listBuses();
  const lines = listLines().filter(l => l.status === 'in_service');
  
  if (buses.length === 0) {
    return {
      connected: false,
      total_buses: 0,
      isolated_buses: [],
      components: [],
      message: '电网无节点'
    };
  }
  
  if (buses.length === 1) {
    return {
      connected: true,
      total_buses: 1,
      isolated_buses: [],
      components: [[buses[0].id]],
      message: '电网单节点，天然连通'
    };
  }
  
  const adjacency = {};
  for (const bus of buses) {
    adjacency[bus.id] = [];
  }
  for (const line of lines) {
    adjacency[line.from_bus_id].push(line.to_bus_id);
    adjacency[line.to_bus_id].push(line.from_bus_id);
  }
  
  const visited = new Set();
  const components = [];
  
  for (const bus of buses) {
    if (visited.has(bus.id)) continue;
    const component = [];
    const queue = [bus.id];
    visited.add(bus.id);
    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const neighbor of adjacency[current] || []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  
  const isolatedBuses = [];
  for (const comp of components) {
    if (comp.length === 1) {
      const bus = buses.find(b => b.id === comp[0]);
      isolatedBuses.push({
        id: bus.id,
        code: bus.code,
        name: bus.name
      });
    }
  }
  
  const connected = components.length === 1;
  
  return {
    connected,
    total_buses: buses.length,
    total_lines: lines.length,
    component_count: components.length,
    isolated_buses: isolatedBuses,
    components,
    message: connected 
      ? '电网拓扑连通，所有节点在一个连通图中' 
      : `电网拓扑不连通，存在 ${components.length} 个连通分量，${isolatedBuses.length} 个孤立节点`
  };
}

function buildAdmittanceMatrix(buses, lines) {
  const busIndex = {};
  const indexBus = [];
  buses.forEach((bus, i) => {
    busIndex[bus.id] = i;
    indexBus.push(bus.id);
  });
  const n = buses.length;
  const B = Array(n).fill(0).map(() => Array(n).fill(0));
  
  for (const line of lines) {
    if (line.status !== 'in_service') continue;
    const i = busIndex[line.from_bus_id];
    const j = busIndex[line.to_bus_id];
    if (i === undefined || j === undefined) continue;
    const b = 1 / line.reactance;
    B[i][i] += b;
    B[j][j] += b;
    B[i][j] -= b;
    B[j][i] -= b;
  }
  
  return { B, busIndex, indexBus };
}

function solveDCLinear(B, P, slackBusIdx) {
  const n = B.length;
  if (n === 0) return [];
  
  const reducedN = n - 1;
  const BReduced = [];
  const PReduced = [];
  
  for (let i = 0; i < n; i++) {
    if (i === slackBusIdx) continue;
    const row = [];
    for (let j = 0; j < n; j++) {
      if (j === slackBusIdx) continue;
      row.push(B[i][j]);
    }
    BReduced.push(row);
    PReduced.push(P[i]);
  }
  
  if (reducedN === 0) return [0];
  
  const thetaReduced = gaussianElimination(BReduced, PReduced);
  
  const theta = [];
  let ri = 0;
  for (let i = 0; i < n; i++) {
    if (i === slackBusIdx) {
      theta.push(0);
    } else {
      theta.push(thetaReduced[ri]);
      ri++;
    }
  }
  
  return theta;
}

function gaussianElimination(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > maxVal) {
        maxVal = Math.abs(M[k][i]);
        maxRow = k;
      }
    }
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    
    if (Math.abs(M[i][i]) < 1e-10) {
      throw new Error('节点导纳矩阵奇异，电网可能不连通');
    }
    
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) {
        M[k][j] -= factor * M[i][j];
      }
    }
  }
  
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }
  
  return x;
}

function calculateBusInjections(busParticipantMap, participantOutputs) {
  const injections = {};
  for (const busId of Object.keys(busParticipantMap)) {
    let injection = 0;
    for (const pid of busParticipantMap[busId]) {
      const output = participantOutputs[pid];
      if (output !== undefined) {
        injection += output;
      }
    }
    injections[busId] = injection;
  }
  return injections;
}

function calculatePowerFlow(injectionData, allowImbalance = false) {
  const buses = listBuses();
  const lines = listLines();
  
  if (buses.length === 0) {
    throw new Error('电网无节点，请先录入电网节点');
  }
  
  const topo = checkTopologyConnectivity();
  if (!topo.connected) {
    throw new Error(topo.message);
  }
  
  const { B, busIndex, indexBus } = buildAdmittanceMatrix(buses, lines);
  
  const busParticipantMap = {};
  for (const bus of buses) {
    const participants = getBusParticipants(bus.id);
    busParticipantMap[bus.id] = participants.map(p => p.participant_id);
  }
  
  const injections = calculateBusInjections(busParticipantMap, injectionData);
  
  const P = buses.map(bus => injections[bus.id] || 0);
  
  const totalInjection = P.reduce((s, v) => s + v, 0);
  if (!allowImbalance && Math.abs(totalInjection) > 1e-6) {
    throw new Error(`节点注入功率不平衡，总和为 ${totalInjection.toFixed(4)} MW，必须为0`);
  }
  if (allowImbalance && Math.abs(totalInjection) > 1e-6) {
    P[0] -= totalInjection;
  }
  
  const slackBusIdx = 0;
  const theta = solveDCLinear(B, P, slackBusIdx);
  
  const busAngles = {};
  buses.forEach((bus, i) => {
    busAngles[bus.id] = {
      bus_id: bus.id,
      bus_code: bus.code,
      bus_name: bus.name,
      angle_rad: theta[i],
      angle_deg: theta[i] * 180 / Math.PI,
      injection: injections[bus.id] || 0
    };
  });
  
  const lineFlows = [];
  for (const line of lines) {
    if (line.status !== 'in_service') continue;
    const i = busIndex[line.from_bus_id];
    const j = busIndex[line.to_bus_id];
    const flow = (theta[i] - theta[j]) / line.reactance;
    lineFlows.push({
      line_id: line.id,
      line_code: line.code,
      from_bus_id: line.from_bus_id,
      from_bus_code: line.from_bus_code,
      to_bus_id: line.to_bus_id,
      to_bus_code: line.to_bus_code,
      flow_mw: flow,
      thermal_limit: line.thermal_limit,
      loading_percent: Math.abs(flow) / line.thermal_limit * 100,
      is_violated: Math.abs(flow) > line.thermal_limit
    });
  }
  
  return {
    bus_angles: Object.values(busAngles),
    line_flows: lineFlows,
    summary: {
      total_buses: buses.length,
      total_lines: lineFlows.length,
      violated_lines: lineFlows.filter(l => l.is_violated).length
    }
  };
}

function getClearingInjections(tradingDayId, hour) {
  const rows = db.prepare(`
    SELECT ca.participant_id, ca.final_dispatch, mp.type
    FROM clearing_allocations ca
    JOIN clearing_results cr ON ca.clearing_result_id = cr.id
    JOIN market_participants mp ON ca.participant_id = mp.id
    WHERE cr.trading_day_id = ? AND cr.hour = ?
  `).all(tradingDayId, hour);
  
  const injections = {};
  for (const row of rows) {
    if (row.type === 'generator') {
      injections[row.participant_id] = row.final_dispatch;
    } else {
      injections[row.participant_id] = -row.final_dispatch;
    }
  }
  return injections;
}

function performSecurityCheck(tradingDayId, hour) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  if (td.status === 'bidding') throw new Error('该交易日尚未出清');
  
  const buses = listBuses();
  const lines = listLines();
  if (buses.length === 0 || lines.length === 0) {
    throw new Error('请先录入电网节点和线路');
  }
  
  const topo = checkTopologyConnectivity();
  if (!topo.connected) {
    throw new Error(topo.message);
  }
  
  const injections = getClearingInjections(tradingDayId, hour);
  const flowResult = calculatePowerFlow(injections);
  
  const violations = flowResult.line_flows.filter(l => l.is_violated);
  
  let securityLevel = 'safe';
  let hasWarning = false;
  let hasCritical = false;
  
  for (const v of violations) {
    if (v.loading_percent > 120) {
      hasCritical = true;
    } else {
      hasWarning = true;
    }
  }
  
  if (hasCritical) {
    securityLevel = 'critical';
  } else if (hasWarning) {
    securityLevel = 'warning';
  }
  
  const alertId = uuidv4();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO grid_security_alerts (id, trading_day_id, trade_date, hour, security_level, alert_details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      alertId, tradingDayId, td.trade_date, hour, securityLevel,
      JSON.stringify({
        bus_count: flowResult.summary.total_buses,
        line_count: flowResult.summary.total_lines,
        violated_count: violations.length
      })
    );
    
    const insertViolation = db.prepare(`
      INSERT INTO grid_security_violations (id, alert_id, line_id, line_code, actual_flow, thermal_limit, violation_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const v of violations) {
      insertViolation.run(
        uuidv4(), alertId, v.line_id, v.line_code,
        v.flow_mw, v.thermal_limit, v.loading_percent / 100
      );
    }
  });
  tx();
  
  return {
    alert_id: alertId,
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    hour,
    security_level: securityLevel,
    violations: violations.map(v => ({
      line_id: v.line_id,
      line_code: v.line_code,
      actual_flow_mw: v.flow_mw,
      thermal_limit_mw: v.thermal_limit,
      violation_percent: v.loading_percent
    })),
    all_line_flows: flowResult.line_flows,
    bus_angles: flowResult.bus_angles
  };
}

function performFullDaySecurityCheck(tradingDayId) {
  const results = [];
  for (let h = 0; h < 24; h++) {
    try {
      const result = performSecurityCheck(tradingDayId, h);
      results.push(result);
    } catch (e) {
      results.push({
        hour: h,
        error: e.message
      });
    }
  }
  
  let worstLevel = 'safe';
  for (const r of results) {
    if (r.security_level === 'critical') {
      worstLevel = 'critical';
      break;
    } else if (r.security_level === 'warning' && worstLevel !== 'critical') {
      worstLevel = 'warning';
    }
  }
  
  return {
    trading_day_id: tradingDayId,
    overall_security_level: worstLevel,
    hourly_results: results
  };
}

function listSecurityAlerts(tradingDayId = null) {
  let sql = `
    SELECT gsa.*, 
           COUNT(gsv.id) as violation_count
    FROM grid_security_alerts gsa
    LEFT JOIN grid_security_violations gsv ON gsa.id = gsv.alert_id
  `;
  const params = [];
  if (tradingDayId) {
    sql += ' WHERE gsa.trading_day_id = ?';
    params.push(tradingDayId);
  }
  sql += ' GROUP BY gsa.id ORDER BY gsa.trade_date DESC, gsa.hour DESC';
  
  const rows = db.prepare(sql).all(...params);
  
  return rows.map(row => {
    const details = JSON.parse(row.alert_details || '{}');
    return {
      id: row.id,
      trading_day_id: row.trading_day_id,
      trade_date: row.trade_date,
      hour: row.hour,
      security_level: row.security_level,
      violation_count: row.violation_count,
      details,
      created_at: row.created_at
    };
  });
}

function getAlertDetails(alertId) {
  const alertRow = db.prepare(`
    SELECT * FROM grid_security_alerts WHERE id = ?
  `).get(alertId);
  if (!alertRow) return null;
  
  const violations = db.prepare(`
    SELECT * FROM grid_security_violations WHERE alert_id = ?
  `).all(alertId);
  
  return {
    id: alertRow.id,
    trading_day_id: alertRow.trading_day_id,
    trade_date: alertRow.trade_date,
    hour: alertRow.hour,
    security_level: alertRow.security_level,
    details: JSON.parse(alertRow.alert_details || '{}'),
    violations: violations.map(v => ({
      id: v.id,
      line_id: v.line_id,
      line_code: v.line_code,
      actual_flow_mw: v.actual_flow,
      thermal_limit_mw: v.thermal_limit,
      violation_ratio: v.violation_ratio,
      violation_percent: v.violation_ratio * 100
    })),
    created_at: alertRow.created_at
  };
}

function computeGSDF(buses, lines, busIndex, lineList) {
  const n = buses.length;
  const slackIdx = 0;
  
  const B = Array(n).fill(0).map(() => Array(n).fill(0));
  for (const line of lines) {
    if (line.status !== 'in_service') continue;
    const i = busIndex[line.from_bus_id];
    const j = busIndex[line.to_bus_id];
    if (i === undefined || j === undefined) continue;
    const b = 1 / line.reactance;
    B[i][i] += b;
    B[j][j] += b;
    B[i][j] -= b;
    B[j][i] -= b;
  }
  
  const reducedN = n - 1;
  const BRed = [];
  const idxMap = [];
  for (let i = 0; i < n; i++) {
    if (i === slackIdx) continue;
    idxMap.push(i);
    const row = [];
    for (let j = 0; j < n; j++) {
      if (j === slackIdx) continue;
      row.push(B[i][j]);
    }
    BRed.push(row);
  }
  
  const solveTheta = (busKIdx) => {
    if (busKIdx === slackIdx) {
      const rhs = Array(reducedN).fill(-1);
      return gaussianElimination(BRed.map(r => r.slice()), rhs);
    } else {
      const kRed = idxMap.indexOf(busKIdx);
      if (kRed < 0) return null;
      const rhs = Array(reducedN).fill(0);
      rhs[kRed] = 1;
      return gaussianElimination(BRed.map(r => r.slice()), rhs);
    }
  };
  
  const gsdf = {};
  
  for (let lineIdx = 0; lineIdx < lineList.length; lineIdx++) {
    const line = lineList[lineIdx];
    if (line.status !== 'in_service') continue;
    const fromI = busIndex[line.from_bus_id];
    const toI = busIndex[line.to_bus_id];
    if (fromI === undefined || toI === undefined) continue;
    const b_l = 1 / line.reactance;
    
    for (let busK = 0; busK < n; busK++) {
      const thetaRed = solveTheta(busK);
      if (!thetaRed) continue;
      
      let thetaFrom = 0;
      let thetaTo = 0;
      if (fromI !== slackIdx) {
        thetaFrom = thetaRed[idxMap.indexOf(fromI)];
      }
      if (toI !== slackIdx) {
        thetaTo = thetaRed[idxMap.indexOf(toI)];
      }
      
      const sensitivity = b_l * (thetaFrom - thetaTo);
      if (!gsdf[line.id]) gsdf[line.id] = {};
      gsdf[line.id][buses[busK].id] = sensitivity;
    }
  }
  
  return gsdf;
}

function computeViolationSeverity(violations) {
  let severity = 0;
  for (const v of violations) {
    const loading = v.loading_percent !== undefined ? v.loading_percent : (Math.abs(v.actual_flow_mw || v.flow_mw || 0) / (v.thermal_limit_mw || v.thermal_limit || 1) * 100);
    severity += Math.max(0, loading - 100);
  }
  return severity;
}

function generateRedispatchSuggestion(alertId) {
  const STEP_MW = 10;
  const MAX_ITERATIONS = 30;
  
  const alert = getAlertDetails(alertId);
  if (!alert) throw new Error('安全校核告警不存在');
  if (alert.violations.length === 0) {
    throw new Error('该告警无越限线路，无需调整');
  }
  
  const tradingDayId = alert.trading_day_id;
  const hour = alert.hour;
  const td = getTradingDayById(tradingDayId);
  
  const buses = listBuses();
  const busIndex = {};
  buses.forEach((bus, i) => { busIndex[bus.id] = i; });
  
  const lines = listLines();
  
  const busParticipantMap = {};
  for (const bus of buses) {
    const participants = getBusParticipants(bus.id);
    busParticipantMap[bus.id] = participants.map(p => p.participant_id);
  }
  
  const participantBusMap = {};
  for (const [busId, pids] of Object.entries(busParticipantMap)) {
    for (const pid of pids) {
      if (!participantBusMap[pid]) participantBusMap[pid] = [];
      participantBusMap[pid].push(busId);
    }
  }
  
  const allParticipants = listParticipants('generator');
  const participantMap = {};
  for (const p of allParticipants) participantMap[p.id] = p;
  
  const clearingRows = db.prepare(`
    SELECT ca.participant_id, ca.final_dispatch, mp.type, mp.code, mp.name
    FROM clearing_allocations ca
    JOIN clearing_results cr ON ca.clearing_result_id = cr.id
    JOIN market_participants mp ON ca.participant_id = mp.id
    WHERE cr.trading_day_id = ? AND cr.hour = ? AND mp.type = 'generator'
  `).all(tradingDayId, hour);
  
  const generatorBids = db.prepare(`
    SELECT gb.participant_id, gb.price, gb.capacity, gb.segment_index
    FROM generator_bids gb
    WHERE gb.trading_day_id = ? AND gb.hour = ?
    ORDER BY gb.participant_id, gb.segment_index
  `).all(tradingDayId, hour);
  
  const genMaxOutput = {};
  for (const row of generatorBids) {
    if (!genMaxOutput[row.participant_id]) genMaxOutput[row.participant_id] = 0;
    genMaxOutput[row.participant_id] += row.capacity;
  }
  
  const genBidPrice = {};
  const genGrouped = {};
  for (const row of generatorBids) {
    if (!genGrouped[row.participant_id]) genGrouped[row.participant_id] = [];
    genGrouped[row.participant_id].push(row);
  }
  for (const [pid, segs] of Object.entries(genGrouped)) {
    const sorted = segs.sort((a, b) => a.segment_index - b.segment_index);
    if (sorted.length > 0) {
      genBidPrice[pid] = sorted[sorted.length - 1].price;
    }
  }
  
  const currentOutput = {};
  for (const row of clearingRows) {
    currentOutput[row.participant_id] = row.final_dispatch;
  }
  
  const consumerRows = db.prepare(`
    SELECT ca.participant_id, ca.final_dispatch
    FROM clearing_allocations ca
    JOIN clearing_results cr ON ca.clearing_result_id = cr.id
    JOIN market_participants mp ON ca.participant_id = mp.id
    WHERE cr.trading_day_id = ? AND cr.hour = ? AND mp.type = 'consumer'
  `).all(tradingDayId, hour);
  const consumerInjections = {};
  for (const row of consumerRows) {
    consumerInjections[row.participant_id] = -row.final_dispatch;
  }
  
  const violatedLines = alert.violations;
  const violatedLineIds = new Set(violatedLines.map(v => v.line_id));
  
  const activeLines = lines.filter(l => l.status === 'in_service');
  const gsdf = computeGSDF(buses, lines, busIndex, activeLines);
  
  const genSensitivity = {};
  for (const pid of Object.keys(currentOutput)) {
    const participant = participantMap[pid];
    if (!participant) continue;
    const busIds = participantBusMap[pid] || [];
    if (busIds.length === 0) continue;
    
    let totalScoreDown = 0;
    let totalScoreUp = 0;
    
    for (const busId of busIds) {
      for (const v of violatedLines) {
        const sens = gsdf[v.line_id]?.[busId];
        if (sens === undefined) continue;
        const overloadMW = Math.abs(v.actual_flow_mw) - v.thermal_limit_mw;
        if (overloadMW <= 0) continue;
        
        const line = lines.find(l => l.id === v.line_id);
        if (!line) continue;
        const flowDir = v.actual_flow_mw > 0 ? 1 : -1;
        
        const reliefDown = sens * flowDir * STEP_MW;
        if (reliefDown > 0) totalScoreDown += reliefDown / Math.max(1, overloadMW);
        
        const reliefUp = -sens * flowDir * STEP_MW;
        if (reliefUp > 0) totalScoreUp += reliefUp / Math.max(1, overloadMW);
      }
    }
    
    genSensitivity[pid] = {
      participant_id: pid,
      code: participant.code,
      name: participant.name,
      bid_price: genBidPrice[pid] || 9999,
      current_output: currentOutput[pid],
      installed_capacity: participant.installed_capacity || genMaxOutput[pid] || 0,
      can_decrease: currentOutput[pid] >= STEP_MW,
      can_increase: (participant.installed_capacity || genMaxOutput[pid] || 0) - currentOutput[pid] >= STEP_MW,
      score_down: totalScoreDown,
      score_up: totalScoreUp
    };
  }
  
  const buildInjections = (outputs) => {
    const inj = {};
    for (const [pid, out] of Object.entries(outputs)) inj[pid] = out;
    Object.assign(inj, consumerInjections);
    return inj;
  };
  
  const checkViolation = (outputs) => {
    try {
      const result = calculatePowerFlow(buildInjections(outputs), true);
      return result.line_flows.filter(l => l.is_violated);
    } catch (e) {
      return violatedLines.map(v => ({
        line_id: v.line_id,
        line_code: v.line_code,
        flow_mw: v.actual_flow_mw,
        thermal_limit: v.thermal_limit_mw,
        loading_percent: v.violation_percent,
        is_violated: true
      }));
    }
  };
  
  const ADJUSTED_SET = new Set();
  
  const adjustments = [];
  const adjustedOutput = { ...currentOutput };
  let remainingViolations = checkViolation(adjustedOutput);
  let currentSeverity = computeViolationSeverity(remainingViolations);
  let iteration = 0;
  let noImprovementCount = 0;
  
  while (remainingViolations.length > 0 && iteration < MAX_ITERATIONS && noImprovementCount < 3) {
    iteration++;
    
    const downCandidates = [];
    const upCandidates = [];
    for (const pid of Object.keys(genSensitivity)) {
      const s = genSensitivity[pid];
      const output = adjustedOutput[pid];
      const canDown = output >= STEP_MW;
      const canUp = (s.installed_capacity - output) >= STEP_MW;
      
      if (canDown && s.score_down > 0.001) {
        downCandidates.push({
          pid,
          score: s.score_down - s.bid_price * 0.0001,
          sensitivity: s
        });
      }
      if (canUp && s.score_up > 0.001) {
        upCandidates.push({
          pid,
          score: s.score_up + (9999 - s.bid_price) * 0.0001,
          sensitivity: s
        });
      }
    }
    
    downCandidates.sort((a, b) => b.score - a.score);
    upCandidates.sort((a, b) => b.score - a.score);
    
    let bestPair = null;
    let bestSeverity = currentSeverity;
    
    const topDowns = downCandidates.slice(0, 6);
    const topUps = upCandidates.slice(0, 6);
    
    for (let i = 0; i < topDowns.length; i++) {
      for (let j = 0; j < topUps.length; j++) {
        const dc = topDowns[i];
        const uc = topUps[j];
        if (dc.pid === uc.pid) continue;
        if (ADJUSTED_SET.has(dc.pid + '_decrease_' + uc.pid + '_increase') && iteration > 5) continue;
        
        const trialOutput = { ...adjustedOutput };
        trialOutput[dc.pid] -= STEP_MW;
        trialOutput[uc.pid] += STEP_MW;
        
        const trialViolations = checkViolation(trialOutput);
        const trialSeverity = computeViolationSeverity(trialViolations);
        
        if (trialSeverity < bestSeverity - 0.001) {
          bestSeverity = trialSeverity;
          bestPair = {
            down: dc,
            up: uc,
            trial_output: trialOutput,
            trial_violations: trialViolations,
            trial_severity: trialSeverity
          };
        }
      }
    }
    
    for (const dc of topDowns.slice(0, 3)) {
      if (ADJUSTED_SET.has(dc.pid + '_decrease_only') && iteration > 5) continue;
      const trialOutput = { ...adjustedOutput };
      trialOutput[dc.pid] -= STEP_MW;
      const trialViolations = checkViolation(trialOutput);
      const trialSeverity = computeViolationSeverity(trialViolations);
      if (trialSeverity < bestSeverity - 0.001) {
        bestSeverity = trialSeverity;
        bestPair = {
          down: dc,
          up: null,
          trial_output: trialOutput,
          trial_violations: trialViolations,
          trial_severity: trialSeverity
        };
      }
    }
    for (const uc of topUps.slice(0, 3)) {
      if (ADJUSTED_SET.has(uc.pid + '_increase_only') && iteration > 5) continue;
      const trialOutput = { ...adjustedOutput };
      trialOutput[uc.pid] += STEP_MW;
      const trialViolations = checkViolation(trialOutput);
      const trialSeverity = computeViolationSeverity(trialViolations);
      if (trialSeverity < bestSeverity - 0.001) {
        bestSeverity = trialSeverity;
        bestPair = {
          down: null,
          up: uc,
          trial_output: trialOutput,
          trial_violations: trialViolations,
          trial_severity: trialSeverity
        };
      }
    }
    
    if (!bestPair) {
      noImprovementCount++;
      break;
    }
    
    if (bestPair.down) {
      const pid = bestPair.down.pid;
      const s = bestPair.down.sensitivity;
      const oldOutput = adjustedOutput[pid];
      adjustedOutput[pid] -= STEP_MW;
      adjustments.push({
        participant_id: pid, code: s.code, name: s.name,
        action: 'decrease', amount_mw: STEP_MW, bid_price: s.bid_price,
        from_output: oldOutput, to_output: oldOutput - STEP_MW,
        relief_score: s.score_down
      });
      if (bestPair.up) {
        ADJUSTED_SET.add(pid + '_decrease_' + bestPair.up.pid + '_increase');
      } else {
        ADJUSTED_SET.add(pid + '_decrease_only');
      }
    }
    
    if (bestPair.up) {
      const pid = bestPair.up.pid;
      const s = bestPair.up.sensitivity;
      const oldOutput = adjustedOutput[pid];
      adjustedOutput[pid] += STEP_MW;
      adjustments.push({
        participant_id: pid, code: s.code, name: s.name,
        action: 'increase', amount_mw: STEP_MW, bid_price: s.bid_price,
        from_output: oldOutput, to_output: oldOutput + STEP_MW,
        relief_score: s.score_up
      });
      if (!bestPair.down) {
        ADJUSTED_SET.add(pid + '_increase_only');
      }
    }
    
    remainingViolations = bestPair.trial_violations;
    const newSeverity = computeViolationSeverity(remainingViolations);
    if (newSeverity >= currentSeverity - 0.001) {
      noImprovementCount++;
    } else {
      noImprovementCount = 0;
    }
    currentSeverity = newSeverity;
  }
  
  const finalViolations = checkViolation(adjustedOutput);
  const originalViolationCount = violatedLines.length;
  const finalViolationCount = finalViolations.length;
  
  const mergedAdjustments = [];
  const adjMap = {};
  for (const adj of adjustments) {
    const key = adj.participant_id;
    if (!adjMap[key]) {
      adjMap[key] = {
        participant_id: adj.participant_id,
        code: adj.code,
        name: adj.name,
        total_decrease: 0,
        total_increase: 0,
        bid_price: adj.bid_price,
        from_output: adj.from_output,
        to_output: adj.to_output
      };
    }
    if (adj.action === 'decrease') {
      adjMap[key].total_decrease += adj.amount_mw;
    } else {
      adjMap[key].total_increase += adj.amount_mw;
    }
    adjMap[key].to_output = adj.to_output;
  }
  for (const [pid, info] of Object.entries(adjMap)) {
    const net = info.total_increase - info.total_decrease;
    if (Math.abs(net) < 0.5) continue;
    mergedAdjustments.push({
      participant_id: pid,
      code: info.code,
      name: info.name,
      action: net > 0 ? 'increase' : 'decrease',
      amount_mw: Math.abs(net),
      bid_price: info.bid_price,
      from_output: info.from_output,
      to_output: info.to_output
    });
  }
  
  const suggestionId = uuidv4();
  db.prepare(`
    INSERT INTO grid_redispatch_suggestions 
    (id, alert_id, trading_day_id, hour, original_state, adjusted_state, adjustments, expected_relief)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    suggestionId, alertId, tradingDayId, hour,
    JSON.stringify(currentOutput),
    JSON.stringify(adjustedOutput),
    JSON.stringify(mergedAdjustments),
    JSON.stringify({
      original_violation_count: originalViolationCount,
      final_violation_count: finalViolationCount,
      relieved_count: originalViolationCount - finalViolationCount,
      original_severity: computeViolationSeverity(violatedLines.map(v => ({
        loading_percent: v.violation_percent
      }))),
      final_severity: computeViolationSeverity(finalViolations),
      iterations: iteration,
      remaining_violations: finalViolations.map(v => ({
        line_id: v.line_id,
        line_code: v.line_code,
        flow_mw: v.flow_mw,
        limit_mw: v.thermal_limit,
        loading_percent: v.loading_percent
      }))
    })
  );
  
  return {
    suggestion_id: suggestionId,
    alert_id: alertId,
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    hour,
    iterations: iteration,
    adjustments: mergedAdjustments,
    original_violations: violatedLines.map(v => ({
      line_code: v.line_code,
      actual_flow_mw: v.actual_flow_mw,
      limit_mw: v.thermal_limit_mw,
      loading_percent: v.violation_percent
    })),
    expected_relief: {
      original_violation_count: originalViolationCount,
      final_violation_count: finalViolationCount,
      relieved_count: originalViolationCount - finalViolationCount,
      original_severity: computeViolationSeverity(violatedLines.map(v => ({
        loading_percent: v.violation_percent
      }))),
      final_severity: computeViolationSeverity(finalViolations),
      remaining_violations: finalViolations.map(v => ({
        line_code: v.line_code,
        flow_mw: v.flow_mw,
        limit_mw: v.thermal_limit,
        loading_percent: v.loading_percent
      }))
    }
  };
}

function performNMinus1Check(tradingDayId, hour) {
  const td = getTradingDayById(tradingDayId);
  if (!td) throw new Error('交易日不存在');
  
  const buses = listBuses();
  const allLines = listLines();
  if (buses.length === 0 || allLines.length === 0) {
    throw new Error('请先录入电网节点和线路');
  }
  
  const injections = getClearingInjections(tradingDayId, hour);
  const results = [];
  
  for (const outageLine of allLines) {
    const remainingLines = allLines.filter(l => l.id !== outageLine.id);
    
    const adjacency = {};
    for (const bus of buses) adjacency[bus.id] = [];
    for (const line of remainingLines) {
      if (line.status !== 'in_service') continue;
      adjacency[line.from_bus_id].push(line.to_bus_id);
      adjacency[line.to_bus_id].push(line.from_bus_id);
    }
    
    const visited = new Set();
    let componentCount = 0;
    for (const bus of buses) {
      if (visited.has(bus.id)) continue;
      componentCount++;
      const queue = [bus.id];
      visited.add(bus.id);
      while (queue.length > 0) {
        const cur = queue.shift();
        for (const nb of adjacency[cur] || []) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
    }
    
    const isIslanded = componentCount > 1;
    let violations = [];
    
    if (!isIslanded) {
      try {
        const { B, busIndex } = buildAdmittanceMatrix(buses, remainingLines);
        
        const busParticipantMap = {};
        for (const bus of buses) {
          const participants = getBusParticipants(bus.id);
          busParticipantMap[bus.id] = participants.map(p => p.participant_id);
        }
        
        const busInjections = calculateBusInjections(busParticipantMap, injections);
        const P = buses.map(bus => busInjections[bus.id] || 0);
        
        const slackBusIdx = 0;
        const theta = solveDCLinear(B, P, slackBusIdx);
        
        for (const line of remainingLines) {
          if (line.status !== 'in_service') continue;
          const i = busIndex[line.from_bus_id];
          const j = busIndex[line.to_bus_id];
          const flow = (theta[i] - theta[j]) / line.reactance;
          if (Math.abs(flow) > line.thermal_limit) {
            violations.push({
              line_id: line.id,
              line_code: line.code,
              flow_mw: flow,
              thermal_limit_mw: line.thermal_limit,
              loading_percent: Math.abs(flow) / line.thermal_limit * 100
            });
          }
        }
      } catch (e) {
        violations = [{ error: e.message }];
      }
    }
    
    const isCritical = isIslanded || violations.length > 0;
    
    const resultId = uuidv4();
    db.prepare(`
      INSERT INTO grid_nminus1_results 
      (id, trading_day_id, trade_date, hour, outage_line_id, outage_line_code, 
       is_critical, system_islanded, violation_details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      resultId, tradingDayId, td.trade_date, hour,
      outageLine.id, outageLine.code,
      isCritical ? 1 : 0,
      isIslanded ? 1 : 0,
      JSON.stringify(violations)
    );
    
    results.push({
      result_id: resultId,
      outage_line_id: outageLine.id,
      outage_line_code: outageLine.code,
      outage_line_name: outageLine.from_bus_code + '-' + outageLine.to_bus_code,
      is_critical: isCritical,
      system_islanded: isIslanded,
      violation_count: violations.length,
      violations
    });
  }
  
  const criticalLines = results.filter(r => r.is_critical).map(r => r.outage_line_code);
  
  return {
    trading_day_id: tradingDayId,
    trade_date: td.trade_date,
    hour,
    total_lines: allLines.length,
    critical_line_count: criticalLines.length,
    critical_lines: criticalLines,
    scenario_results: results
  };
}

function listNMinus1Results(tradingDayId = null) {
  let sql = `
    SELECT * FROM grid_nminus1_results
  `;
  const params = [];
  if (tradingDayId) {
    sql += ' WHERE trading_day_id = ?';
    params.push(tradingDayId);
  }
  sql += ' ORDER BY trade_date DESC, hour DESC';
  
  const rows = db.prepare(sql).all(...params);
  return rows.map(row => ({
    id: row.id,
    trading_day_id: row.trading_day_id,
    trade_date: row.trade_date,
    hour: row.hour,
    outage_line_id: row.outage_line_id,
    outage_line_code: row.outage_line_code,
    is_critical: row.is_critical === 1,
    system_islanded: row.system_islanded === 1,
    violations: JSON.parse(row.violation_details || '[]'),
    created_at: row.created_at
  }));
}

module.exports = {
  createBus,
  getBusById,
  getBusByCode,
  listBuses,
  createLine,
  getLineById,
  listLines,
  attachParticipantToBus,
  detachParticipantFromBus,
  getBusParticipants,
  getParticipantBuses,
  checkTopologyConnectivity,
  calculatePowerFlow,
  performSecurityCheck,
  performFullDaySecurityCheck,
  listSecurityAlerts,
  getAlertDetails,
  generateRedispatchSuggestion,
  performNMinus1Check,
  listNMinus1Results
};
