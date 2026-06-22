const { v4: uuidv4 } = require('uuid');
const db = require('../utils/db');
const participantService = require('./participantService');

const RESOURCE_TYPES = ['storage', 'interruptible_load', 'solar_pv', 'charging_pile'];
const RESOURCE_TYPE_LABELS = {
  storage: '储能',
  interruptible_load: '可中断负荷',
  solar_pv: '分布式光伏',
  charging_pile: '充电桩'
};
const UNRELIABLE_DISCOUNT = 0.7;
const DEFAULT_SERVICE_FEE_RATIO = 0.1;
const COMPLIANCE_THRESHOLD = 0.9;
const CONSECUTIVE_FAILURES_FOR_UNRELIABLE = 5;

function getResourceAdjustableRange(resource, tradingDayId, hour) {
  const { type, rated_power_kw, is_reliable } = resource;
  const discount = is_reliable ? 1 : UNRELIABLE_DISCOUNT;
  let minKw = 0;
  let maxKw = 0;

  const state = db.prepare(`
    SELECT * FROM vpp_resource_states
    WHERE resource_id = ? AND (trading_day_id = ? OR trading_day_id IS NULL)
    AND (hour = ? OR hour IS NULL)
    ORDER BY trading_day_id DESC NULLS LAST, hour DESC NULLS LAST
    LIMIT 1
  `).get(resource.id, tradingDayId, hour);

  switch (type) {
    case 'storage': {
      const soc = state ? state.soc : 0.5;
      const maxCharge = state && state.max_charge_power_kw != null ? state.max_charge_power_kw : rated_power_kw;
      const maxDischarge = state && state.max_discharge_power_kw != null ? state.max_discharge_power_kw : rated_power_kw;
      minKw = -Math.min(maxCharge, rated_power_kw) * discount * (soc < 1 ? 1 : 0);
      maxKw = Math.min(maxDischarge, rated_power_kw) * discount * (soc > 0 ? 1 : 0);
      break;
    }
    case 'interruptible_load': {
      maxKw = rated_power_kw * discount;
      minKw = 0;
      break;
    }
    case 'solar_pv': {
      const availFactor = state ? (state.availability_factor != null ? state.availability_factor : 0) : 0;
      maxKw = rated_power_kw * availFactor * discount;
      minKw = 0;
      break;
    }
    case 'charging_pile': {
      maxKw = rated_power_kw * discount;
      minKw = 0;
      break;
    }
  }

  return {
    min_kw: Math.round(minKw * 10000) / 10000,
    max_kw: Math.round(maxKw * 10000) / 10000,
    state: state || null
  };
}

function registerAggregator(data) {
  const { code, name, contact_person, contact_phone, service_fee_ratio, participant_code } = data;

  if (!code || !name) {
    throw new Error('聚合商编码和名称为必填项');
  }

  const existing = db.prepare('SELECT id FROM vpp_aggregators WHERE code = ?').get(code);
  if (existing) {
    throw new Error('聚合商编码已存在');
  }

  const feeRatio = service_fee_ratio != null ? service_fee_ratio : DEFAULT_SERVICE_FEE_RATIO;
  if (feeRatio < 0 || feeRatio > 1) {
    throw new Error('服务费比例必须在0到1之间');
  }

  const tx = db.transaction(() => {
    const partCode = participant_code || code;
    let participant;
    try {
      participant = participantService.getParticipantByCode(partCode);
    } catch (e) {
      participant = null;
    }
    if (!participant) {
      participant = participantService.registerParticipant({
        code: partCode,
        name: name + '(虚拟电厂)',
        type: 'generator',
        installed_capacity: 99999,
        min_output: 0,
        ramp_rate: 9999
      });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO vpp_aggregators (id, code, name, participant_id, contact_person, contact_phone, service_fee_ratio)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, code, name, participant.id, contact_person, contact_phone, feeRatio);

    return id;
  });

  const aggregatorId = tx();
  return getAggregatorById(aggregatorId);
}

function getAggregatorById(id) {
  return db.prepare(`
    SELECT a.*, p.code as participant_code, p.name as participant_name
    FROM vpp_aggregators a
    LEFT JOIN market_participants p ON a.participant_id = p.id
    WHERE a.id = ?
  `).get(id);
}

function getAggregatorByCode(code) {
  return db.prepare(`
    SELECT a.*, p.code as participant_code, p.name as participant_name
    FROM vpp_aggregators a
    LEFT JOIN market_participants p ON a.participant_id = p.id
    WHERE a.code = ?
  `).get(code);
}

function listAggregators() {
  return db.prepare(`
    SELECT a.*, p.code as participant_code, p.name as participant_name
    FROM vpp_aggregators a
    LEFT JOIN market_participants p ON a.participant_id = p.id
    ORDER BY a.created_at DESC
  `).all();
}

function registerResource(data) {
  const { code, name, aggregator_id, type, rated_power_kw, ramp_rate_kw_per_min, owner_name } = data;

  if (!code || !name || !aggregator_id || !type || rated_power_kw == null) {
    throw new Error('资源编码、名称、所属聚合商、类型、额定功率为必填项');
  }

  if (!RESOURCE_TYPES.includes(type)) {
    throw new Error(`资源类型必须是: ${RESOURCE_TYPES.join(', ')}`);
  }

  if (rated_power_kw <= 0) {
    throw new Error('额定功率必须大于0');
  }

  if (ramp_rate_kw_per_min != null && ramp_rate_kw_per_min < 0) {
    throw new Error('爬坡速率不能为负数');
  }

  const aggregator = getAggregatorById(aggregator_id);
  if (!aggregator) {
    throw new Error('所属聚合商不存在');
  }

  const existing = db.prepare('SELECT id FROM vpp_resources WHERE code = ?').get(code);
  if (existing) {
    throw new Error('资源编码已存在');
  }

  const rampRate = ramp_rate_kw_per_min != null ? ramp_rate_kw_per_min : 0;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO vpp_resources (id, code, name, aggregator_id, type, rated_power_kw, ramp_rate_kw_per_min, owner_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, code, name, aggregator_id, type, rated_power_kw, rampRate, owner_name);

  return getResourceById(id);
}

function getResourceById(id) {
  return db.prepare(`
    SELECT r.*, a.code as aggregator_code, a.name as aggregator_name
    FROM vpp_resources r
    LEFT JOIN vpp_aggregators a ON r.aggregator_id = a.id
    WHERE r.id = ?
  `).get(id);
}

function getResourceByCode(code) {
  return db.prepare(`
    SELECT r.*, a.code as aggregator_code, a.name as aggregator_name
    FROM vpp_resources r
    LEFT JOIN vpp_aggregators a ON r.aggregator_id = a.id
    WHERE r.code = ?
  `).get(code);
}

function listResourcesByAggregator(aggregatorId) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }
  return db.prepare(`
    SELECT r.*, a.code as aggregator_code, a.name as aggregator_name
    FROM vpp_resources r
    LEFT JOIN vpp_aggregators a ON r.aggregator_id = a.id
    WHERE r.aggregator_id = ?
    ORDER BY r.created_at DESC
  `).all(aggregatorId);
}

