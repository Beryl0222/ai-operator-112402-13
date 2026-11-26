import {
  blockPriority,
  buildTargetBlocks,
  evaluateBlockCandidates,
  selectBestEffort,
  selectCheapestFeasible,
} from './blocks.mjs';
import { evaluateRead } from './reduce.mjs';

function cheapestBits6(candidates) {
  return candidates.find((c) => c.bits === 6 && c.strictFeasible) ?? null;
}
function strictBits10(candidates) {
  return candidates.find((c) => c.bits === 10 && c.strictFeasible) ?? null;
}
function bestBits6(candidates) {
  return selectBestEffort(candidates.filter((c) => c.bits === 6));
}
function comboCost(combo) {
  return combo.reduce((sum, option) => sum + (option?.extensionBytes ?? 0), 0);
}
function maxLinf(combo) {
  return Math.max(...combo.map((o) => Number.isFinite(o.linf) ? o.linf : Number.MAX_VALUE));
}

function compactEvidence(allCandidatesForBlock, includeCandidateEvidence, full) {
  if (includeCandidateEvidence === false) return undefined;
  if (full) {
    return allCandidatesForBlock.map((candidate) => ({
      exponent: candidate.exponent,
      bits: candidate.bits,
      precision: candidate.precision,
      linf: Number.isFinite(candidate.linf) ? candidate.linf : null,
      quota: candidate.quota,
      quotaSatisfied: candidate.quotaSatisfied,
      withinRowQuota: candidate.withinRowQuota,
      withinOrdinalQuota: candidate.withinOrdinalQuota,
      saturatedCount: candidate.saturatedCount,
      unboundedCount: candidate.unboundedCount,
      extensionBytes: candidate.extensionBytes,
    }));
  }
  return allCandidatesForBlock.map((candidate) => [
    candidate.exponent,
    candidate.bits,
    Number.isFinite(candidate.linf) ? Number(candidate.linf.toPrecision(12)) : null,
    candidate.quotaSatisfied ? 1 : 0,
    candidate.saturatedCount,
  ]);
}

/**
 * Recode a once-read source frame into the spatial target layout and evaluate
 * all protected reads with one shared representation per block.
 */
