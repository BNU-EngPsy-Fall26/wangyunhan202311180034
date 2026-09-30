"use strict";

const difficultyConfig = {
  easy: { label: "容易", dPrime: 2.0, darkShift: 15, normalJitter: 1.8 },
  medium: { label: "中等", dPrime: 1.2, darkShift: 10, normalJitter: 2.4 },
  hard: { label: "困难", dPrime: 0.6, darkShift: 6, normalJitter: 3.0 },
};

const scenarioConfig = {
  routine: {
    label: "普通生产批次",
    source: "生产线随机抽出的20支口红",
    environment: "在标准白光下和合格颜色对比",
    consequence: "放过偏暗口红可能引起投诉；拦错正常口红会增加复检时间",
    title: "请检查这20支口红，判断能不能放行",
    lead: "你是口红厂的质检员。每次左边是合格的标准颜色，右边是刚生产的口红。右边明显更暗就拦下复检；只有一点点正常色差就放行。",
    strategyNote: "普通批次中偏暗样本不常见，漏检和误拦都需要控制。",
    prior: 0.2,
    payoffs: { hit: 8, miss: -12, falseAlarm: -4, correctRejection: 3 },
  },
  launch: {
    label: "新品第一批",
    source: "准备上市的新品第一批口红",
    environment: "在标准白光下先做人工检查",
    consequence: "漏掉偏暗口红会影响新品口碑；拦下后还可以用仪器确认",
    title: "新品第一批马上要上市，请先检查颜色",
    lead: "这是新品第一次大批量生产。偏暗样本预计仍然很少，所以不能见到一点差别就拦截；但漏掉真正的偏暗产品会影响新品口碑。两种因素会把判断标准推向相反方向。",
    strategyNote: "异常较少会推动标准升高；漏检影响大又会推动标准降低。两种作用相互抵消，当前预设最终略偏保守。",
    prior: 0.12,
    payoffs: { hit: 10, miss: -20, falseAlarm: -3, correctRejection: 3 },
  },
  rework: {
    label: "投诉后返工批",
    source: "因为偏暗投诉而返工的一批口红",
    environment: "在标准白光下重新逐支抽查",
    consequence: "再次放过偏暗口红会引起重复投诉；拦错可以再用仪器确认",
    title: "这批口红曾被投诉偏暗，请重新检查",
    lead: "这批产品之前收到过“颜色偏暗”的投诉，现在已经返工。这里出现偏暗样本的可能性更高，而且不能再次漏检；两个因素都会让你更主动地拦截。",
    strategyNote: "异常本来就更多，而且再次漏检代价很大。两种作用方向一致，都会推动判断标准降低。",
    prior: 0.55,
    payoffs: { hit: 12, miss: -24, falseAlarm: -3, correctRejection: 2 },
  },
};

const qaMode = new URLSearchParams(window.location.search).get("qa") === "1";
const historyStorageKey = "lipstick-sdt-history-v1";
const timings = qaMode
  ? { prepare: 25, observe: 40, transition: 15 }
  : { prepare: 500, observe: 1500, transition: 450 };