function updateResourceState(resourceId, tradingDayId, hour, stateData) {
  const resource = getResourceById(resourceId);
  if (!resource) {
    throw new Error('资源不存在');
  }

  const { availability_factor, soc, max_charge_power_kw, max_discharge_power_kw } = stateData;

  if (availability_factor != null && (availability_factor < 0 || availability_factor > 1)) {
    throw new Error('可用系数必须在0到1之间');
  }
  if (soc != null && (soc < 0 || soc > 1)) {
    throw new Error('荷电状态必须在0到1之间');
  }

  const existing = db.prepare(`
    SELECT id FROM vpp_resource_states
    WHERE resource_id = ? AND trading_day_id IS ? AND hour IS ?
  `).get(resourceId, tradingDayId || null, hour || null);

  const id = existing ? existing.id : uuidv4();

  if (existing) {
    db.prepare(`
      UPDATE vpp_resource_states SET
        availability_factor = COALESCE(?, availability_factor),
        soc = COALESCE(?, soc),
        max_charge_power_kw = COALESCE(?, max_charge_power_kw),
        max_discharge_power_kw = COALESCE(?, max_discharge_power_kw)
      WHERE id = ?
    `).run(availability_factor, soc, max_charge_power_kw, max_discharge_power_kw, id);
  } else {
    db.prepare(`
      INSERT INTO vpp_resource_states (id, resource_id, trading_day_id, hour, availability_factor, soc, max_charge_power_kw, max_discharge_power_kw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, resourceId, tradingDayId || null, hour || null,
          availability_factor != null ? availability_factor : null,
          soc != null ? soc : null,
          max_charge_power_kw != null ? max_charge_power_kw : null,
          max_discharge_power_kw != null ? max_discharge_power_kw : null);
  }

  return db.prepare('SELECT * FROM vpp_resource_states WHERE id = ?').get(id);
}

function getResourceState(resourceId, tradingDayId, hour) {
  return db.prepare(`
    SELECT * FROM vpp_resource_states
    WHERE resource_id = ? AND (trading_day_id = ? OR trading_day_id IS NULL)
    AND (hour = ? OR hour IS NULL)
    ORDER BY trading_day_id DESC NULLS LAST, hour DESC NULLS LAST
    LIMIT 1
  `).get(resourceId, tradingDayId, hour);
}

function listResourceStatesByAggregator(aggregatorId, tradingDayId) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }
  return db.prepare(`
    SELECT r.id as resource_id, r.code as resource_code, r.name as resource_name, r.type, r.rated_power_kw,
           s.*
    FROM vpp_resources r
    LEFT JOIN vpp_resource_states s ON s.resource_id = r.id
      AND (s.trading_day_id = ? OR s.trading_day_id IS NULL)
    WHERE r.aggregator_id = ?
    ORDER BY r.code
  `).all(tradingDayId, aggregatorId);
}

function calculateAggregatorAdjustableCapacity(aggregatorId, tradingDayId, hour) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  const resources = listResourcesByAggregator(aggregatorId);
  let totalMaxKw = 0;
  let totalMinKw = 0;
  const resourceDetails = [];

  for (const r of resources) {
    const range = getResourceAdjustableRange(r, tradingDayId, hour);
    totalMaxKw += range.max_kw;
    totalMinKw += range.min_kw;
    resourceDetails.push({
      resource_id: r.id,
      resource_code: r.code,
      resource_name: r.name,
      type: r.type,
      type_label: RESOURCE_TYPE_LABELS[r.type],
      rated_power_kw: r.rated_power_kw,
      is_reliable: r.is_reliable,
      adjustable_min_kw: range.min_kw,
      adjustable_max_kw: range.max_kw
    });
  }

  return {
    aggregator_id: aggregatorId,
    aggregator_code: aggregator.code,
    aggregator_name: aggregator.name,
    trading_day_id: tradingDayId,
    hour: hour,
    total_adjustable_min_mw: Math.round(totalMinKw / 1000 * 10000) / 10000,
    total_adjustable_max_mw: Math.round(totalMaxKw / 1000 * 10000) / 10000,
    total_adjustable_min_kw: Math.round(totalMinKw * 10000) / 10000,
    total_adjustable_max_kw: Math.round(totalMaxKw * 10000) / 10000,
    resource_count: resources.length,
    resources: resourceDetails
  };
}

function calculateVppAdjustableCapacity(aggregatorId, tradingDayId) {
  const hourly = [];
  for (let h = 0; h < 24; h++) {
    hourly.push(calculateAggregatorAdjustableCapacity(aggregatorId, tradingDayId, h));
  }
  return hourly;
}

function submitVppBid(aggregatorId, tradingDayId, bids) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  if (!Array.isArray(bids) || bids.length === 0) {
    throw new Error('报价数据不能为空');
  }

  const tx = db.transaction(() => {
    for (const bid of bids) {
      const { hour, adjustable_capacity_mw, price_yuan_per_mwh } = bid;
      if (hour == null || hour < 0 || hour > 23) {
        throw new Error('时段必须在0-23之间');
      }
      if (adjustable_capacity_mw == null || adjustable_capacity_mw < 0) {
        throw new Error(`时段${hour}的可调容量必须>=0`);
      }
      if (price_yuan_per_mwh == null || price_yuan_per_mwh < 0) {
        throw new Error(`时段${hour}的报价必须>=0`);
      }

      const capacity = calculateAggregatorAdjustableCapacity(aggregatorId, tradingDayId, hour);
      if (adjustable_capacity_mw > capacity.total_adjustable_max_mw + 1e-6) {
        throw new Error(`时段${hour}申报容量${adjustable_capacity_mw}MW超过最大可调容量${capacity.total_adjustable_max_mw}MW`);
      }

      const existing = db.prepare(`
        SELECT id FROM vpp_bids WHERE aggregator_id = ? AND trading_day_id = ? AND hour = ?
      `).get(aggregatorId, tradingDayId, hour);

      if (existing) {
        db.prepare(`
          UPDATE vpp_bids SET adjustable_capacity_mw = ?, price_yuan_per_mwh = ? WHERE id = ?
        `).run(adjustable_capacity_mw, price_yuan_per_mwh, existing.id);
      } else {
        db.prepare(`
          INSERT INTO vpp_bids (id, aggregator_id, trading_day_id, hour, adjustable_capacity_mw, price_yuan_per_mwh)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), aggregatorId, tradingDayId, hour, adjustable_capacity_mw, price_yuan_per_mwh);
      }
    }
  });

  tx();
  return getVppBids(aggregatorId, tradingDayId);
}

function getVppBids(aggregatorId, tradingDayId) {
  const bids = db.prepare(`
    SELECT * FROM vpp_bids
    WHERE aggregator_id = ? AND trading_day_id = ?
    ORDER BY hour
  `).all(aggregatorId, tradingDayId);
  const aggregator = getAggregatorById(aggregatorId);
  return {
    aggregator_id: aggregatorId,
    aggregator_code: aggregator ? aggregator.code : null,
    aggregator_name: aggregator ? aggregator.name : null,
    trading_day_id: tradingDayId,
    bids
  };
}

function getVppBid(aggregatorId, tradingDayId, hour) {
  return db.prepare(`
    SELECT * FROM vpp_bids
    WHERE aggregator_id = ? AND trading_day_id = ? AND hour = ?
  `).get(aggregatorId, tradingDayId, hour);
}