export function recodeFrame(data, frame, options = {}) {
  const quotaMode = options.quotaMode ?? 'row';
  const blocks = buildTargetBlocks(data, frame);
  const perChannel = (data.shape[1] * data.shape[2]) / data.targetBlock;
  const allCandidates = blocks.map((block) => evaluateBlockCandidates(data, block, quotaMode));

  /** @type {(any|null)[]} */
  const selected = new Array(blocks.length).fill(null);
  const selectionState = blocks.map(() => ({
    certified: false,
    extensionAllocated: false,
    regionId: null,
    status: 'pending',
    reason: null,
  }));

  // Affordable deterministic default before protected-region optimization.
  blocks.forEach((block, i) => {
    const feasible = selectCheapestFeasible(allCandidates[i]);
    if (feasible?.bits === 6) {
      selected[i] = feasible;
      selectionState[i].certified = true;
      selectionState[i].status = 'certified';
      selectionState[i].reason = 'strict-6bit';
    } else {
      selected[i] = bestBits6(allCandidates[i]);
      selectionState[i].status = feasible?.bits === 10 ? 'awaiting-extension-budget' : 'block-quota-rejected';
      selectionState[i].reason = feasible?.bits === 10 ? 'strict-10bit-request' : 'no-strict-candidate';
    }
  });

  /** @type {any[]} */
  const plannedRegions = [];

  for (let c = 0; c < data.shape[0]; c++) {
    const parent = data.protectedReadSets.map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const union = (a, b) => {
      parent[find(a)] = find(b);
    };

    const setBlocks = data.protectedReadSets.map(([, positions]) => [
      ...new Set(positions.map((p) => Math.floor(p / data.targetBlock))),
    ]);
    for (let i = 0; i < setBlocks.length; i++) {
      for (let j = i + 1; j < setBlocks.length; j++) {
        if (setBlocks[i].some((b) => setBlocks[j].includes(b))) union(i, j);
      }
    }

    const components = new Map();
    for (let i = 0; i < data.protectedReadSets.length; i++) {
      const root = find(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(i);
    }

    for (const setIndices of components.values()) {
      const blockIndices = [...new Set(setIndices.flatMap((i) => setBlocks[i]))].sort((a, b) => a - b);
      const globalBlockIndices = blockIndices.map((b) => c * perChannel + b);
      const regionId = `channel-${c}-region-${blockIndices.join('-')}`;
      // All declared formats are considered jointly.  Block quotas and read
      // constraints are scored separately so an unprovable block does not hide
      // a sign-preserving actual representation.
      const blockOptions = blockIndices.map((b) => {
        const options = allCandidates[c * perChannel + b];
        const rangeSafe = options.filter((o) => o.rangeFeasible);
        // Never game a sign by choosing an exponent known to overflow when a
        // representable (even if less accurate) exponent exists.
        return rangeSafe.length > 0 ? rangeSafe : options;
      });

      /** @type {any[]} */
      const plans = [];
      const combo = [];
      const reps = new Array(perChannel).fill(null);
      const enumerate = (depth) => {
        if (depth === blockIndices.length) {
          const reports = setIndices.map((setIndex) =>
            evaluateRead({ data, frame, channel: c, setIndex, representations: reps })
          );
          const requiredSignFailures = reports.filter((r) => r.signRequired && !r.signGuaranteed).length;
          const anySignFailures = reports.filter((r) => !r.signGuaranteed).length;
          const levelFailures = reports.filter((r) => r.levelRequired && (r.absoluteSatisfied === false || r.relativeSatisfied === false)).length;
          const unboundedFailures = reports.filter((r) => !r.sourceBounded).length;
          const readConstraintsSatisfied = reports.every((r) => r.usable);
          const blockQuotaSatisfied = combo.every((o) => o.strictFeasible);
          const saturationCount = combo.reduce((n, o) => n + (o.saturatedCount ?? 0), 0);
          let levelBadness = 0;
          for (const r of reports) {
            if (!r.levelRequired) continue;
            if (r.maxAbs > 0 && Number.isFinite(r.absoluteError)) {
              levelBadness += r.absoluteError / r.maxAbs;
            } else if (r.absoluteSatisfied === false) {
              levelBadness += 1e6;
            }
            if (r.relativeEnergy !== null) {
              if (Number.isFinite(r.relativeError)) levelBadness += r.relativeError / r.relativeEnergy;
              else if (r.relativeSatisfied === false) levelBadness += 1e6;
            }
          }
          plans.push({
            combo: [...combo],
            reports,
            cost: comboCost(combo),
            maxLinf: maxLinf(combo),
            saturationCount,
            levelBadness,
            requiredSignFailures,
            anySignFailures,
            levelFailures,
            unboundedFailures,
            readConstraintsSatisfied,
            blockQuotaSatisfied,
            certified: readConstraintsSatisfied && blockQuotaSatisfied,
            score: requiredSignFailures * 1000
              + unboundedFailures * 500
              + levelFailures * 100
              + levelBadness
              + anySignFailures * 20
              + combo.filter((o) => !o.strictFeasible).length * 10
              + comboCost(combo) * 0.001,
          });
          return;
        }
        const b = blockIndices[depth];
        for (const option of blockOptions[depth]) {
          combo[depth] = option;
          reps[b] = option;
          enumerate(depth + 1);
        }
        reps[b] = null;
      };
      enumerate(0);

      const cheapest = (list) => list.sort((a, b) =>
        a.cost - b.cost || a.maxLinf - b.maxLinf || a.score - b.score
      )[0] ?? null;
      const bestSign = (list) => list.sort((a, b) =>
        a.anySignFailures - b.anySignFailures
        || a.levelFailures - b.levelFailures
        || a.levelBadness - b.levelBadness
        || a.saturationCount - b.saturationCount
        || a.combo.filter((o) => !o.strictFeasible).length - b.combo.filter((o) => !o.strictFeasible).length
        || a.cost - b.cost
        || a.maxLinf - b.maxLinf
      )[0] ?? null;
      const certifiedPlan = cheapest(plans.filter((p) => p.certified));
      const readPlan = cheapest(plans.filter((p) => p.readConstraintsSatisfied));
      const signPlan = bestSign(plans.filter((p) => p.requiredSignFailures === 0 && p.unboundedFailures === 0));
      const leastViolating = [...plans].sort((a, b) => a.score - b.score || a.cost - b.cost)[0] ?? null;
      const proposedPlan = certifiedPlan ?? readPlan ?? signPlan ?? leastViolating;

      const hasSign = setIndices.some((i) => data.readBounds[i].rule === 'sign');
      const priority = Math.max(...blockIndices.map((b) => data.priority?.[b % data.priority.length] ?? 0));
      plannedRegions.push({
        regionId,
        channel: c,
        setIndices,
        readIds: setIndices.map((i) => data.readBounds[i].id),
        blockIndices,
        globalBlockIndices,
        priority,
        hasSign,
        comboCount: plans.length,
        certifiedPlan,
        readPlan,
        signPlan,
        leastViolating,
        proposedPlan,
        accepted: false,
        signProtected: false,
        readConstraintsSatisfied: proposedPlan?.readConstraintsSatisfied ?? false,
        blockQuotaSatisfied: proposedPlan?.blockQuotaSatisfied ?? false,
        requiredSignFailures: proposedPlan?.requiredSignFailures ?? null,
        rejectionReasons: [],
      });
    }
  }

  // Priority-first reservation of extension bytes for whole dependency regions.
  let usedExtBytes = 0;
  const extBudget = options.extBytes ?? data.extBytes;
  const priorityDescending = (options.priorityDirection ?? 'higherNumberFirst') === 'higherNumberFirst';
  const priorityCompare = (a, b) => priorityDescending ? b.priority - a.priority : a.priority - b.priority;
  const regionOrder = [...plannedRegions].sort((a, b) => {
    if (a.hasSign !== b.hasSign) return a.hasSign ? -1 : 1;
    if (a.priority !== b.priority) return priorityCompare(a, b);
    return a.channel - b.channel || a.blockIndices[0] - b.blockIndices[0];
  });

  for (const region of regionOrder) {
    let plan = region.proposedPlan;
    // If the preferred plan is too expensive, fall back to the cheapest plan
    // that preserves the same required-sign tier.
    if (plan && usedExtBytes + plan.cost > extBudget) {
      const sameTier = region.leastViolating
        ? [region.leastViolating]
        : [];
      const affordable = sameTier.find((p) => usedExtBytes + p.cost <= extBudget);
      if (affordable) plan = affordable;
    }

    if (plan && usedExtBytes + plan.cost <= extBudget) {
      usedExtBytes += plan.cost;
      plan.combo.forEach((option, depth) => {
        const b = region.blockIndices[depth];
        const gi = region.channel * perChannel + b;
        selected[gi] = option;
        selectionState[gi] = {
          certified: plan.certified,
          extensionAllocated: option.bits === 10,
          regionId: region.regionId,
          status: plan.certified ? 'certified' : 'dependency-region-rejected',
          reason: plan.certified ? 'accepted-dependency-region' : 'sign-preserving-joint-plan-block-or-read-evidence-incomplete',
          dependencyRegionAccepted: plan.certified,
        };
      });
      region.allocatedExtBytes = plan.cost;
      region.applied = true;
      region.signProtected = plan.requiredSignFailures === 0 && plan.unboundedFailures === 0;
      region.readConstraintsSatisfied = plan.readConstraintsSatisfied;
      region.blockQuotaSatisfied = plan.blockQuotaSatisfied;
      region.accepted = !!plan.certified;
      if (!region.accepted) buildRegionReasons(region, plan);
    } else {
      region.applied = false;
      region.budgetConstrained = true;
      region.rejectionReasons.push({
        type: 'extension-budget',
        requiredBytes: plan?.cost ?? null,
        availableBytes: extBudget - usedExtBytes,
        budgetBytes: extBudget,
      });
      buildRegionReasons(region, plan);
      for (const gi of region.globalBlockIndices) {
        selectionState[gi].regionId = region.regionId;
        selectionState[gi].status = 'budget-rejected';
        selectionState[gi].reason = 'joint-plan-not-funded';
      }
    }
  }

  // General priority allocation for blocks outside protected regions.
  const protectedGlobal = new Set(plannedRegions.flatMap((r) => r.globalBlockIndices));
  /** @type {any[]} */
  const extensionRequests = [];
  blocks.forEach((block, gi) => {
    if (protectedGlobal.has(gi)) return;
    const candidates = allCandidates[gi];
    const strict6 = cheapestBits6(candidates);
    if (strict6) {
      selected[gi] = strict6;
      selectionState[gi].certified = true;
      selectionState[gi].status = 'certified';
      selectionState[gi].reason = 'strict-6bit';
      return;
    }
    const strict10 = strictBits10(candidates);
    if (strict10) extensionRequests.push({ block, gi, option: strict10, priority: blockPriority(data, block) });
  });

  extensionRequests.sort((a, b) => {
    const byPriority = priorityDescending ? b.priority - a.priority : a.priority - b.priority;
    return byPriority !== 0 ? byPriority : a.gi - b.gi;
  });
  for (const request of extensionRequests) {
    const cost = request.option.extensionBytes;
    if (usedExtBytes + cost <= extBudget) {
      usedExtBytes += cost;
      selected[request.gi] = request.option;
      selectionState[request.gi].extensionAllocated = true;
      selectionState[request.gi].certified = true;
      selectionState[request.gi].status = 'certified';
      selectionState[request.gi].reason = 'priority-extension';
    } else {
      selectionState[request.gi].status = 'budget-rejected';
      selectionState[request.gi].reason = 'strict-10bit-without-budget';
    }
  }

  // Final read reports use the one selected package representation per block.
  const representationsByChannel = Array.from({ length: data.shape[0] }, () => new Array(perChannel).fill(null));
  blocks.forEach((block, gi) => {
    representationsByChannel[block.channel][block.indexInChannel] = selected[gi];
  });
  /** @type {any[]} */
  const readReports = [];
  for (let c = 0; c < data.shape[0]; c++) {
    for (let i = 0; i < data.protectedReadSets.length; i++) {
      const report = evaluateRead({
        data,
        frame,
        channel: c,
        setIndex: i,
        representations: representationsByChannel[c],
      });
      const region = plannedRegions.find((r) => r.channel === c && r.setIndices.includes(i));
      report.regionId = region?.regionId ?? null;
      report.regionAccepted = region?.accepted ?? false;
      report.signProtectedByRegion = region?.signProtected ?? false;
      report.packageUsable = report.usable && report.regionAccepted;
      report.signPackageUsable = report.signGuaranteed && (region?.applied ?? false);
      readReports.push(report);
    }
  }

  const blockRecords = blocks.map((block, gi) => {
    const choice = selected[gi];
    const state = selectionState[gi];
    return {
      id: block.id,
      layout: 'spatial-row-major-block-v1',
      channel: block.channel,
      block: block.indexInChannel,
      globalBlock: block.globalIndex,
      residue: block.residue,
      priority: blockPriority(data, block),
      positions: block.positions,
      exponent: choice.exponent,
      bits: choice.bits,
      precision: choice.precision,
      mantissas: choice.mantissas,
      valid: block.points.map((p) => p.valid),
      extensionBytes: choice.extensionBytes,
      extensionBits: choice.extensionBits,
      extensionSlots: choice.extensionBits,
      extraMantissaBits: choice.bits === 10 ? 4 * choice.validCount : 0,
      extensionAllocated: !!state.extensionAllocated,
      saturatedCount: choice.saturatedCount,
      unboundedCount: choice.unboundedCount,
      linf: Number.isFinite(choice.linf) ? choice.linf : null,
      worstPoint: choice.worstPoint,
      quota: choice.quota,
      quotaMode,
      quotaSatisfied: !!choice.strictFeasible,
      certified: !!state.certified,
      status: state.status,
      reason: state.reason,
      regionId: state.regionId,
      dependencyRegionAccepted: state.dependencyRegionAccepted ?? null,
      candidateEvidence: compactEvidence(
        allCandidates[gi],
        options.includeCandidateEvidence,
        options.fullCandidateEvidence
      ),
    };
  });

  const certifiedBlocks = blockRecords.filter((b) => b.certified).length;
  const extendedBlocks = blockRecords.filter((b) => b.extensionAllocated).length;
  const stats = {
    totalBlocks: blocks.length,
    certifiedBlocks,
    rejectedBlocks: blocks.length - certifiedBlocks,
    extendedBlocks,
    usedExtBytes,
    extBudgetBytes: extBudget,
    extRemainingBytes: extBudget - usedExtBytes,
    acceptedRegions: plannedRegions.filter((r) => r.accepted).length,
    signProtectedRegions: plannedRegions.filter((r) => r.signProtected).length,
    rejectedRegions: plannedRegions.filter((r) => !r.accepted).length,
    usablePackageReads: readReports.filter((r) => r.packageUsable).length,
    signProtectedReads: readReports.filter((r) => r.signPackageUsable).length,
    totalReadReports: readReports.length,
    scratchBytes: data.scratchBytes,
    scratchRequiredBytes: data.targetBlock * 80 + data.protectedReadSets.length * 128,
    scratchSufficient: data.scratchBytes >= data.targetBlock * 80 + data.protectedReadSets.length * 128,
  };

  return {
    quotaMode,
    blocks,
    allCandidates,
    selected,
    blockRecords,
    readReports,
    regions: plannedRegions.map(serializeRegion),
    allocation: {
      extBudgetBytes: extBudget,
      extBudgetBits: extBudget * 8,
      usedExtBytes,
      usedExtBits: usedExtBytes * 8,
      remainingExtBytes: extBudget - usedExtBytes,
      scratchBytes: data.scratchBytes,
      scratchRequiredBytes: stats.scratchRequiredBytes,
      scratchSufficient: stats.scratchSufficient,
      priorityOrder: priorityDescending ? 'larger-priority-number-first' : 'smaller-priority-number-first',
    },
    stats,
  };
}

function buildRegionReasons(region, plan) {
  if (!plan) {
    region.rejectionReasons.push({ type: 'no-joint-plan' });
    return;
  }
  for (const report of plan.reports) {
    if (report.signRequired && !report.signGuaranteed) {
      region.rejectionReasons.push({
        type: 'read-sign',
        read: report.boundId,
        setIndex: report.setIndex,
        channel: report.channel,
        sourceSign: report.sourceSign,
        outputSign: report.outputSign,
      });
    }
    if (report.absoluteSatisfied === false) {
      region.rejectionReasons.push({
        type: 'read-abs-error',
        read: report.boundId,
        setIndex: report.setIndex,
        channel: report.channel,
        absoluteError: report.absoluteError,
        maxAbs: report.maxAbs,
      });
    }
    if (report.relativeSatisfied === false) {
      region.rejectionReasons.push({
        type: 'read-relative-error',
        read: report.boundId,
        setIndex: report.setIndex,
        channel: report.channel,
        relativeError: report.relativeError,
        relativeEnergy: report.relativeEnergy,
      });
    }
    if (!report.sourceBounded) {
      region.rejectionReasons.push({ type: 'unbounded-source-interval', read: report.boundId, setIndex: report.setIndex, channel: report.channel });
    }
  }
  for (const [depth, option] of plan.combo.entries()) {
    if (!option.strictFeasible) {
      const b = region.blockIndices[depth];
      region.rejectionReasons.push({
        type: 'block-quota',
        block: `c${region.channel}-b${b}`,
        globalBlock: region.globalBlockIndices[depth],
        exponent: option.exponent,
        bits: option.bits,
        linf: Number.isFinite(option.linf) ? option.linf : null,
        quota: option.quota,
      });
    }
  }
}

function serializeRegion(region) {
  const { certifiedPlan, readPlan, signPlan, leastViolating, proposedPlan, ...rest } = region;
  const summarize = (plan) => plan ? {
    cost: plan.cost,
    maxLinf: Number.isFinite(plan.maxLinf) ? plan.maxLinf : null,
    saturationCount: plan.saturationCount,
    levelBadness: Number.isFinite(plan.levelBadness) ? plan.levelBadness : null,
    certified: plan.certified,
    readConstraintsSatisfied: plan.readConstraintsSatisfied,
    blockQuotaSatisfied: plan.blockQuotaSatisfied,
    requiredSignFailures: plan.requiredSignFailures,
    levelFailures: plan.levelFailures,
    exponents: plan.combo.map((o) => o.exponent),
    bits: plan.combo.map((o) => o.bits),
  } : null;
  return {
    ...rest,
    certifiedPlan: summarize(certifiedPlan),
    readPlan: summarize(readPlan),
    signPlan: summarize(signPlan),
    leastViolating: summarize(leastViolating),
    proposedPlan: summarize(proposedPlan),
  };
}