const state = {
  mode: "intro",
  phase: "idle",
  difficulty: "medium",
  modelDPrime: 1.2,
  scenario: "routine",
  reference: { h: 345, s: 57, l: 42 },
  sample: { h: 345, s: 57, l: 42 },
  sampleType: "normal",
  trialIndex: 0,
  currentTrial: null,
  practiceTrials: [],
  formalTrials: [],
  practiceRecords: [],
  formalRecords: [],
  interruptions: 0,
  trialPresentedAt: null,
  answerOpenedAt: null,
  timerId: null,
  runToken: 0,
  answerLocked: true,
  reportStatistics: null,
  batchId: "",
  workOrder: "",
  history: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  referenceCanvas: $("#reference-canvas"),
  sampleCanvas: $("#sample-canvas"),
  tutorialNormal: $("#tutorial-normal"),
  tutorialAbnormal: $("#tutorial-abnormal"),
  batchId: $("#batch-id"),
  sampleNumber: $("#sample-number"),
  modelDPrime: $("#model-dprime"),
  phaseLabel: $("#phase-label"),
  modeLabel: $("#mode-label"),
  previewStatus: $("#preview-status"),
  progressFill: $("#progress-fill"),
  progressCount: $("#progress-count"),
  observationStrip: $(".observation-strip"),
  sampleMask: $("#sample-mask"),
  maskKicker: $("#mask-kicker"),
  maskMessage: $("#mask-message"),
  feedback: $(".preview-result"),
  feedbackLabel: $("#feedback-label"),
  feedbackTitle: $("#preview-result-title"),
  feedbackCopy: $("#preview-result-copy"),
  nextPractice: $("#next-practice"),
  introOverlay: $("#intro-overlay"),
  messageOverlay: $("#message-overlay"),
  pauseOverlay: $("#pause-overlay"),
  messageKicker: $("#message-kicker"),
  messageTitle: $("#message-title"),
  messageCopy: $("#message-copy"),
  messageAction: $("#message-action"),
  sessionSummary: $("#session-summary"),
  reportOverlay: $("#report-overlay"),
  distributionCanvas: $("#distribution-canvas"),
  rocCanvas: $("#roc-canvas"),
  historyCanvas: $("#history-canvas"),
};

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function hslString(color, alpha = 1) {
  return `hsla(${color.h.toFixed(1)}, ${color.s.toFixed(1)}%, ${color.l.toFixed(1)}%, ${alpha})`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawSwatch(canvas, color) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const size = Math.min(width, height);
  ctx.clearRect(0, 0, width, height);
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#eee8e3");
  background.addColorStop(1, "#ded5cf");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-0.035);
  const swatchWidth = size * 0.58;
  const swatchHeight = size * 0.68;
  const x = -swatchWidth / 2;
  const y = -swatchHeight / 2;
  ctx.shadowColor = "rgba(44, 23, 29, 0.16)";
  ctx.shadowBlur = size * 0.05;
  ctx.shadowOffsetY = size * 0.027;
  roundedRect(ctx, x, y, swatchWidth, swatchHeight, size * 0.07);
  const fill = ctx.createLinearGradient(x, y, x + swatchWidth, y + swatchHeight);
  fill.addColorStop(0, hslString({ ...color, l: clamp(color.l + 4, 0, 100) }));
  fill.addColorStop(0.5, hslString(color));
  fill.addColorStop(1, hslString({ ...color, l: clamp(color.l - 4, 0, 100) }));
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.globalAlpha = 0.18;
  for (let index = 0; index < 8; index += 1) {
    const lineY = y + swatchHeight * (0.16 + index * 0.095);
    ctx.beginPath();
    ctx.moveTo(x + swatchWidth * 0.12, lineY);
    ctx.bezierCurveTo(x + swatchWidth * 0.34, lineY - size * 0.015, x + swatchWidth * 0.66, lineY + size * 0.015, x + swatchWidth * 0.88, lineY);
    ctx.strokeStyle = "rgba(255,255,255,0.64)";
    ctx.lineWidth = Math.max(1, size * 0.004);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.16;
  const gloss = ctx.createLinearGradient(x, y, x + swatchWidth, y);
  gloss.addColorStop(0, "rgba(255,255,255,0)");
  gloss.addColorStop(0.48, "rgba(255,255,255,0.9)");
  gloss.addColorStop(0.62, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  roundedRect(ctx, x, y, swatchWidth, swatchHeight, size * 0.07);
  ctx.fill();
  ctx.restore();
}

function drawAll() {
  drawSwatch(elements.referenceCanvas, state.reference);
  drawSwatch(elements.sampleCanvas, state.sample);
}

function drawLessonExamples() {
  drawSwatch(elements.tutorialNormal, { h: 344, s: 56, l: 43.5 });
  drawSwatch(elements.tutorialAbnormal, { h: 344, s: 56, l: 31.5 });
}

function createSessionIdentifiers() {
  const now = new Date();
  const dateCode = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  state.batchId = `RB-${dateCode}-${String(Math.floor(randomBetween(10, 99))).padStart(2, "0")}`;
  state.workOrder = `WO-${dateCode}-${String(Math.floor(randomBetween(100, 999))).padStart(3, "0")}`;
  elements.batchId.textContent = state.batchId;
  $("#work-order").textContent = state.workOrder;
}

function applyScenario(scenarioKey) {
  if (!scenarioConfig[scenarioKey] || state.mode !== "intro") return;
  state.scenario = scenarioKey;
  const scenario = scenarioConfig[scenarioKey];
  $("#intro-title").textContent = scenario.title;
  $("#intro-title").nextElementSibling.textContent = scenario.lead;
  $("#scenario-source").textContent = scenario.source;
  $("#scenario-environment").textContent = scenario.environment;
  $("#scenario-consequence").textContent = scenario.consequence;
  $("#payoff-scenario-label").textContent = scenario.label;
  $("#scenario-strategy-note").textContent = scenario.strategyNote;
  $("#prior-signal").value = String(scenario.prior);
  $("#payoff-hit").value = String(scenario.payoffs.hit);
  $("#payoff-miss").value = String(scenario.payoffs.miss);
  $("#payoff-fa").value = String(scenario.payoffs.falseAlarm);
  $("#payoff-cr").value = String(scenario.payoffs.correctRejection);
  $$(".scenario-option").forEach((button) => {
    const active = button.dataset.scenario === scenarioKey;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  updatePayoffStrategy();
}

function setMask(visible, kicker, message) {
  elements.maskKicker.textContent = kicker;
  elements.maskMessage.textContent = message;
  elements.sampleMask.classList.toggle("is-visible", visible);
}

function setAnswersEnabled(enabled) {
  state.answerLocked = !enabled;
  $$(".decision-button").forEach((button) => {
    button.disabled = !enabled;
  });
}

function clearFeedback() {
  $$(".decision-button").forEach((button) => button.classList.remove("is-selected"));
  elements.feedback.classList.remove("is-correct", "is-incorrect");
  elements.feedbackLabel.textContent = "操作提示";
  elements.feedbackTitle.textContent = "请观察两侧试色";
  elements.feedbackCopy.textContent = "待检试色被遮住后，判断按钮才会开放。";
  elements.nextPractice.classList.add("is-hidden");
}

function difficultyLabel(dPrime) {
  if (dPrime >= 1.7) return "容易";
  if (dPrime >= 0.9) return "中等";
  return "困难";
}

function currentDifficultyParameters() {
  return {
    label: difficultyLabel(state.modelDPrime),
    dPrime: state.modelDPrime,
    darkShift: clamp(4 + state.modelDPrime * 5.5, 6, 20.5),
    normalJitter: clamp(3.45 - state.modelDPrime * 0.85, 1.2, 3.1),
  };
}

function setDifficulty(value) {
  if (state.mode !== "intro") return;
  const preset = typeof value === "string" ? difficultyConfig[value] : null;
  const dPrime = preset ? preset.dPrime : clamp(Number(value), 0.5, 3);
  if (!Number.isFinite(dPrime)) return;
  state.modelDPrime = Math.round(dPrime * 10) / 10;
  state.difficulty = state.modelDPrime >= 1.7 ? "easy" : state.modelDPrime >= 0.9 ? "medium" : "hard";
  elements.modelDPrime.textContent = `d′ = ${state.modelDPrime.toFixed(1)}`;
  $("#intro-difficulty").value = String(state.modelDPrime);
  $("#intro-difficulty-value").textContent = `d′ ${state.modelDPrime.toFixed(1)}`;
  $("#difficulty-slider").value = String(state.modelDPrime);
  $("#difficulty-slider-value").textContent = state.modelDPrime.toFixed(1);
  $$("[data-control='difficulty'] .segment").forEach((button) => {
    const active = button.dataset.value === state.difficulty;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  generateStimulus(state.sampleType);
}

function setDifficultyControlsLocked(locked) {
  $$("[data-control='difficulty'] .segment").forEach((button) => {
    button.disabled = locked;
  });
  $("#difficulty-slider").disabled = locked;
  $("#intro-difficulty").disabled = locked;
}

function generateStimulus(truth) {
  const config = currentDifficultyParameters();
  const darkening = truth === "abnormal" ? config.darkShift : 0;
  state.sampleType = truth;
  state.sample = {
    h: clamp(state.reference.h + randomBetween(-1.3, 1.3), 0, 360),
    s: clamp(state.reference.s + randomBetween(-1.8, 1.8), 42, 72),
    l: clamp(state.reference.l + randomBetween(-config.normalJitter, config.normalJitter) - darkening, 20, 64),
  };
  elements.sampleNumber.textContent = String(Math.floor(randomBetween(1, 9999))).padStart(4, "0");
  drawAll();
}

function makeTrial(truth, index, stage) {
  return { id: `${stage}-${String(index + 1).padStart(2, "0")}`, truth, stage };
}

function prepareTrialQueues() {
  state.practiceTrials = shuffle(["normal", "normal", "abnormal", "abnormal"]).map((truth, index) => makeTrial(truth, index, "practice"));
  state.formalTrials = shuffle([...Array(10).fill("normal"), ...Array(10).fill("abnormal")]).map((truth, index) => makeTrial(truth, index, "formal"));
}

function cancelTimer() {
  if (state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  state.runToken += 1;
  elements.observationStrip.classList.remove("is-observing");
}

function schedule(duration, callback) {
  const token = state.runToken;
  state.timerId = window.setTimeout(() => {
    if (token !== state.runToken) return;
    state.timerId = null;
    callback();
  }, duration);
}

function currentQueue() {
  return state.mode === "practice" ? state.practiceTrials : state.formalTrials;
}

function updateProgress(completed = false) {
  const total = state.mode === "practice" ? 4 : 20;
  const current = Math.min(total, state.trialIndex + (completed ? 1 : 0));
  elements.progressFill.style.width = `${(current / total) * 100}%`;
  elements.progressCount.textContent = `${current} / ${total}`;
  elements.progressFill.parentElement.setAttribute("aria-label", `${state.mode === "practice" ? "练习" : "正式检测"}进度 ${current}/${total}`);
}

function runCurrentTrial(isReplay = false) {
  cancelTimer();
  clearFeedback();
  setAnswersEnabled(false);
  document.body.dataset.running = "true";
  if (!isReplay) {
    state.currentTrial = currentQueue()[state.trialIndex];
    state.interruptions = 0;
  }
  generateStimulus(state.currentTrial.truth);
  state.phase = "prepare";
  state.trialPresentedAt = null;
  state.answerOpenedAt = null;
  const isPractice = state.mode === "practice";
  const trialNumber = state.trialIndex + 1;
  elements.phaseLabel.textContent = isPractice ? `练习 ${trialNumber} / 4` : `正式检测 ${trialNumber} / 20`;
  elements.modeLabel.textContent = isPractice ? "练习模式" : "正式模式";
  elements.previewStatus.textContent = "准备 500 ms";
  setMask(true, "即将显示", "请注视比较区");
  updateProgress(false);
  schedule(timings.prepare, () => {
    state.phase = "observe";
    state.trialPresentedAt = Date.now();
    elements.previewStatus.textContent = "观察 1500 ms";
    setMask(false, "正在观察", "比较两侧明度");
    elements.observationStrip.classList.remove("is-observing");
    void elements.observationStrip.offsetWidth;
    elements.observationStrip.classList.add("is-observing");
    schedule(timings.observe, () => {
      state.phase = "answer";
      state.answerOpenedAt = Date.now();
      elements.observationStrip.classList.remove("is-observing");
      elements.previewStatus.textContent = "等待判断";
      setMask(true, "观察结束", "请选择色差判断");
      setAnswersEnabled(true);
      elements.feedbackTitle.textContent = "现在可以作答";
      elements.feedbackCopy.textContent = isPractice ? "练习会在提交后显示答案与解释。" : "本次回答只记录一次，提交后不可修改。";
    });
  });
}

function outcomeFor(truth, response) {
  if (truth === "abnormal" && response === "abnormal") return "hit";
  if (truth === "abnormal" && response === "normal") return "miss";
  if (truth === "normal" && response === "abnormal") return "false-alarm";
  return "correct-rejection";
}

function recordAnswer(response) {
  if (state.phase !== "answer" || state.answerLocked) return;
  setAnswersEnabled(false);
  state.phase = "feedback";
  const now = Date.now();
  const record = {
    trialId: state.currentTrial.id,
    stage: state.mode,
    trialNumber: state.trialIndex + 1,
    truth: state.currentTrial.truth,
    response,
    outcome: outcomeFor(state.currentTrial.truth, response),
    difficulty: state.difficulty,
    modelDPrime: state.modelDPrime,
    scenario: state.scenario,
    referenceColor: { ...state.reference },
    sampleColor: { ...state.sample },
    presentedAt: state.trialPresentedAt,
    answeredAt: now,
    responseTimeMs: Math.max(0, now - state.answerOpenedAt),
    interruptions: state.interruptions,
  };
  const records = state.mode === "practice" ? state.practiceRecords : state.formalRecords;
  if (!records.some((item) => item.trialId === record.trialId)) records.push(record);
  $$(".decision-button").forEach((button) => button.classList.toggle("is-selected", button.dataset.answer === response));
  updateProgress(true);
  if (state.mode === "practice") {
    const correct = response === state.currentTrial.truth;
    elements.feedback.classList.toggle("is-correct", correct);
    elements.feedback.classList.toggle("is-incorrect", !correct);
    elements.feedbackLabel.textContent = correct ? "练习反馈" : "请注意判断标准";
    elements.feedbackTitle.textContent = correct ? "判断正确" : "这次判断不正确";
    elements.feedbackCopy.textContent = state.currentTrial.truth === "abnormal"
      ? "该样本整体明度降低，应判断为“异常偏暗”。"
      : "该样本只有允许范围内的轻微波动，应判断为“色差正常”。";
    elements.nextPractice.textContent = state.trialIndex === 3 ? "完成练习" : "下一次练习";
    elements.nextPractice.classList.remove("is-hidden");
    return;
  }
  elements.feedbackLabel.textContent = "回答已记录";
  elements.feedbackTitle.textContent = `第 ${state.trialIndex + 1} 次已完成`;
  elements.feedbackCopy.textContent = "正式检测不即时显示正确答案，即将进入下一次。";
  schedule(timings.transition, advanceFormal);
}

function inverseNormalCdf(probability) {
  if (probability <= 0 || probability >= 1) throw new RangeError("Probability must be between 0 and 1");
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;
  let q;
  let r;
  if (probability < low) {
    q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > high) {
    q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = probability - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function calculateStatistics(records) {
  const counts = { hit: 0, miss: 0, falseAlarm: 0, correctRejection: 0 };
  records.forEach((record) => {
    if (record.outcome === "hit") counts.hit += 1;
    else if (record.outcome === "miss") counts.miss += 1;
    else if (record.outcome === "false-alarm") counts.falseAlarm += 1;
    else if (record.outcome === "correct-rejection") counts.correctRejection += 1;
  });
  const signalTotal = counts.hit + counts.miss;
  const noiseTotal = counts.falseAlarm + counts.correctRejection;
  const total = signalTotal + noiseTotal;
  const rawHitRate = signalTotal ? counts.hit / signalTotal : 0;
  const rawFalseAlarmRate = noiseTotal ? counts.falseAlarm / noiseTotal : 0;
  const accuracy = total ? (counts.hit + counts.correctRejection) / total : 0;
  const correctedHitRate = (counts.hit + 0.5) / (signalTotal + 1);
  const correctedFalseAlarmRate = (counts.falseAlarm + 0.5) / (noiseTotal + 1);
  const zHit = inverseNormalCdf(correctedHitRate);
  const zFalseAlarm = inverseNormalCdf(correctedFalseAlarmRate);
  return {
    counts,
    signalTotal,
    noiseTotal,
    total,
    rawHitRate,
    rawFalseAlarmRate,
    accuracy,
    correctedHitRate,
    correctedFalseAlarmRate,
    dPrime: zHit - zFalseAlarm,
    criterion: -0.5 * (zHit + zFalseAlarm),
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function fixedMetric(value) {
  return Math.abs(value) < 0.005 ? "0.00" : value.toFixed(2);
}

function sensitivityInterpretation(dPrime) {
  if (dPrime >= 2) return "本轮对正常与偏暗样本的区分较清楚。";
  if (dPrime >= 1) return "本轮能够区分两类样本，但仍存在一定重叠。";
  if (dPrime >= 0.5) return "本轮辨别线索有限，两类样本较容易混淆。";
  return "本轮作答接近难以区分的状态，需要结合更多轮次观察。";
}

function criterionInterpretation(criterion) {
  if (criterion > 0.2) return "c 为正，本轮拦截标准较严格：你需要更强的偏暗证据才会拦截，因此可能漏过偏暗样本。";
  if (criterion < -0.2) return "c 为负，本轮拦截标准较宽松：较弱的偏暗证据也会触发复检，可能增加正常样本误拦。";
  return "c 接近 0，本轮在放行与拦截之间没有明显的单侧回答倾向。";
}

function loadHistory() {
  if (qaMode) return;
  try {
    const stored = JSON.parse(window.localStorage.getItem(historyStorageKey) || "[]");
    state.history = Array.isArray(stored)
      ? stored.filter((item) => Number.isFinite(item?.dPrime) && Number.isFinite(item?.accuracy)).slice(-10)
      : [];
  } catch {
    state.history = [];
  }
}

function storeHistory() {
  if (qaMode) return;
  try {
    window.localStorage.setItem(historyStorageKey, JSON.stringify(state.history.slice(-10)));
  } catch {
    // 隐私模式或 file:// 存储受限时，仍可在当前页面内比较。
  }
}

function recordHistory(statistics) {
  state.history.push({
    id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    completedAt: new Date().toISOString(),
    scenario: state.scenario,
    modelDPrime: state.modelDPrime,
    dPrime: statistics.dPrime,
    criterion: statistics.criterion,
    accuracy: statistics.accuracy,
    hitRate: statistics.rawHitRate,
    falseAlarmRate: statistics.rawFalseAlarmRate,
    counts: { ...statistics.counts },
  });
  state.history = state.history.slice(-10);
  storeHistory();
}

function historyTimeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "本轮";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function renderHistory() {
  const entries = state.history.slice(-5);
  const body = $("#history-table-body");
  body.replaceChildren();
  if (!entries.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "还没有可比较的历史记录";
    row.appendChild(cell);
    body.appendChild(row);
    $("#history-summary").textContent = "完成两轮后，这里会显示变化趋势。";
  } else {
    [...entries].reverse().forEach((entry, reverseIndex) => {
      const row = document.createElement("tr");
      if (reverseIndex === 0) row.classList.add("is-current");
      const values = [
        reverseIndex === 0 ? `本轮 · ${historyTimeLabel(entry.completedAt)}` : historyTimeLabel(entry.completedAt),
        scenarioConfig[entry.scenario]?.label || "未记录",
        Number(entry.modelDPrime).toFixed(1),
        fixedMetric(entry.dPrime),
        percent(entry.accuracy),
        fixedMetric(entry.criterion),
      ];
      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
    if (entries.length === 1) {
      $("#history-summary").textContent = "已保存本轮汇总。再完成一轮后即可比较变化。";
    } else {
      const previous = entries.at(-2);
      const current = entries.at(-1);
      const dPrimeChange = current.dPrime - previous.dPrime;
      const accuracyChange = (current.accuracy - previous.accuracy) * 100;
      const dText = `${dPrimeChange >= 0 ? "+" : ""}${dPrimeChange.toFixed(2)}`;
      const accuracyText = `${accuracyChange >= 0 ? "+" : ""}${accuracyChange.toFixed(1)} 个百分点`;
      $("#history-summary").textContent = `与上一轮相比：玩家 d′ ${dText}，准确率 ${accuracyText}。请同时结合 c 的变化判断进步来自辨别能力还是回答策略。`;
    }
  }
  drawHistoryChart(entries);
}

function drawHistoryChart(entries) {
  const canvas = elements.historyCanvas;
  if (!canvas) return;
  const cssWidth = Math.max(320, canvas.clientWidth || 900);
  const cssHeight = Math.max(250, canvas.clientHeight || 300);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = "#fffaf6";
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  const margin = { top: 34, right: 52, bottom: 46, left: 48 };
  const width = cssWidth - margin.left - margin.right;
  const height = cssHeight - margin.top - margin.bottom;
  ctx.strokeStyle = "#ded2cc";
  ctx.lineWidth = 1;
  for (let step = 0; step <= 4; step += 1) {
    const y = margin.top + (step / 4) * height;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + width, y);
    ctx.stroke();
  }
  ctx.fillStyle = "#766a6c";
  ctx.font = "11px Microsoft YaHei UI, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("100%", margin.left - 8, margin.top + 4);
  ctx.fillText("0%", margin.left - 8, margin.top + height + 4);
  ctx.textAlign = "left";
  ctx.fillText("d′ 3.5", margin.left + width + 8, margin.top + 4);
  ctx.fillText("d′ -1.5", margin.left + width + 8, margin.top + height + 4);
  if (!entries.length) return;
  const pointX = (index) => entries.length === 1 ? margin.left + width / 2 : margin.left + (index / (entries.length - 1)) * width;
  const accuracyY = (value) => margin.top + (1 - clamp(value, 0, 1)) * height;
  const dPrimeY = (value) => margin.top + (1 - ((clamp(value, -1.5, 3.5) + 1.5) / 5)) * height;
  const drawSeries = (selector, color) => {
    ctx.beginPath();
    entries.forEach((entry, index) => {
      const x = pointX(index);
      const y = selector(entry);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
    entries.forEach((entry, index) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pointX(index), selector(entry), 5, 0, Math.PI * 2);
      ctx.fill();
    });
  };
  drawSeries((entry) => accuracyY(entry.accuracy), "#a9294d");
  drawSeries((entry) => dPrimeY(entry.dPrime), "#637889");
  ctx.textAlign = "center";
  ctx.fillStyle = "#766a6c";
  entries.forEach((entry, index) => ctx.fillText(`第${state.history.length - entries.length + index + 1}轮`, pointX(index), cssHeight - 16));
  ctx.textAlign = "left";
  ctx.fillStyle = "#a9294d";
  ctx.fillRect(margin.left, 12, 18, 3);
  ctx.fillText("准确率", margin.left + 24, 17);
  ctx.fillStyle = "#637889";
  ctx.fillRect(margin.left + 88, 12, 18, 3);
  ctx.fillText("玩家 d′", margin.left + 112, 17);
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function gaussian(value, mean) {
  return Math.exp(-0.5 * ((value - mean) ** 2)) / Math.sqrt(2 * Math.PI);
}

function drawDistributionLab() {
  const canvas = elements.distributionCanvas;
  if (!canvas) return;
  const dPrime = Number($("#viz-dprime").value);
  const criterion = Number($("#viz-criterion").value);
  const threshold = dPrime / 2 + criterion;
  const hitRate = 1 - normalCdf(threshold - dPrime);
  const falseAlarmRate = 1 - normalCdf(threshold);
  $("#viz-dprime-value").textContent = dPrime.toFixed(2);
  $("#viz-criterion-value").textContent = criterion > 0 ? `+${criterion.toFixed(2)}` : criterion.toFixed(2);
  $("#viz-hit-rate").textContent = percent(hitRate);
  $("#viz-fa-rate").textContent = percent(falseAlarmRate);

  const cssWidth = Math.max(320, canvas.clientWidth || 760);
  const cssHeight = Math.max(260, canvas.clientHeight || 320);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const margin = { top: 28, right: 28, bottom: 48, left: 38 };
  const plotWidth = cssWidth - margin.left - margin.right;
  const plotHeight = cssHeight - margin.top - margin.bottom;
  const domainMin = -3.5;
  const domainMax = 5;
  const xToPixel = (value) => margin.left + ((value - domainMin) / (domainMax - domainMin)) * plotWidth;
  const yToPixel = (value) => margin.top + plotHeight - (value / 0.43) * plotHeight;

  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = "#fffaf6";
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.strokeStyle = "#ded2cc";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top + plotHeight);
  ctx.lineTo(margin.left + plotWidth, margin.top + plotHeight);
  ctx.stroke();

  const drawCurve = (mean, stroke, fill) => {
    ctx.beginPath();
    for (let index = 0; index <= 180; index += 1) {
      const value = domainMin + (index / 180) * (domainMax - domainMin);
      const x = xToPixel(value);
      const y = yToPixel(gaussian(value, mean));
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(xToPixel(domainMax), margin.top + plotHeight);
    ctx.lineTo(xToPixel(domainMin), margin.top + plotHeight);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.beginPath();
    for (let index = 0; index <= 180; index += 1) {
      const value = domainMin + (index / 180) * (domainMax - domainMin);
      const x = xToPixel(value);
      const y = yToPixel(gaussian(value, mean));
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;
    ctx.stroke();
  };

  drawCurve(0, "#637889", "rgba(99, 120, 137, 0.14)");
  drawCurve(dPrime, "#a9294d", "rgba(169, 41, 77, 0.14)");
  const criterionX = xToPixel(threshold);
  ctx.setLineDash([7, 6]);
  ctx.strokeStyle = "#2d2527";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(criterionX, margin.top - 5);
  ctx.lineTo(criterionX, margin.top + plotHeight + 5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#2d2527";
  ctx.font = "700 12px Microsoft YaHei UI, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("拦截标准", criterionX, margin.top - 10);
  ctx.fillStyle = "#766a6c";
  ctx.font = "12px Microsoft YaHei UI, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("更像正常 → 放行", margin.left, cssHeight - 15);
  ctx.textAlign = "right";
  ctx.fillText("更像偏暗 → 拦截", margin.left + plotWidth, cssHeight - 15);
  drawRoc();
  updatePayoffStrategy();
}

function drawRoc() {
  const canvas = elements.rocCanvas;
  if (!canvas) return;
  const dPrime = Number($("#viz-dprime").value);
  const criterion = Number($("#viz-criterion").value);
  const threshold = dPrime / 2 + criterion;
  const currentHit = 1 - normalCdf(threshold - dPrime);
  const currentFalseAlarm = 1 - normalCdf(threshold);
  const auc = normalCdf(dPrime / Math.sqrt(2));
  $("#roc-auc").textContent = auc.toFixed(3);
  $("#roc-hit").textContent = percent(currentHit);
  $("#roc-fa").textContent = percent(currentFalseAlarm);

  const cssWidth = Math.max(300, canvas.clientWidth || 520);
  const cssHeight = Math.max(280, canvas.clientHeight || 360);
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const margin = { top: 24, right: 24, bottom: 48, left: 54 };
  const width = cssWidth - margin.left - margin.right;
  const height = cssHeight - margin.top - margin.bottom;
  const px = (value) => margin.left + value * width;
  const py = (value) => margin.top + (1 - value) * height;
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = "#fffaf6";
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.strokeStyle = "#ded2cc";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + height);
  ctx.lineTo(margin.left + width, margin.top + height);
  ctx.stroke();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "#b7aaa5";
  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  ctx.lineTo(px(1), py(1));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let index = 0; index <= 180; index += 1) {
    const criterionValue = -4.5 + (index / 180) * 9;
    const fa = 1 - normalCdf(criterionValue);
    const hit = 1 - normalCdf(criterionValue - dPrime);
    if (index === 0) ctx.moveTo(px(fa), py(hit));
    else ctx.lineTo(px(fa), py(hit));
  }
  ctx.strokeStyle = "#a9294d";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = "#2d2527";
  ctx.beginPath();
  ctx.arc(px(currentFalseAlarm), py(currentHit), 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "white";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#766a6c";
  ctx.font = "12px Microsoft YaHei UI, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("虚报率 P(FA)", margin.left + width / 2, cssHeight - 12);
  ctx.save();
  ctx.translate(15, margin.top + height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("命中率 P(H)", 0, 0);
  ctx.restore();
  ctx.textAlign = "left";
  ctx.fillText("0", margin.left - 14, margin.top + height + 17);
  ctx.textAlign = "right";
  ctx.fillText("1", margin.left + width + 4, margin.top + height + 17);
  ctx.fillText("1", margin.left - 10, margin.top + 4);
}

function payoffNumber(selector) {
  const value = Number($(selector).value);
  return Number.isFinite(value) ? value : 0;
}

function updatePayoffStrategy() {
  if (!$("#prior-signal")) return;
  const priorSignal = Number($("#prior-signal").value);
  const priorNoise = 1 - priorSignal;
  const hit = payoffNumber("#payoff-hit");
  const miss = payoffNumber("#payoff-miss");
  const falseAlarm = payoffNumber("#payoff-fa");
  const correctRejection = payoffNumber("#payoff-cr");
  const numerator = correctRejection - falseAlarm;
  const denominator = hit - miss;
  $("#prior-value").textContent = percent(priorSignal);
  if (priorSignal <= 0 || priorNoise <= 0 || numerator <= 0 || denominator <= 0) {
    $("#optimal-beta").textContent = "不可计算";
    $("#optimal-criterion").textContent = "--";
    $("#optimal-copy").textContent = "请确保命中优于漏检、正确放行优于误拦。";
    $("#apply-optimal").disabled = true;
    return;
  }
  const beta = (priorNoise / priorSignal) * (numerator / denominator);
  const dPrime = Math.max(0.1, Math.abs(Number($("#viz-dprime").value)));
  const optimalCriterion = Math.log(beta) / dPrime;
  $("#optimal-beta").textContent = beta.toFixed(2);
  $("#optimal-criterion").textContent = optimalCriterion > 0 ? `+${optimalCriterion.toFixed(2)}` : optimalCriterion.toFixed(2);
  $("#optimal-copy").textContent = optimalCriterion > 0.2
    ? "当前风险组合建议提高拦截门槛，更重视避免误拦。"
    : optimalCriterion < -0.2
      ? "当前风险组合建议降低拦截门槛，更重视避免漏检。"
      : "当前风险组合建议采用接近均衡的判断标准。";
  $("#apply-optimal").disabled = false;
  $("#apply-optimal").dataset.criterion = String(clamp(optimalCriterion, -1.5, 1.5));
}

function restoreObservedDistribution() {
  if (!state.reportStatistics) return;
  $("#viz-dprime").value = String(clamp(state.reportStatistics.dPrime, -1.5, 3.5));
  $("#viz-criterion").value = String(clamp(state.reportStatistics.criterion, -1.5, 1.5));
  drawDistributionLab();
}

function renderReport(statistics) {
  state.reportStatistics = statistics;
  $("#report-valid-count").textContent = `${statistics.total} / 20`;
  $("#metric-hit-rate").textContent = percent(statistics.rawHitRate);
  $("#metric-fa-rate").textContent = percent(statistics.rawFalseAlarmRate);
  $("#metric-accuracy").textContent = percent(statistics.accuracy);
  $("#metric-dprime").textContent = fixedMetric(statistics.dPrime);
  $("#metric-criterion").textContent = fixedMetric(statistics.criterion);
  $("#criterion-direction").textContent = statistics.criterion > 0.2 ? "偏保守" : statistics.criterion < -0.2 ? "偏宽松" : "较均衡";
  $("#count-hit").textContent = statistics.counts.hit;
  $("#count-miss").textContent = statistics.counts.miss;
  $("#count-fa").textContent = statistics.counts.falseAlarm;
  $("#count-cr").textContent = statistics.counts.correctRejection;
  $("#sensitivity-copy").textContent = sensitivityInterpretation(statistics.dPrime);
  $("#criterion-copy").textContent = criterionInterpretation(statistics.criterion);
  $("#accuracy-copy").textContent = `本轮准确率为 ${percent(statistics.accuracy)}，但其中包含 ${statistics.counts.miss} 次漏检和 ${statistics.counts.falseAlarm} 次误拦。漏检可能让偏暗产品进入包装，误拦则会触发复测与等待；同样的准确率可以对应完全不同的质量风险。`;
  $("#report-scenario").textContent = scenarioConfig[state.scenario].label;
  $("#report-model-dprime").textContent = state.modelDPrime.toFixed(1);
  $("#viz-dprime").value = String(clamp(statistics.dPrime, -1.5, 3.5));
  $("#viz-criterion").value = String(clamp(statistics.criterion, -1.5, 1.5));
}

function advancePractice() {
  if (state.mode !== "practice" || state.phase !== "feedback") return;
  state.trialIndex += 1;
  if (state.trialIndex < state.practiceTrials.length) runCurrentTrial();
  else showPracticeComplete();
}

function advanceFormal() {
  if (state.mode !== "formal") return;
  state.trialIndex += 1;
  if (state.trialIndex < state.formalTrials.length) runCurrentTrial();
  else showFormalComplete();
}

function showPracticeComplete() {
  cancelTimer();
  state.phase = "between";
  const correct = state.practiceRecords.filter((record) => record.truth === record.response).length;
  elements.messageKicker.textContent = "4 次练习已完成";
  elements.messageTitle.textContent = "准备进入正式检测";
  elements.messageCopy.textContent = "正式检测共 20 次，不会即时显示答案。请保持页面在前台并尽量连续完成。";
  elements.sessionSummary.innerHTML = `<div><dt>练习正确</dt><dd>${correct} / 4</dd></div><div><dt>正式试次</dt><dd>20 次</dd></div>`;
  elements.messageAction.textContent = "开始正式检测";
  elements.messageAction.dataset.action = "start-formal";
  elements.messageOverlay.classList.add("is-visible");
}

function showFormalComplete() {
  cancelTimer();
  state.mode = "complete";
  state.phase = "complete";
  document.body.dataset.running = "false";
  setMask(true, "本轮完成", "20 条回答已记录");
  setAnswersEnabled(false);
  elements.phaseLabel.textContent = "正式检测完成";
  elements.modeLabel.textContent = "完成";
  elements.previewStatus.textContent = "等待查看报告";
  elements.progressFill.style.width = "100%";
  elements.progressCount.textContent = "20 / 20";
  elements.feedbackLabel.textContent = "本轮完成";
  elements.feedbackTitle.textContent = "已记录 20 条正式数据";
  elements.feedbackCopy.textContent = "本轮统计与四格结果已生成，可在报告页查看。";
  const statistics = calculateStatistics(state.formalRecords);
  renderReport(statistics);
  recordHistory(statistics);
  elements.reportOverlay.classList.add("is-visible");
  window.requestAnimationFrame(() => {
    try {
      drawDistributionLab();
      renderHistory();
    } catch (error) {
      console.error("教学图表绘制失败，核心报告仍可查看。", error);
    }
  });
}

function startPractice() {
  cancelTimer();
  state.mode = "practice";
  state.phase = "idle";
  state.trialIndex = 0;
  state.practiceRecords = [];
  state.formalRecords = [];
  prepareTrialQueues();
  setDifficultyControlsLocked(true);
  elements.introOverlay.classList.remove("is-visible");
  runCurrentTrial();
}

function startFormal() {
  cancelTimer();
  state.mode = "formal";
  state.phase = "idle";
  state.trialIndex = 0;
  state.formalRecords = [];
  elements.messageOverlay.classList.remove("is-visible");
  runCurrentTrial();
}

function resetExperiment() {
  cancelTimer();
  state.mode = "intro";
  state.phase = "idle";
  state.trialIndex = 0;
  state.currentTrial = null;
  state.practiceRecords = [];
  state.formalRecords = [];
  state.reportStatistics = null;
  createSessionIdentifiers();
  document.body.dataset.running = "false";
  elements.messageOverlay.classList.remove("is-visible");
  elements.pauseOverlay.classList.remove("is-visible");
  elements.reportOverlay.classList.remove("is-visible");
  elements.introOverlay.classList.add("is-visible");
  elements.phaseLabel.textContent = "班前任务简报";
  elements.modeLabel.textContent = "教学模式";
  elements.previewStatus.textContent = "等待开始";
  elements.progressFill.style.width = "0%";
  elements.progressCount.textContent = "0 / 20";
  elements.progressFill.parentElement.setAttribute("aria-label", "实验进度 0/20");
  setDifficultyControlsLocked(false);
  setMask(true, "准备开始", "阅读教学说明");
  setAnswersEnabled(false);
  clearFeedback();
  elements.feedbackTitle.textContent = "请先阅读教学说明";
  elements.feedbackCopy.textContent = "完成 4 次练习后，将进入 20 次正式检测。";
}

function interruptTimedTrial() {
  if (!document.hidden && document.hasFocus()) return;
  if (state.phase !== "prepare" && state.phase !== "observe") return;
  cancelTimer();
  state.phase = "interrupted";
  state.interruptions += 1;
  setAnswersEnabled(false);
  setMask(true, "检测已暂停", "返回后重新播放");
  elements.previewStatus.textContent = "页面失焦，试次未记录";
  elements.pauseOverlay.classList.add("is-visible");
}

function replayInterruptedTrial() {
  if (state.phase !== "interrupted") return;
  elements.pauseOverlay.classList.remove("is-visible");
  runCurrentTrial(true);
}

function updateClock() {
  $("#clock").textContent = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

$$("[data-control='difficulty'] .segment").forEach((button) => button.addEventListener("click", () => setDifficulty(button.dataset.value)));
$("#difficulty-slider").addEventListener("input", (event) => setDifficulty(Number(event.target.value)));
$$(".scenario-option").forEach((button) => button.addEventListener("click", () => applyScenario(button.dataset.scenario)));
$$("[data-control='sample-type'] .segment").forEach((button) => {
  button.addEventListener("click", () => {
    if (state.mode !== "intro") return;
    $$("[data-control='sample-type'] .segment").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    generateStimulus(button.dataset.value);
    setMask(false, "开发预览", "自由比较");
  });
});

$("#regenerate").addEventListener("click", () => {
  if (state.mode !== "intro") return;
  generateStimulus(state.sampleType);
  setMask(false, "开发预览", "自由比较");
});
$("#intro-difficulty").addEventListener("input", (event) => setDifficulty(Number(event.target.value)));
$("#start-practice").addEventListener("click", startPractice);
elements.nextPractice.addEventListener("click", advancePractice);
$("#replay-trial").addEventListener("click", replayInterruptedTrial);
$("#restart-session").addEventListener("click", resetExperiment);
$("#restart-from-report").addEventListener("click", resetExperiment);
elements.messageAction.addEventListener("click", () => {
  if (elements.messageAction.dataset.action === "start-formal") startFormal();
  else resetExperiment();
});
$$(".decision-button").forEach((button) => button.addEventListener("click", () => recordAnswer(button.dataset.answer)));
window.addEventListener("blur", interruptTimedTrial);
document.addEventListener("visibilitychange", interruptTimedTrial);
window.addEventListener("resize", drawAll);
window.addEventListener("resize", () => {
  if (elements.reportOverlay.classList.contains("is-visible")) {
    drawDistributionLab();
    drawHistoryChart(state.history.slice(-5));
  }
});
$("#viz-dprime").addEventListener("input", drawDistributionLab);
$("#viz-criterion").addEventListener("input", drawDistributionLab);
$("#restore-observed").addEventListener("click", restoreObservedDistribution);
$$("#prior-signal, #payoff-hit, #payoff-miss, #payoff-fa, #payoff-cr").forEach((input) => input.addEventListener("input", updatePayoffStrategy));
$("#apply-optimal").addEventListener("click", () => {
  const criterion = Number($("#apply-optimal").dataset.criterion);
  if (!Number.isFinite(criterion)) return;
  $("#viz-criterion").value = String(criterion);
  drawDistributionLab();
  $("#distribution-title").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("#clear-history").addEventListener("click", () => {
  if (!window.confirm("确定清除保存在这台设备上的多轮汇总记录吗？当前报告不会被关闭。")) return;
  state.history = [];
  try {
    window.localStorage.removeItem(historyStorageKey);
  } catch {
    // 存储不可用时只清理当前页面内的数据。
  }
  renderHistory();
});

window.experimentData = {
  get practice() { return state.practiceRecords.map((record) => ({ ...record })); },
  get formal() { return state.formalRecords.map((record) => ({ ...record })); },
  get status() { return { mode: state.mode, phase: state.phase, trialIndex: state.trialIndex, difficulty: state.difficulty, modelDPrime: state.modelDPrime, scenario: state.scenario }; },
  get report() { return calculateStatistics(state.formalRecords); },
  get history() { return state.history.map((entry) => ({ ...entry, counts: { ...entry.counts } })); },
};

function runStatisticsSelfTests() {
  const recordsFromOutcomes = (outcomes) => outcomes.map((outcome, index) => ({ trialId: `test-${index}`, outcome }));
  const perfect = calculateStatistics(recordsFromOutcomes([...Array(10).fill("hit"), ...Array(10).fill("correct-rejection")]));
  const allNormal = calculateStatistics(recordsFromOutcomes([...Array(10).fill("miss"), ...Array(10).fill("correct-rejection")]));
  const allAbnormal = calculateStatistics(recordsFromOutcomes([...Array(10).fill("hit"), ...Array(10).fill("false-alarm")]));
  const checks = [
    perfect.total === 20,
    perfect.counts.hit === 10 && perfect.counts.correctRejection === 10,
    Number.isFinite(perfect.dPrime) && perfect.dPrime > 3,
    Number.isFinite(allNormal.dPrime) && Math.abs(allNormal.dPrime) < 0.01 && allNormal.criterion > 1,
    Number.isFinite(allAbnormal.dPrime) && Math.abs(allAbnormal.dPrime) < 0.01 && allAbnormal.criterion < -1,
  ];
  if (checks.some((check) => !check)) throw new Error("统计自检未通过");
  return { passed: checks.length, perfectDPrime: perfect.dPrime, allNormalCriterion: allNormal.criterion, allAbnormalCriterion: allAbnormal.criterion };
}

window.statisticsSelfTest = runStatisticsSelfTests();
document.documentElement.dataset.statisticsSelfTest = `passed:${window.statisticsSelfTest.passed}`;

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  try {
    void Promise.resolve(context.registerTool({
      name: "configure_experiment_difficulty",
      title: "设置实验难度",
      description: "在教学开始前设置本轮实验难度。",
      inputSchema: {
        type: "object",
        properties: { difficulty: { type: "string", enum: Object.keys(difficultyConfig) } },
        required: ["difficulty"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (state.mode !== "intro") throw new Error("实验开始后不能修改难度");
        if (!input || !difficultyConfig[input.difficulty]) throw new TypeError("难度无效");
        setDifficulty(input.difficulty);
        return { difficulty: state.difficulty, modelDPrime: state.modelDPrime };
      },
    })).catch(() => {});
  } catch {
    // 不支持 WebMCP 的浏览器继续使用可见控件。
  }
}

setDifficulty("medium");
applyScenario("routine");
createSessionIdentifiers();
loadHistory();
generateStimulus("normal");
drawLessonExamples();
setAnswersEnabled(false);
elements.progressFill.parentElement.setAttribute("aria-label", "实验进度 0/20");
updateClock();
setInterval(updateClock, 1000);
registerWebMcpTools();

if (qaMode && new URLSearchParams(window.location.search).get("report") === "1") {
  applyScenario("rework");
  state.mode = "formal";
  elements.introOverlay.classList.remove("is-visible");
  state.history = [
    { id: "qa-1", completedAt: "2026-09-27T08:30:00.000Z", scenario: "routine", modelDPrime: 1.2, dPrime: 0.82, criterion: 0.42, accuracy: 0.65, hitRate: 0.5, falseAlarmRate: 0.2, counts: { hit: 5, miss: 5, falseAlarm: 2, correctRejection: 8 } },
    { id: "qa-2", completedAt: "2026-09-28T08:30:00.000Z", scenario: "launch", modelDPrime: 1.2, dPrime: 1.05, criterion: 0.28, accuracy: 0.7, hitRate: 0.6, falseAlarmRate: 0.2, counts: { hit: 6, miss: 4, falseAlarm: 2, correctRejection: 8 } },
  ];
  state.formalRecords = [
    ...Array(7).fill("hit"),
    ...Array(3).fill("miss"),
    ...Array(2).fill("false-alarm"),
    ...Array(8).fill("correct-rejection"),
  ].map((outcome, index) => ({ trialId: `qa-report-${index}`, outcome }));
  window.requestAnimationFrame(showFormalComplete);
}