function distributeOutput(aggregatorId, tradingDayId, hour, totalOutputKw) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  const resources = listResourcesByAggregator(aggregatorId);
  if (resources.length === 0) {
    throw new Error('聚合商名下无资源');
  }

  const resourceRanges = [];
  let totalMaxKw = 0;

  for (const r of resources) {
    const range = getResourceAdjustableRange(r, tradingDayId, hour);
    resourceRanges.push({ resource: r, minKw: range.min_kw, maxKw: range.max_kw });
    totalMaxKw += Math.max(0, range.max_kw);
  }

  if (totalOutputKw > totalMaxKw + 1e-6) {
    throw new Error(`总出力${totalOutputKw}kW超过聚合商最大可调容量${totalMaxKw}kW`);
  }

  const allocations = [];
  let remainingOutput = totalOutputKw;
  let remainingMaxKw = totalMaxKw;

  const sortedResources = [...resourceRanges].sort((a, b) => {
    const aPositive = Math.max(0, a.maxKw);
    const bPositive = Math.max(0, b.maxKw);
    return bPositive - aPositive;
  });

  for (const { resource, minKw, maxKw } of sortedResources) {
    const resourcePositiveMax = Math.max(0, maxKw);
    let allocated = 0;

    if (remainingOutput > 0 && remainingMaxKw > 0 && resourcePositiveMax > 0) {
      const proportional = Math.round(remainingOutput * resourcePositiveMax / remainingMaxKw * 10000) / 10000;
      allocated = Math.min(proportional, resourcePositiveMax, remainingOutput);
    }

    allocations.push({
      resource_id: resource.id,
      resource_code: resource.code,
      resource_name: resource.name,
      type: resource.type,
      max_kw: maxKw,
      min_kw: minKw,
      allocated_output_kw: Math.round(allocated * 10000) / 10000
    });

    remainingOutput -= allocated;
    remainingMaxKw -= resourcePositiveMax;
  }

  if (remainingOutput > 1e-6) {
    for (const alloc of allocations) {
      const room = Math.max(0, alloc.max_kw) - alloc.allocated_output_kw;
      if (room > 1e-6 && remainingOutput > 1e-6) {
        const transfer = Math.min(room, remainingOutput);
        alloc.allocated_output_kw = Math.round((alloc.allocated_output_kw + transfer) * 10000) / 10000;
        remainingOutput -= transfer;
      }
    }
  }

  const bid = getVppBid(aggregatorId, tradingDayId, hour);

  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM vpp_output_distributions
      WHERE aggregator_id = ? AND trading_day_id = ? AND hour = ?
    `).run(aggregatorId, tradingDayId, hour);

    for (const alloc of allocations) {
      db.prepare(`
        INSERT INTO vpp_output_distributions (id, aggregator_id, trading_day_id, hour, resource_id, bid_id, allocated_output_kw)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), aggregatorId, tradingDayId, hour, alloc.resource_id, bid ? bid.id : null, alloc.allocated_output_kw);
    }
  });

  tx();

  return {
    aggregator_id: aggregatorId,
    trading_day_id: tradingDayId,
    hour,
    total_target_output_kw: totalOutputKw,
    total_allocated_kw: Math.round(allocations.reduce((s, a) => s + a.allocated_output_kw, 0) * 10000) / 10000,
    residual_kw: Math.round(remainingOutput * 10000) / 10000,
    allocations
  };
}

function getOutputDistribution(aggregatorId, tradingDayId) {
  const rows = db.prepare(`
    SELECT d.*, r.code as resource_code, r.name as resource_name, r.type
    FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY resource_id, hour
        ORDER BY is_real_time_adjustment DESC, rowid DESC
      ) as rn
      FROM vpp_output_distributions
      WHERE aggregator_id = ? AND trading_day_id = ?
    ) d
    LEFT JOIN vpp_resources r ON d.resource_id = r.id
    WHERE d.rn = 1
    ORDER BY d.hour, r.code
  `).all(aggregatorId, tradingDayId);

  const hourly = {};
  for (const r of rows) {
    if (!hourly[r.hour]) {
      hourly[r.hour] = { hour: r.hour, total_allocated_kw: 0, allocations: [] };
    }
    hourly[r.hour].total_allocated_kw += r.allocated_output_kw;
    hourly[r.hour].allocations.push({
      resource_id: r.resource_id,
      resource_code: r.resource_code,
      resource_name: r.resource_name,
      type: r.type,
      type_label: RESOURCE_TYPE_LABELS[r.type],
      allocated_output_kw: r.allocated_output_kw,
      is_real_time_adjustment: r.is_real_time_adjustment,
      real_time_command_id: r.real_time_command_id
    });
  }

  return {
    aggregator_id: aggregatorId,
    trading_day_id: tradingDayId,
    hourly_distributions: Object.values(hourly).sort((a, b) => a.hour - b.hour)
  };
}

function getResourceOutputDistribution(resourceId, tradingDayId) {
  return db.prepare(`
    SELECT d.*, r.code as resource_code, r.name as resource_name
    FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY resource_id, hour
        ORDER BY is_real_time_adjustment DESC, rowid DESC
      ) as rn
      FROM vpp_output_distributions
      WHERE resource_id = ? AND trading_day_id = ?
    ) d
    LEFT JOIN vpp_resources r ON d.resource_id = r.id
    WHERE d.rn = 1
    ORDER BY d.hour
  `).all(resourceId, tradingDayId);
}

function submitActualOutput(resourceId, tradingDayId, hour, actualOutputKw) {
  const resource = getResourceById(resourceId);
  if (!resource) {
    throw new Error('资源不存在');
  }

  if (hour == null || hour < 0 || hour > 23) {
    throw new Error('时段必须在0-23之间');
  }

  const existing = db.prepare(`
    SELECT id FROM vpp_actual_outputs WHERE resource_id = ? AND trading_day_id = ? AND hour = ?
  `).get(resourceId, tradingDayId, hour);

  if (existing) {
    db.prepare(`
      UPDATE vpp_actual_outputs SET actual_output_kw = ? WHERE id = ?
    `).run(actualOutputKw, existing.id);
  } else {
    db.prepare(`
      INSERT INTO vpp_actual_outputs (id, resource_id, trading_day_id, hour, actual_output_kw)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), resourceId, tradingDayId, hour, actualOutputKw);
  }

  return db.prepare(`
    SELECT * FROM vpp_actual_outputs WHERE resource_id = ? AND trading_day_id = ? AND hour = ?
  `).get(resourceId, tradingDayId, hour);
}

function submitActualOutputsBatch(tradingDayId, outputs) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error('实际上报数据不能为空');
  }

  const tx = db.transaction(() => {
    for (const o of outputs) {
      submitActualOutput(o.resource_id, tradingDayId, o.hour, o.actual_output_kw);
    }
  });

  tx();
  return { success: true, count: outputs.length };
}

function getActualOutputsByResource(resourceId, tradingDayId) {
  return db.prepare(`
    SELECT * FROM vpp_actual_outputs
    WHERE resource_id = ? AND trading_day_id = ?
    ORDER BY hour
  `).all(resourceId, tradingDayId);
}

function getActualOutputsByAggregator(aggregatorId, tradingDayId) {
  const rows = db.prepare(`
    SELECT a.*, r.code as resource_code, r.name as resource_name, r.type, r.aggregator_id
    FROM vpp_actual_outputs a
    LEFT JOIN vpp_resources r ON a.resource_id = r.id
    WHERE r.aggregator_id = ? AND a.trading_day_id = ?
    ORDER BY a.hour, r.code
  `).all(aggregatorId, tradingDayId);

  const hourly = {};
  let totalKw = 0;
  for (const r of rows) {
    if (!hourly[r.hour]) {
      hourly[r.hour] = { hour: r.hour, total_actual_kw: 0, resources: [] };
    }
    hourly[r.hour].total_actual_kw += r.actual_output_kw;
    hourly[r.hour].resources.push({
      resource_id: r.resource_id,
      resource_code: r.resource_code,
      resource_name: r.resource_name,
      type: r.type,
      type_label: RESOURCE_TYPE_LABELS[r.type],
      actual_output_kw: r.actual_output_kw
    });
    totalKw += r.actual_output_kw;
  }

  return {
    aggregator_id: aggregatorId,
    trading_day_id: tradingDayId,
    total_actual_mwh: Math.round(totalKw / 1000 * 10000) / 10000,
    hourly_actuals: Object.values(hourly).sort((a, b) => a.hour - b.hour)
  };
}

function transferableAmount(raw, adjusted) {
  return Math.max(0, adjusted - raw);
}

function evaluatePerformanceAndRedistribute(aggregatorId, tradingDayId) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  const resources = listResourcesByAggregator(aggregatorId);
  const results = [];
  const month = new Date().toISOString().slice(0, 7);

  const hourlyAllocations = {};
  const hourlyActuals = {};
  const distributionsMap = {};
  const actualsMap = {};

  for (const resource of resources) {
    const distributions = getResourceOutputDistribution(resource.id, tradingDayId);
    const actuals = getActualOutputsByResource(resource.id, tradingDayId);
    distributionsMap[resource.id] = distributions;
    actualsMap[resource.id] = {};
    for (const a of actuals) actualsMap[resource.id][a.hour] = a.actual_output_kw;

    for (const d of distributions) {
      if (!hourlyAllocations[d.hour]) hourlyAllocations[d.hour] = {};
      if (!hourlyActuals[d.hour]) hourlyActuals[d.hour] = {};
      hourlyAllocations[d.hour][resource.id] = d.allocated_output_kw;
      hourlyActuals[d.hour][resource.id] = actualsMap[resource.id][d.hour] != null ? actualsMap[resource.id][d.hour] : 0;
    }
  }

  const hours = Object.keys(hourlyAllocations).map(h => parseInt(h)).sort((a, b) => a - b);
  const adjustedResults = {};

  for (const hour of hours) {
    const allocs = hourlyAllocations[hour];
    const actuals = hourlyActuals[hour];
    const resourceIds = Object.keys(allocs);

    let totalAlloc = 0;
    let totalActual = 0;
    for (const rid of resourceIds) {
      totalAlloc += allocs[rid];
      totalActual += actuals[rid];
    }

    const overallDeviation = totalActual - totalAlloc;
    const overallDeviationRate = totalAlloc > 0 ? Math.abs(overallDeviation) / totalAlloc : 0;
    const hourOverallCompliant = overallDeviationRate <= (1 - COMPLIANCE_THRESHOLD);

    if (hourOverallCompliant) {
      let deficit = 0;
      let surplus = 0;
      for (const rid of resourceIds) {
        const dev = actuals[rid] - allocs[rid];
        if (dev < 0) deficit += Math.abs(dev);
        if (dev > 0) surplus += dev;
      }

      const transfersMap = {};
      for (const rid of resourceIds) transfersMap[rid] = 0;

      for (const rid of resourceIds) {
        const rawDev = actuals[rid] - allocs[rid];
        if (rawDev < 0 && surplus > 0) {
          const needed = Math.abs(rawDev);
          const transferable = Math.min(needed, surplus);
          transfersMap[rid] += transferable;
          surplus -= transferable;
        }
      }

      let remainingTransfers = 0;
      for (const rid of resourceIds) remainingTransfers += transfersMap[rid];
      let remainingSurplusCapacity = 0;
      for (const rid of resourceIds) {
        const rawDev = actuals[rid] - allocs[rid];
        if (rawDev > 0) remainingSurplusCapacity += rawDev;
      }

      for (const rid of resourceIds) {
        const rawDev = actuals[rid] - allocs[rid];
        let adjustedActual = actuals[rid];
        let redistributedReceived = transfersMap[rid] || 0;
        let redistributedGiven = 0;

        if (rawDev > 0 && remainingTransfers > 0 && remainingSurplusCapacity > 0) {
          const takeAway = Math.min(rawDev, remainingTransfers * rawDev / remainingSurplusCapacity);
          adjustedActual -= takeAway;
          redistributedGiven = takeAway;
          remainingTransfers -= takeAway;
        }

        adjustedActual += redistributedReceived;

        const adjustedDev = adjustedActual - allocs[rid];
        const adjustedDevRate = allocs[rid] > 0
          ? Math.abs(adjustedDev) / allocs[rid]
          : (Math.abs(adjustedActual) > 1e-6 ? 1 : 0);
        const isCompliant = adjustedDevRate <= (1 - COMPLIANCE_THRESHOLD) ? 1 : 0;

        if (!adjustedResults[rid]) adjustedResults[rid] = {};
        adjustedResults[rid][hour] = {
          raw_actual: actuals[rid],
          adjusted_actual: adjustedActual,
          allocated: allocs[rid],
          raw_deviation: rawDev,
          adjusted_deviation: adjustedDev,
          adjusted_deviation_rate: adjustedDevRate,
          is_compliant: isCompliant,
          redistributed_from_surplus: redistributedReceived,
          redistributed_to_deficit: redistributedGiven
        };
      }
    } else {
      for (const rid of resourceIds) {
        const rawDev = actuals[rid] - allocs[rid];
        const rawDevRate = allocs[rid] > 0
          ? Math.abs(rawDev) / allocs[rid]
          : (Math.abs(actuals[rid]) > 1e-6 ? 1 : 0);
        const isCompliant = rawDevRate <= (1 - COMPLIANCE_THRESHOLD) ? 1 : 0;

        if (!adjustedResults[rid]) adjustedResults[rid] = {};
        adjustedResults[rid][hour] = {
          raw_actual: actuals[rid],
          adjusted_actual: actuals[rid],
          allocated: allocs[rid],
          raw_deviation: rawDev,
          adjusted_deviation: rawDev,
          adjusted_deviation_rate: rawDevRate,
          is_compliant: isCompliant,
          redistributed_from_surplus: 0,
          redistributed_to_deficit: 0
        };
      }
    }
  }

  const tx = db.transaction(() => {
    for (const resource of resources) {
      const distributions = distributionsMap[resource.id] || [];
      const totalPeriods = distributions.length;
      let compliantPeriods = 0;

      for (const d of distributions) {
        const adj = adjustedResults[resource.id] ? adjustedResults[resource.id][d.hour] : null;
        if (!adj) continue;

        if (adj.is_compliant) compliantPeriods++;

        const existingId = db.prepare(`
          SELECT id FROM vpp_performance_records WHERE resource_id = ? AND trading_day_id = ? AND hour = ?
        `).get(resource.id, tradingDayId, d.hour);

        const recId = existingId ? existingId.id : uuidv4();

        db.prepare(`
          INSERT OR REPLACE INTO vpp_performance_records
          (id, resource_id, trading_day_id, hour, allocated_output_kw, actual_output_kw,
           raw_actual_output_kw, deviation_kw, deviation_rate, is_compliant,
           redistributed_amount_kw, redistributed_to_deficit_kw)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          recId,
          resource.id, tradingDayId, d.hour,
          d.allocated_output_kw,
          adj.adjusted_actual,
          adj.raw_actual,
          Math.round(adj.adjusted_deviation * 10000) / 10000,
          Math.round(adj.adjusted_deviation_rate * 10000) / 10000,
          adj.is_compliant,
          Math.round(adj.redistributed_from_surplus * 10000) / 10000,
          Math.round(adj.redistributed_to_deficit * 10000) / 10000
        );

        results.push({
          resource_id: resource.id,
          resource_code: resource.code,
          resource_name: resource.name,
          hour: d.hour,
          allocated_output_kw: d.allocated_output_kw,
          actual_output_kw: adj.adjusted_actual,
          raw_actual_output_kw: adj.raw_actual,
          deviation_kw: Math.round(adj.adjusted_deviation * 10000) / 10000,
          deviation_rate: Math.round(adj.adjusted_deviation_rate * 10000) / 10000,
          is_compliant: adj.is_compliant,
          redistributed_amount_kw: Math.round(adj.redistributed_from_surplus * 10000) / 10000,
          redistributed_to_deficit_kw: Math.round(adj.redistributed_to_deficit * 10000) / 10000
        });
      }

      const existingSummary = db.prepare(`
        SELECT * FROM vpp_performance_summary WHERE resource_id = ? AND month = ?
      `).get(resource.id, month);

      let totalP = existingSummary ? existingSummary.total_periods : 0;
      let compliantP = existingSummary ? existingSummary.compliant_periods : 0;
      let nonCompliantP = existingSummary ? existingSummary.non_compliant_periods : 0;
      let consecFails = existingSummary ? existingSummary.consecutive_failures : 0;

      const nonCompliantToday = totalPeriods - compliantPeriods;
      totalP += totalPeriods;
      compliantP += compliantPeriods;
      nonCompliantP += nonCompliantToday;

      if (nonCompliantToday > 0) {
        consecFails += nonCompliantToday;
      } else if (totalPeriods > 0) {
        consecFails = 0;
      }

      const complianceRate = totalP > 0 ? compliantP / totalP : 0;
      const isMarkedUnreliable = consecFails >= CONSECUTIVE_FAILURES_FOR_UNRELIABLE ? 1 : 0;

      if (isMarkedUnreliable) {
        db.prepare('UPDATE vpp_resources SET is_reliable = 0 WHERE id = ?').run(resource.id);
      }

      if (existingSummary) {
        db.prepare(`
          UPDATE vpp_performance_summary SET
            total_periods = ?, compliant_periods = ?, non_compliant_periods = ?,
            compliance_rate = ?, consecutive_failures = ?, is_marked_unreliable = ?
          WHERE id = ?
        `).run(totalP, compliantP, nonCompliantP,
               Math.round(complianceRate * 10000) / 10000,
               consecFails, isMarkedUnreliable, existingSummary.id);
      } else {
        db.prepare(`
          INSERT INTO vpp_performance_summary
          (id, resource_id, month, total_periods, compliant_periods, non_compliant_periods,
           compliance_rate, consecutive_failures, is_marked_unreliable)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), resource.id, month, totalP, compliantP, nonCompliantP,
               Math.round(complianceRate * 10000) / 10000,
               consecFails, isMarkedUnreliable);
      }
    }
  });

  tx();

  const hourlyMap = {};
  for (const r of results) {
    if (!hourlyMap[r.hour]) hourlyMap[r.hour] = { hour: r.hour, total_alloc: 0, total_actual: 0, total_raw_actual: 0, resources: [] };
    hourlyMap[r.hour].total_alloc += r.allocated_output_kw;
    hourlyMap[r.hour].total_actual += r.actual_output_kw;
    hourlyMap[r.hour].total_raw_actual += r.raw_actual_output_kw;
    hourlyMap[r.hour].resources.push(r);
  }

  const overall = {
    total_allocated_kw: 0,
    total_actual_kw: 0,
    total_raw_actual_kw: 0,
    compliant_count: 0,
    non_compliant_count: 0
  };
  for (const r of results) {
    overall.total_allocated_kw += r.allocated_output_kw;
    overall.total_actual_kw += r.actual_output_kw;
    overall.total_raw_actual_kw += r.raw_actual_output_kw;
    if (r.is_compliant) overall.compliant_count++;
    else overall.non_compliant_count++;
  }
  overall.overall_compliance_rate = results.length > 0
    ? Math.round(overall.compliant_count / results.length * 10000) / 10000
    : 0;
  overall.overall_deviation_kw = Math.round((overall.total_raw_actual_kw - overall.total_allocated_kw) * 10000) / 10000;
  overall.overall_deviation_rate = overall.total_allocated_kw > 0
    ? Math.round(Math.abs(overall.overall_deviation_kw) / overall.total_allocated_kw * 10000) / 10000
    : 0;

  return {
    aggregator_id: aggregatorId,
    trading_day_id: tradingDayId,
    overall,
    hourly_details: Object.values(hourlyMap).sort((a, b) => a.hour - b.hour),
    resource_records: results
  };
}

function getResourcePerformanceRecords(resourceId, tradingDayId) {
  return db.prepare(`
    SELECT p.*, r.code as resource_code, r.name as resource_name
    FROM vpp_performance_records p
    LEFT JOIN vpp_resources r ON p.resource_id = r.id
    WHERE p.resource_id = ? AND p.trading_day_id = ?
    ORDER BY p.hour
  `).all(resourceId, tradingDayId);
}

function getAggregatorPerformanceSummary(aggregatorId, tradingDayId) {
  const records = db.prepare(`
    SELECT p.*, r.code as resource_code, r.name as resource_name, r.type
    FROM vpp_performance_records p
    LEFT JOIN vpp_resources r ON p.resource_id = r.id
    WHERE r.aggregator_id = ? AND p.trading_day_id = ?
    ORDER BY p.hour, r.code
  `).all(aggregatorId, tradingDayId);

  const byResource = {};
  for (const r of records) {
    if (!byResource[r.resource_id]) {
      byResource[r.resource_id] = {
        resource_id: r.resource_id,
        resource_code: r.resource_code,
        resource_name: r.resource_name,
        type: r.type,
        total_alloc: 0,
        total_actual: 0,
        compliant_periods: 0,
        total_periods: 0
      };
    }
    byResource[r.resource_id].total_alloc += r.allocated_output_kw;
    byResource[r.resource_id].total_actual += r.actual_output_kw;
    byResource[r.resource_id].total_periods++;
    if (r.is_compliant) byResource[r.resource_id].compliant_periods++;
  }

  const resourceSummaries = Object.values(byResource).map(s => ({
    ...s,
    compliance_rate: s.total_periods > 0 ? Math.round(s.compliant_periods / s.total_periods * 10000) / 10000 : 0,
    deviation_kw: Math.round((s.total_actual - s.total_alloc) * 10000) / 10000
  }));

  const grandTotal = resourceSummaries.reduce((acc, s) => ({
    total_alloc: acc.total_alloc + s.total_alloc,
    total_actual: acc.total_actual + s.total_actual,
    compliant_periods: acc.compliant_periods + s.compliant_periods,
    total_periods: acc.total_periods + s.total_periods
  }), { total_alloc: 0, total_actual: 0, compliant_periods: 0, total_periods: 0 });

  return {
    aggregator_id: aggregatorId,
    trading_day_id: tradingDayId,
    overall: {
      total_allocated_kw: Math.round(grandTotal.total_alloc * 10000) / 10000,
      total_actual_kw: Math.round(grandTotal.total_actual * 10000) / 10000,
      deviation_kw: Math.round((grandTotal.total_actual - grandTotal.total_alloc) * 10000) / 10000,
      compliance_rate: grandTotal.total_periods > 0
        ? Math.round(grandTotal.compliant_periods / grandTotal.total_periods * 10000) / 10000
        : 0
    },
    resource_summaries: resourceSummaries
  };
}

function getResourcePerformanceSummary(resourceId, month) {
  return db.prepare(`
    SELECT s.*, r.code as resource_code, r.name as resource_name, r.is_reliable
    FROM vpp_performance_summary s
    LEFT JOIN vpp_resources r ON s.resource_id = r.id
    WHERE s.resource_id = ? AND s.month = ?
  `).get(resourceId, month);
}

function executeVppSettlement(aggregatorId, tradingDayId, marketData) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  const performance = getAggregatorPerformanceSummary(aggregatorId, tradingDayId);
  const actuals = getActualOutputsByAggregator(aggregatorId, tradingDayId);

  const clearingPrices = marketData && marketData.clearing_prices ? marketData.clearing_prices : {};
  const deviationPenaltyRate = marketData && marketData.deviation_penalty_rate != null ? marketData.deviation_penalty_rate : 1.5;

  let totalClearedEnergyMwh = 0;
  let totalRealTimeAdjustmentMwh = 0;
  let totalTargetEnergyMwh = 0;
  let totalActualEnergyMwh = 0;
  let totalSpotRevenue = 0;
  let totalDeviation = 0;

  const bids = getVppBids(aggregatorId, tradingDayId);
  const bidMap = {};
  for (const b of bids.bids) bidMap[b.hour] = b;

  const realTimeCommands = db.prepare(`
    SELECT hour, SUM(actual_responsive_mw) as total_adjustment_mw
    FROM vpp_real_time_commands
    WHERE aggregator_id = ? AND trading_day_id = ?
    GROUP BY hour
  `).all(aggregatorId, tradingDayId);
  const realTimeAdjustmentMap = {};
  for (const c of realTimeCommands) realTimeAdjustmentMap[c.hour] = c.total_adjustment_mw;

  const resourceContribution = {};
  const resources = listResourcesByAggregator(aggregatorId);
  for (const r of resources) resourceContribution[r.id] = 0;

  for (let h = 0; h < 24; h++) {
    const bid = bidMap[h];
    const clearedMw = bid ? bid.cleared_capacity_mw : 0;
    const realTimeAdjMw = realTimeAdjustmentMap[h] || 0;
    const targetMw = clearedMw + realTimeAdjMw;
    const clearedEnergy = clearedMw;
    totalClearedEnergyMwh += clearedEnergy;
    totalRealTimeAdjustmentMwh += realTimeAdjMw;
    totalTargetEnergyMwh += targetMw;

    const hourActual = actuals.hourly_actuals.find(x => x.hour === h);
    const actualKw = hourActual ? hourActual.total_actual_kw : 0;
    const actualMw = actualKw / 1000;
    totalActualEnergyMwh += actualMw;

    const clearingPrice = clearingPrices[h] != null ? clearingPrices[h] : (bid ? bid.clearing_price : 0);
    totalSpotRevenue += clearedEnergy * clearingPrice;

    const dev = actualMw - targetMw;
    totalDeviation += Math.abs(dev);

    if (hourActual) {
      for (const res of hourActual.resources) {
        resourceContribution[res.resource_id] += res.actual_output_kw / 1000;
      }
    }
  }

  const totalEnergyForPenalty = totalActualEnergyMwh - totalTargetEnergyMwh;
  const avgPrice = totalClearedEnergyMwh > 0 ? totalSpotRevenue / totalClearedEnergyMwh : 300;
  const deviationPenalty = Math.abs(totalEnergyForPenalty) * avgPrice * deviationPenaltyRate;

  const totalRevenue = Math.max(0, totalSpotRevenue - deviationPenalty);
  const serviceFee = totalRevenue * aggregator.service_fee_ratio;
  const distributableRevenue = totalRevenue - serviceFee;

  const settlementId = uuidv4();

  const tx = db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM vpp_settlements WHERE aggregator_id = ? AND trading_day_id = ?
    `).get(aggregatorId, tradingDayId);

    if (existing) {
      db.prepare(`DELETE FROM vpp_revenue_allocations WHERE settlement_id = ?`).run(existing.id);
      db.prepare(`DELETE FROM vpp_settlements WHERE id = ?`).run(existing.id);
    }

    db.prepare(`
      INSERT INTO vpp_settlements
      (id, aggregator_id, trading_day_id, total_cleared_energy_mwh, total_real_time_adjustment_mwh,
       total_target_energy_mwh, total_actual_energy_mwh,
       deviation_energy_mwh, deviation_rate, spot_revenue_yuan, deviation_penalty_yuan,
       total_revenue_yuan, service_fee_yuan, distributable_revenue_yuan)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      settlementId, aggregatorId, tradingDayId,
      Math.round(totalClearedEnergyMwh * 10000) / 10000,
      Math.round(totalRealTimeAdjustmentMwh * 10000) / 10000,
      Math.round(totalTargetEnergyMwh * 10000) / 10000,
      Math.round(totalActualEnergyMwh * 10000) / 10000,
      Math.round(totalEnergyForPenalty * 10000) / 10000,
      totalTargetEnergyMwh > 0 ? Math.round(Math.abs(totalEnergyForPenalty) / totalTargetEnergyMwh * 10000) / 10000 : 0,
      Math.round(totalSpotRevenue * 100) / 100,
      Math.round(deviationPenalty * 100) / 100,
      Math.round(totalRevenue * 100) / 100,
      Math.round(serviceFee * 100) / 100,
      Math.round(distributableRevenue * 100) / 100
    );

    const totalContribution = Object.values(resourceContribution).reduce((s, v) => s + v, 0);

    for (const resource of resources) {
      const contribution = resourceContribution[resource.id] || 0;
      const ratio = totalContribution > 0 ? contribution / totalContribution : 0;
      const allocatedRevenue = distributableRevenue * ratio;

      db.prepare(`
        INSERT INTO vpp_revenue_allocations
        (id, settlement_id, aggregator_id, trading_day_id, resource_id,
         actual_energy_mwh, contribution_ratio, allocated_revenue_yuan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), settlementId, aggregatorId, tradingDayId, resource.id,
        Math.round(contribution * 10000) / 10000,
        Math.round(ratio * 10000) / 10000,
        Math.round(allocatedRevenue * 100) / 100
      );
    }
  });

  tx();

  return getVppSettlementDetail(settlementId);
}

function getVppSettlementDetail(settlementId) {
  const settlement = db.prepare('SELECT * FROM vpp_settlements WHERE id = ?').get(settlementId);
  if (!settlement) return null;

  const allocations = db.prepare(`
    SELECT a.*, r.code as resource_code, r.name as resource_name, r.type, r.owner_name
    FROM vpp_revenue_allocations a
    LEFT JOIN vpp_resources r ON a.resource_id = r.id
    WHERE a.settlement_id = ?
    ORDER BY r.code
  `).all(settlementId);

  const aggregator = getAggregatorById(settlement.aggregator_id);

  return {
    settlement,
    aggregator: {
      id: aggregator.id,
      code: aggregator.code,
      name: aggregator.name,
      service_fee_ratio: aggregator.service_fee_ratio
    },
    revenue_allocations: allocations
  };
}

function getVppSettlement(aggregatorId, tradingDayId) {
  const settlement = db.prepare(`
    SELECT * FROM vpp_settlements WHERE aggregator_id = ? AND trading_day_id = ?
  `).get(aggregatorId, tradingDayId);
  if (!settlement) return null;
  return getVppSettlementDetail(settlement.id);
}

function getVppRevenueAllocations(settlementId) {
  return db.prepare(`
    SELECT a.*, r.code as resource_code, r.name as resource_name, r.type, r.owner_name
    FROM vpp_revenue_allocations a
    LEFT JOIN vpp_resources r ON a.resource_id = r.id
    WHERE a.settlement_id = ?
    ORDER BY r.code
  `).all(settlementId);
}

function getResourceRevenueAllocations(resourceId, tradingDayId) {
  const sql = `
    SELECT a.*, s.total_revenue_yuan, s.service_fee_yuan, s.distributable_revenue_yuan,
           s.total_cleared_energy_mwh, s.total_actual_energy_mwh
    FROM vpp_revenue_allocations a
    LEFT JOIN vpp_settlements s ON a.settlement_id = s.id
    WHERE a.resource_id = ? AND a.trading_day_id = ?
  `;
  return db.prepare(sql).all(resourceId, tradingDayId);
}

function getCurrentOutputByHour(aggregatorId, tradingDayId, hour) {
  const rows = db.prepare(`
    SELECT resource_id, allocated_output_kw
    FROM (
      SELECT resource_id, allocated_output_kw, ROW_NUMBER() OVER (
        PARTITION BY resource_id
        ORDER BY is_real_time_adjustment DESC, rowid DESC
      ) as rn
      FROM vpp_output_distributions
      WHERE aggregator_id = ? AND trading_day_id = ? AND hour = ?
    )
    WHERE rn = 1
  `).all(aggregatorId, tradingDayId, hour);

  const latestByResource = {};
  for (const row of rows) {
    latestByResource[row.resource_id] = row.allocated_output_kw;
  }

  return latestByResource;
}

function calculateRealTimeAdjustableMargin(aggregatorId, tradingDayId, hour) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  const resources = listResourcesByAggregator(aggregatorId);
  const currentOutputs = getCurrentOutputByHour(aggregatorId, tradingDayId, hour);

  let totalIncreaseMarginKw = 0;
  let totalDecreaseMarginKw = 0;
  const resourceDetails = [];

  for (const r of resources) {
    const range = getResourceAdjustableRange(r, tradingDayId, hour);
    const currentKw = currentOutputs[r.id] != null ? currentOutputs[r.id] : 0;

    const increaseMarginKw = Math.max(0, range.max_kw - currentKw);
    const decreaseMarginKw = Math.max(0, currentKw - range.min_kw);

    totalIncreaseMarginKw += increaseMarginKw;
    totalDecreaseMarginKw += decreaseMarginKw;

    resourceDetails.push({
      resource_id: r.id,
      resource_code: r.code,
      resource_name: r.name,
      type: r.type,
      ramp_rate_kw_per_min: r.ramp_rate_kw_per_min,
      current_output_kw: Math.round(currentKw * 10000) / 10000,
      adjustable_min_kw: range.min_kw,
      adjustable_max_kw: range.max_kw,
      increase_margin_kw: Math.round(increaseMarginKw * 10000) / 10000,
      decrease_margin_kw: Math.round(decreaseMarginKw * 10000) / 10000
    });
  }

  return {
    aggregator_id: aggregatorId,
    aggregator_code: aggregator.code,
    aggregator_name: aggregator.name,
    trading_day_id: tradingDayId,
    hour: hour,
    total_increase_margin_mw: Math.round(totalIncreaseMarginKw / 1000 * 10000) / 10000,
    total_decrease_margin_mw: Math.round(totalDecreaseMarginKw / 1000 * 10000) / 10000,
    total_increase_margin_kw: Math.round(totalIncreaseMarginKw * 10000) / 10000,
    total_decrease_margin_kw: Math.round(totalDecreaseMarginKw * 10000) / 10000,
    resource_count: resources.length,
    resources: resourceDetails
  };
}

function distributeRealTimeAdjustment(
  aggregatorId,
  tradingDayId,
  hour,
  targetAdjustmentKw,
  responseTimeSeconds,
  currentOutputs,
  marginInfo
) {
  const resources = listResourcesByAggregator(aggregatorId);
  const responseTimeMinutes = responseTimeSeconds / 60;

  const resourceData = [];
  for (const r of resources) {
    const marginRes = marginInfo.resources.find(x => x.resource_id === r.id);
    if (!marginRes) continue;

    const maxRampCapacityKw = r.ramp_rate_kw_per_min * responseTimeMinutes;
    let maxAdjustmentKw;

    if (targetAdjustmentKw > 0) {
      maxAdjustmentKw = Math.min(marginRes.increase_margin_kw, maxRampCapacityKw);
    } else {
      maxAdjustmentKw = -Math.min(marginRes.decrease_margin_kw, maxRampCapacityKw);
    }

    resourceData.push({
      resource: r,
      current_kw: marginRes.current_output_kw,
      max_adjustment_kw: maxAdjustmentKw,
      ramp_capacity_kw: maxRampCapacityKw,
      margin_kw: targetAdjustmentKw > 0 ? marginRes.increase_margin_kw : marginRes.decrease_margin_kw,
      adjustment_kw: 0
    });
  }

  let remainingAdjustment = targetAdjustmentKw;
  const totalMaxAdjustment = resourceData.reduce((s, r) => {
    if (targetAdjustmentKw > 0) {
      return s + Math.max(0, r.max_adjustment_kw);
    } else {
      return s + Math.min(0, r.max_adjustment_kw);
    }
  }, 0);

  if (targetAdjustmentKw > 0) {
    if (totalMaxAdjustment <= 0) {
      return { actualAdjustmentKw: 0, details: resourceData };
    }

    for (const rd of resourceData) {
      if (remainingAdjustment <= 0) break;
      if (rd.max_adjustment_kw <= 0) continue;

      const proportional = Math.round(
        remainingAdjustment * rd.max_adjustment_kw / totalMaxAdjustment * 10000
      ) / 10000;
      const allocated = Math.min(proportional, rd.max_adjustment_kw, remainingAdjustment);

      rd.adjustment_kw = allocated;
      remainingAdjustment -= allocated;
    }

    if (remainingAdjustment > 0.0001) {
      for (const rd of resourceData) {
        if (remainingAdjustment <= 0.0001) break;
        const room = rd.max_adjustment_kw - rd.adjustment_kw;
        if (room > 0.0001) {
          const transfer = Math.min(room, remainingAdjustment);
          rd.adjustment_kw = Math.round((rd.adjustment_kw + transfer) * 10000) / 10000;
          remainingAdjustment -= transfer;
        }
      }
    }
  } else {
    if (totalMaxAdjustment >= 0) {
      return { actualAdjustmentKw: 0, details: resourceData };
    }

    for (const rd of resourceData) {
      if (remainingAdjustment >= 0) break;
      if (rd.max_adjustment_kw >= 0) continue;

      const proportional = Math.round(
        remainingAdjustment * rd.max_adjustment_kw / totalMaxAdjustment * 10000
      ) / 10000;
      const allocated = Math.max(proportional, rd.max_adjustment_kw, remainingAdjustment);

      rd.adjustment_kw = allocated;
      remainingAdjustment -= allocated;
    }

    if (remainingAdjustment < -0.0001) {
      for (const rd of resourceData) {
        if (remainingAdjustment >= -0.0001) break;
        const room = rd.max_adjustment_kw - rd.adjustment_kw;
        if (room < -0.0001) {
          const transfer = Math.max(room, remainingAdjustment);
          rd.adjustment_kw = Math.round((rd.adjustment_kw + transfer) * 10000) / 10000;
          remainingAdjustment -= transfer;
        }
      }
    }
  }

  const actualAdjustmentKw = targetAdjustmentKw - remainingAdjustment;

  return {
    actualAdjustmentKw: Math.round(actualAdjustmentKw * 10000) / 10000,
    details: resourceData
  };
}

function submitRealTimeCommand(aggregatorId, tradingDayId, hour, targetAdjustmentMw, responseTimeSeconds) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  if (hour == null || hour < 0 || hour > 23) {
    throw new Error('时段必须在0-23之间');
  }

  if (targetAdjustmentMw == null) {
    throw new Error('目标调节量不能为空');
  }

  if (responseTimeSeconds == null || responseTimeSeconds <= 0) {
    throw new Error('响应时间必须大于0秒');
  }

  const targetAdjustmentKw = targetAdjustmentMw * 1000;
  const marginInfo = calculateRealTimeAdjustableMargin(aggregatorId, tradingDayId, hour);
  const currentOutputs = getCurrentOutputByHour(aggregatorId, tradingDayId, hour);

  let cappedTargetKw = targetAdjustmentKw;
  if (targetAdjustmentKw > 0) {
    cappedTargetKw = Math.min(targetAdjustmentKw, marginInfo.total_increase_margin_kw);
  } else {
    cappedTargetKw = Math.max(targetAdjustmentKw, -marginInfo.total_decrease_margin_kw);
  }

  const distribution = distributeRealTimeAdjustment(
    aggregatorId,
    tradingDayId,
    hour,
    cappedTargetKw,
    responseTimeSeconds,
    currentOutputs,
    marginInfo
  );

  const actualResponsiveKw = distribution.actualAdjustmentKw;
  const actualResponsiveMw = actualResponsiveKw / 1000;
  const unresponsiveMw = Math.round((targetAdjustmentMw - actualResponsiveMw) * 10000) / 10000;
  const responseRate = targetAdjustmentMw !== 0
    ? Math.round(Math.abs(actualResponsiveMw) / Math.abs(targetAdjustmentMw) * 10000) / 10000
    : 1;

  const tx = db.transaction(() => {
    const commandId = uuidv4();
    db.prepare(`
      INSERT INTO vpp_real_time_commands
      (id, aggregator_id, trading_day_id, hour, target_adjustment_mw, response_time_seconds,
       actual_responsive_mw, unresponsive_mw, response_rate, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      commandId, aggregatorId, tradingDayId, hour,
      Math.round(targetAdjustmentMw * 10000) / 10000,
      responseTimeSeconds,
      Math.round(actualResponsiveMw * 10000) / 10000,
      Math.abs(unresponsiveMw) > 1e-6 ? Math.round(unresponsiveMw * 10000) / 10000 : 0,
      responseRate,
      'processed'
    );

    for (const rd of distribution.details) {
      const originalKw = rd.current_kw;
      const adjustmentKw = Math.round(rd.adjustment_kw * 10000) / 10000;
      const finalKw = Math.round((originalKw + adjustmentKw) * 10000) / 10000;

      db.prepare(`
        INSERT INTO vpp_real_time_command_details
        (id, command_id, resource_id, original_allocated_kw, adjustment_kw,
         final_allocated_kw, max_ramp_capacity_kw, adjustable_margin_kw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), commandId, rd.resource.id,
        originalKw,
        adjustmentKw,
        finalKw,
        Math.round(rd.ramp_capacity_kw * 10000) / 10000,
        Math.round(rd.margin_kw * 10000) / 10000
      );

      if (Math.abs(adjustmentKw) > 1e-6) {
        db.prepare(`
          INSERT INTO vpp_output_distributions
          (id, aggregator_id, trading_day_id, hour, resource_id, real_time_command_id,
           allocated_output_kw, is_real_time_adjustment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(), aggregatorId, tradingDayId, hour, rd.resource.id, commandId,
          finalKw, 1
        );
      }
    }

    return commandId;
  });

  const commandId = tx();

  return getRealTimeCommandDetail(commandId);
}

function getRealTimeCommandDetail(commandId) {
  const command = db.prepare(`
    SELECT c.*, a.code as aggregator_code, a.name as aggregator_name
    FROM vpp_real_time_commands c
    LEFT JOIN vpp_aggregators a ON c.aggregator_id = a.id
    WHERE c.id = ?
  `).get(commandId);

  if (!command) return null;

  const details = db.prepare(`
    SELECT d.*, r.code as resource_code, r.name as resource_name, r.type
    FROM vpp_real_time_command_details d
    LEFT JOIN vpp_resources r ON d.resource_id = r.id
    WHERE d.command_id = ?
    ORDER BY r.code
  `).all(commandId);

  return {
    ...command,
    details
  };
}

function getRealTimeCommands(aggregatorId, tradingDayId) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  const commands = db.prepare(`
    SELECT c.*, a.code as aggregator_code, a.name as aggregator_name
    FROM vpp_real_time_commands c
    LEFT JOIN vpp_aggregators a ON c.aggregator_id = a.id
    WHERE c.aggregator_id = ? AND c.trading_day_id = ?
    ORDER BY c.hour, c.created_at
  `).all(aggregatorId, tradingDayId);

  return {
    aggregator_id: aggregatorId,
    aggregator_code: aggregator.code,
    aggregator_name: aggregator.name,
    trading_day_id: tradingDayId,
    command_count: commands.length,
    commands
  };
}

function getResourceRealTimeHistory(resourceId, tradingDayId) {
  const resource = getResourceById(resourceId);
  if (!resource) {
    throw new Error('资源不存在');
  }

  const details = db.prepare(`
    SELECT d.*, c.hour, c.target_adjustment_mw, c.actual_responsive_mw,
           c.response_time_seconds, c.response_rate, c.created_at as command_time
    FROM vpp_real_time_command_details d
    LEFT JOIN vpp_real_time_commands c ON d.command_id = c.id
    WHERE d.resource_id = ? AND c.trading_day_id = ?
    ORDER BY c.hour, c.created_at
  `).all(resourceId, tradingDayId);

  return {
    resource_id: resourceId,
    resource_code: resource.code,
    resource_name: resource.name,
    trading_day_id: tradingDayId,
    adjustment_count: details.length,
    total_adjustment_kw: Math.round(
      details.reduce((s, d) => s + d.adjustment_kw, 0) * 10000
    ) / 10000,
    history: details
  };
}

function getCumulativeAdjustment(aggregatorId, tradingDayId, hour) {
  const aggregator = getAggregatorById(aggregatorId);
  if (!aggregator) {
    throw new Error('聚合商不存在');
  }

  const bid = getVppBid(aggregatorId, tradingDayId, hour);
  const clearedMw = bid ? bid.cleared_capacity_mw : 0;

  const commands = db.prepare(`
    SELECT * FROM vpp_real_time_commands
    WHERE aggregator_id = ? AND trading_day_id = ? AND hour = ?
    ORDER BY created_at
  `).all(aggregatorId, tradingDayId, hour);

  const totalRealTimeAdjustmentMw = commands.reduce(
    (s, c) => s + c.actual_responsive_mw, 0
  );

  const cumulativeMw = Math.round(
    (clearedMw + totalRealTimeAdjustmentMw) * 10000
  ) / 10000;

  const currentOutputs = getCurrentOutputByHour(aggregatorId, tradingDayId, hour);
  const totalCurrentKw = Object.values(currentOutputs).reduce((s, v) => s + v, 0);

  return {
    aggregator_id: aggregatorId,
    aggregator_code: aggregator.code,
    aggregator_name: aggregator.name,
    trading_day_id: tradingDayId,
    hour: hour,
    day_ahead_cleared_mw: Math.round(clearedMw * 10000) / 10000,
    total_real_time_adjustment_mw: Math.round(totalRealTimeAdjustmentMw * 10000) / 10000,
    cumulative_target_mw: cumulativeMw,
    current_allocated_kw: Math.round(totalCurrentKw * 10000) / 10000,
    current_allocated_mw: Math.round(totalCurrentKw / 1000 * 10000) / 10000,
    command_count: commands.length,
    commands: commands.map(c => ({
      id: c.id,
      target_adjustment_mw: c.target_adjustment_mw,
      actual_responsive_mw: c.actual_responsive_mw,
      unresponsive_mw: c.unresponsive_mw,
      response_rate: c.response_rate,
      created_at: c.created_at
    }))
  };
}

function getHourlyCumulativeAdjustments(aggregatorId, tradingDayId) {
  const result = [];
  for (let h = 0; h < 24; h++) {
    result.push(getCumulativeAdjustment(aggregatorId, tradingDayId, h));
  }
  return result;
}

module.exports = {
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
  UNRELIABLE_DISCOUNT,
  getResourceAdjustableRange,
  registerAggregator,
  getAggregatorById,
  getAggregatorByCode,
  listAggregators,
  registerResource,
  getResourceById,
  getResourceByCode,
  listResourcesByAggregator,
  updateResourceState,
  getResourceState,
  listResourceStatesByAggregator,
  calculateAggregatorAdjustableCapacity,
  calculateVppAdjustableCapacity,
  submitVppBid,
  getVppBids,
  getVppBid,
  distributeOutput,
  getOutputDistribution,
  getResourceOutputDistribution,
  submitActualOutput,
  submitActualOutputsBatch,
  getActualOutputsByResource,
  getActualOutputsByAggregator,
  evaluatePerformanceAndRedistribute,
  getResourcePerformanceRecords,
  getAggregatorPerformanceSummary,
  getResourcePerformanceSummary,
  executeVppSettlement,
  getVppSettlement,
  getVppSettlementDetail,
  getVppRevenueAllocations,
  getResourceRevenueAllocations,
  getCurrentOutputByHour,
  calculateRealTimeAdjustableMargin,
  submitRealTimeCommand,
  getRealTimeCommandDetail,
  getRealTimeCommands,
  getResourceRealTimeHistory,
  getCumulativeAdjustment,
  getHourlyCumulativeAdjustments
};
