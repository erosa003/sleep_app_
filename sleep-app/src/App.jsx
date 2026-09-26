import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Moon, Sun, Milk, TrendingUp, MessageCircle, CalendarDays,
  BarChart3, ChevronRight, ChevronDown, Sparkles, AlertTriangle,
  Plus, Edit2, Trash2, Send, Home, Loader2
} from 'lucide-react';

/* ======================================================================
   0. CONSTANTES Y UTILIDADES DE TIEMPO
   ====================================================================== */

const STORAGE_KEY = 'sleep-data-v2';
const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtDateISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtDurationMin = (mins) => {
  if (mins == null || isNaN(mins)) return '—';
  mins = Math.max(0, Math.round(mins));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
};
const fmtDateHuman = (isoDate) => {
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const minutesBetween = (a, b) => (b.getTime() - a.getTime()) / 60000;

// "Día de sueño": si un evento ocurre antes de las 05:00, pertenece a la
// jornada del día anterior (para no cortar la noche en dos días distintos).
function sessionDateOf(date) {
  const d = new Date(date);
  if (d.getHours() < 5) d.setDate(d.getDate() - 1);
  return fmtDateISO(d);
}

// Si a esta hora ("time") el día naive todavía no tiene eventos, pero el día
// anterior terminó con un sueño que sigue abierto (sin despertar registrado
// todavía), seguimos considerando que estamos "dentro" de esa sesión —
// evita perder la noche cuando el bebé duerme hasta después de las 5am.
function resolveEventBucket(time, daysData, nightCutoffHour) {
  const naiveISO = sessionDateOf(time);
  const naiveEvents = daysData[naiveISO] || [];
  if (naiveEvents.length > 0) return naiveISO;
  const prevISO = fmtDateISO(new Date(new Date(naiveISO + 'T12:00:00').getTime() - 86400000));
  const prevEvents = daysData[prevISO] || [];
  if (prevEvents.length === 0) return naiveISO;
  const segs = Math1.buildSegments(prevEvents, nightCutoffHour);
  const last = segs[segs.length - 1];
  if (last && last.kind === 'asleep' && last.ongoing && new Date(time) > last.start) {
    return prevISO;
  }
  return naiveISO;
}

function findBucketForEvent(eventId, daysData) {
  for (const key of Object.keys(daysData)) {
    if ((daysData[key] || []).some((e) => e.id === eventId)) return key;
  }
  return null;
}

function ageInMonths(birthDateStr, atDate) {
  const birth = new Date(birthDateStr + 'T00:00:00');
  const diffDays = (atDate - birth) / 86400000;
  return diffDays / 30.4375;
}

// Referencia base por edad (punto de partida, NO regla fija).
const AGE_TABLE = [
  { max: 1, min: 45, max_: 60, naps: 4.5, label: '0–1 mes' },
  { max: 2, min: 60, max_: 90, naps: 4, label: '1–2 meses' },
  { max: 3, min: 75, max_: 90, naps: 3.5, label: '2–3 meses' },
  { max: 4, min: 90, max_: 105, naps: 3.5, label: '3–4 meses' },
  { max: 5, min: 105, max_: 120, naps: 3, label: '4–5 meses' },
  { max: 6, min: 120, max_: 150, naps: 3, label: '5–6 meses' },
  { max: 8, min: 150, max_: 180, naps: 2.5, label: '6–8 meses' },
  { max: 10, min: 165, max_: 210, naps: 2, label: '8–10 meses' },
  { max: 14, min: 180, max_: 240, naps: 1.5, label: '10–14 meses' },
  { max: 18, min: 210, max_: 300, naps: 1, label: '14–18 meses' },
  { max: 36, min: 300, max_: 360, naps: 1, label: '18–36 meses' },
  { max: 999, min: 360, max_: 420, naps: 0.5, label: '3+ años' },
];
function ageBaseline(months) {
  const row = AGE_TABLE.find((r) => months <= r.max) || AGE_TABLE[AGE_TABLE.length - 1];
  return { minWindow: row.min, maxWindow: row.max_, midWindow: (row.min + row.max_) / 2, expectedNaps: row.naps, label: row.label };
}

/* ======================================================================
   1. CAPA MATEMÁTICA — solo cálculos objetivos, ninguna decisión
   ====================================================================== */

const Math1 = {
  // A partir de una lista cronológica de eventos de UN día, arma los
  // "segmentos" de vigilia y sueño.
  buildSegments(events, nightCutoffHour) {
    const sorted = [...events].filter((e) => e.type === 'wake' || e.type === 'sleep').sort((a, b) => new Date(a.time) - new Date(b.time));
    const segments = [];
    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i];
      const next = sorted[i + 1];
      if (ev.type === 'sleep') {
        const start = new Date(ev.time);
        const end = next ? new Date(next.time) : null;
        const hour = start.getHours() + start.getMinutes() / 60;
        const subtype = hour >= nightCutoffHour || hour < 6 ? 'night' : 'nap';
        segments.push({
          kind: 'asleep', subtype, start, end,
          durationMin: end ? minutesBetween(start, end) : null,
          ongoing: !end,
        });
      } else {
        const start = new Date(ev.time);
        const end = next ? new Date(next.time) : null;
        segments.push({
          kind: 'awake', start, end,
          durationMin: end ? minutesBetween(start, end) : null,
          ongoing: !end,
        });
      }
    }
    return segments;
  },

  dayStats(events, nightCutoffHour, now) {
    const segments = this.buildSegments(events, nightCutoffHour);
    const naps = segments.filter((s) => s.kind === 'asleep' && s.subtype === 'nap');
    const nights = segments.filter((s) => s.kind === 'asleep' && s.subtype === 'night');
    const completedNaps = naps.filter((n) => !n.ongoing);
    const napDurations = completedNaps.map((n) => n.durationMin);
    const dailyNapSleep = napDurations.reduce((a, b) => a + b, 0);
    const nightDurations = nights.filter((n) => !n.ongoing).map((n) => n.durationMin);
    const nightSleep = nightDurations.reduce((a, b) => a + b, 0);

    const feedings = events.filter((e) => e.type === 'feeding').sort((a, b) => new Date(a.time) - new Date(b.time));
    const totalMl = feedings.reduce((a, f) => a + (Number(f.data?.ml) || 0), 0);
    const feedIntervals = [];
    for (let i = 1; i < feedings.length; i++) {
      feedIntervals.push(minutesBetween(new Date(feedings[i - 1].time), new Date(feedings[i].time)));
    }

    const lastSeg = segments[segments.length - 1];
    const currentState = lastSeg ? lastSeg.kind : 'unknown';
    const currentSleepSubtype = currentState === 'asleep' ? lastSeg.subtype : null;
    const lastWakeSeg = [...segments].reverse().find((s) => s.kind === 'awake');
    const lastSleepSeg = [...segments].reverse().find((s) => s.kind === 'asleep');

    // Si está durmiendo de noche, busca cuándo arrancó ESA noche realmente,
    // aunque haya habido despertares breves en el medio (tomas). Un
    // despertar corto (< NIGHT_WAKE_GAP) no cuenta como "empezar el día".
    const NIGHT_WAKE_GAP = 75; // minutos
    let nightSleepOnset = null;
    let nightWakingsCount = 0;
    if (currentState === 'asleep' && currentSleepSubtype === 'night') {
      let idx = segments.length - 1;
      nightSleepOnset = segments[idx].start;
      while (idx - 1 >= 0) {
        const gapAwake = segments[idx - 1];
        const priorSleep = segments[idx - 2];
        if (
          gapAwake && gapAwake.kind === 'awake' && gapAwake.durationMin != null && gapAwake.durationMin <= NIGHT_WAKE_GAP &&
          priorSleep && priorSleep.kind === 'asleep' && priorSleep.subtype === 'night'
        ) {
          nightSleepOnset = priorSleep.start;
          nightWakingsCount++;
          idx -= 2;
        } else {
          break;
        }
      }
    }

    const awakeDurationMinutes = currentState === 'awake' && lastSeg?.ongoing ? minutesBetween(lastSeg.start, now) : (lastWakeSeg ? lastWakeSeg.durationMin : null);
    const asleepDurationMinutes = currentState === 'asleep' && lastSeg?.ongoing ? minutesBetween(lastSeg.start, now) : null;

    const lastCompletedNap = [...completedNaps].pop();
    const lastNapDurationMinutes = lastCompletedNap ? lastCompletedNap.durationMin : null;

    const lastFeeding = feedings[feedings.length - 1];
    const minutesSinceLastFeeding = lastFeeding ? minutesBetween(new Date(lastFeeding.time), now) : null;

    const signs = events.filter((e) => e.type === 'sign');
    const recentSigns = signs.filter((s) => minutesBetween(new Date(s.time), now) <= 25 && minutesBetween(new Date(s.time), now) >= 0);

    return {
      segments, naps, nights, napCount: naps.length,
      napDurations, dailyNapSleep, nightSleep,
      avgNapDuration: napDurations.length ? dailyNapSleep / napDurations.length : null,
      feedings, totalMl, feedIntervals,
      avgFeedInterval: feedIntervals.length ? feedIntervals.reduce((a, b) => a + b, 0) / feedIntervals.length : null,
      lastFeeding, minutesSinceLastFeeding,
      currentState, currentSleepSubtype, lastWakeSeg, lastSleepSeg,
      lastWakeTime: currentState === 'awake' ? lastSeg?.start : (lastWakeSeg ? lastWakeSeg.start : null),
      lastSleepTime: currentState === 'asleep' ? lastSeg?.start : (lastSleepSeg ? lastSleepSeg.start : null),
      nightSleepOnset, nightWakingsCount,
      awakeDurationMinutes, asleepDurationMinutes, lastNapDurationMinutes,
      recentSigns, allSigns: signs,
      totalDaySleep: dailyNapSleep + nightSleep,
    };
  },
};

/* ======================================================================
   2. APRENDIZAJE DEL PATRÓN INDIVIDUAL
   ====================================================================== */

function buildIndividualPattern(historyDays /* [{date, events}], excluye hoy */, nightCutoffHour, todayISO) {
  // pesos por antigüedad
  const weightFor = (isoDate) => {
    const days = Math.round((new Date(todayISO) - new Date(isoDate)) / 86400000);
    if (days <= 3) return 3;
    if (days <= 7) return 2;
    if (days <= 14) return 1;
    return 0.4;
  };

  let napWindowSum = 0, napWindowWeight = 0;
  let nightWindowSum = 0, nightWindowWeight = 0;
  let napDurSum = 0, napDurWeight = 0;
  let nightDurSum = 0, nightDurWeight = 0;
  let feedIntervalSum = 0, feedIntervalWeight = 0;
  let feedMlSum = 0, feedMlWeight = 0;
  let feedBeforeSleepCount = 0, feedTotal = 0;
  let daysWithData = 0;

  historyDays.forEach(({ date, events }) => {
    if (!events || events.length === 0) return;
    daysWithData++;
    const w = weightFor(date);
    const segs = Math1.buildSegments(events, nightCutoffHour);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.kind === 'asleep' && !s.ongoing) {
        const prevAwake = segs[i - 1];
        if (prevAwake && prevAwake.kind === 'awake' && prevAwake.durationMin != null) {
          if (s.subtype === 'nap') { napWindowSum += prevAwake.durationMin * w; napWindowWeight += w; }
          else { nightWindowSum += prevAwake.durationMin * w; nightWindowWeight += w; }
        }
        if (s.subtype === 'nap' && s.durationMin != null) { napDurSum += s.durationMin * w; napDurWeight += w; }
        if (s.subtype === 'night' && s.durationMin != null) { nightDurSum += s.durationMin * w; nightDurWeight += w; }
      }
    }
    const feedings = events.filter((e) => e.type === 'feeding').sort((a, b) => new Date(a.time) - new Date(b.time));
    for (let i = 1; i < feedings.length; i++) {
      feedIntervalSum += minutesBetween(new Date(feedings[i - 1].time), new Date(feedings[i].time)) * w;
      feedIntervalWeight += w;
    }
    feedings.forEach((f) => {
      const ml = Number(f.data?.ml);
      if (ml > 0) { feedMlSum += ml * w; feedMlWeight += w; }
    });
    const sleepStarts = segs.filter((s) => s.kind === 'asleep').map((s) => s.start);
    feedings.forEach((f) => {
      feedTotal++;
      const t = new Date(f.time);
      const closeSleep = sleepStarts.some((ss) => { const diff = minutesBetween(t, ss); return diff >= -5 && diff <= 60; });
      if (closeSleep) feedBeforeSleepCount++;
    });
  });

  return {
    daysWithData,
    individualNapWindow: napWindowWeight ? napWindowSum / napWindowWeight : null,
    individualNightWindow: nightWindowWeight ? nightWindowSum / nightWindowWeight : null,
    individualNapDuration: napDurWeight ? napDurSum / napDurWeight : null,
    individualNightDuration: nightDurWeight ? nightDurSum / nightDurWeight : null,
    individualFeedInterval: feedIntervalWeight ? feedIntervalSum / feedIntervalWeight : null,
    individualFeedMl: feedMlWeight ? feedMlSum / feedMlWeight : null,
    feedBeforeSleepRatio: feedTotal ? feedBeforeSleepCount / feedTotal : null,
  };
}

function blendRatio(daysWithData) {
  if (daysWithData < 3) return { age: 0.6, individual: 0.4 };
  if (daysWithData < 10) return { age: 0.3, individual: 0.7 };
  return { age: 0.2, individual: 0.8 };
}

/* ======================================================================
   3. CAPA DE DECISIÓN — combina todo, nunca una fórmula rígida única
   ====================================================================== */

function decisionEngine({ profile, stats, pattern, now, learningBias }) {
  const months = ageInMonths(profile.birthDate, now);
  const baseline = ageBaseline(months);
  const ratio = blendRatio(pattern.daysWithData);

  // ---- ventana base combinada (edad + patrón individual) ----
  const indivNap = pattern.individualNapWindow ?? baseline.midWindow;
  const indivNight = pattern.individualNightWindow ?? baseline.midWindow;
  let baseNapWindow = baseline.midWindow * ratio.age + indivNap * ratio.individual;
  let baseNightWindow = baseline.midWindow * ratio.age + indivNight * ratio.individual;

  // ---- ajuste por duración de la última siesta ----
  const typicalNap = pattern.individualNapDuration ?? 45;
  let napAdjustmentFactor = 1;
  let napQualityLabel = null;
  if (stats.lastNapDurationMinutes != null) {
    const relation = stats.lastNapDurationMinutes / typicalNap;
    if (relation < 0.55) { napAdjustmentFactor = 0.78; napQualityLabel = 'corta'; }
    else if (relation > 1.35) { napAdjustmentFactor = 1.12; napQualityLabel = 'larga'; }
    else { napAdjustmentFactor = 1; napQualityLabel = 'normal'; }
  }

  // ---- presión de sueño ----
  const expectedWindow = stats.currentState === 'awake' ? baseNapWindow * napAdjustmentFactor : baseNapWindow;
  const awake = stats.awakeDurationMinutes ?? 0;
  const pressureFromTime = expectedWindow > 0 ? clamp(awake / expectedWindow, 0, 1.6) / 1.6 : 0;
  const pressureFromNap = napQualityLabel === 'corta' ? 0.7 : napQualityLabel === 'larga' ? 0.25 : 0.45;
  const hourOfDay = now.getHours() + now.getMinutes() / 60;
  const pressureFromTimeOfDay = clamp((hourOfDay - 12) / 12, 0, 1) * 0.3;
  const sleepPressure = clamp(pressureFromTime * 0.6 + pressureFromNap * 0.25 + pressureFromTimeOfDay * 0.15, 0, 1);

  // ---- ajuste circadiano: cuánto falta para el objetivo nocturno ----
  const [th, tm] = (profile.nightTarget || '20:00').split(':').map(Number);
  const nightTarget = new Date(now); nightTarget.setHours(th, tm, 0, 0);
  if (nightTarget < now && stats.currentState === 'awake' && awake < 60) { /* ya pasó, se usa igual como referencia de "objetivo" */ }
  const minutesToNight = minutesBetween(now, nightTarget);

  const napsSoFar = stats.napCount;
  const expectedNapsLeft = Math.max(0, Math.round(baseline.expectedNaps) - napsSoFar);

  let adjustedWindow = baseNapWindow * napAdjustmentFactor;
  if (sleepPressure > 0.8) adjustedWindow *= 0.85;
  else if (sleepPressure < 0.25 && hourOfDay < 11) adjustedWindow *= 1.05;

  // límites para evitar valores absurdos: no menos del 55% ni más del 145% del baseline de edad
  adjustedWindow = clamp(adjustedWindow, baseline.midWindow * 0.55, baseline.midWindow * 1.45);

  // aplicar sesgo aprendido de predicciones pasadas
  if (learningBias?.napBiasMinutes) adjustedWindow += learningBias.napBiasMinutes;

  const overtired = sleepPressure > 0.87 || (expectedWindow > 0 && awake > expectedWindow * 1.45);

  // ---- señales de sueño recientes ----
  const tiredSigns = stats.recentSigns.filter((s) => s.data?.subtype !== 'refuses_sleep');
  const refusalSigns = stats.recentSigns.filter((s) => s.data?.subtype === 'refuses_sleep');
  const hasTiredSign = tiredSigns.length > 0;
  const hasRefusal = refusalSigns.length > 0 && !hasTiredSign;

  // ---- decidir acción (Capa 2) ----
  let action, nextWindowStart, nextWindowEnd, isNightSuggestion = false;

  if (stats.currentState === 'asleep') {
    action = 'sleeping';
  } else {
    const projectedEnd = new Date(now.getTime() + adjustedWindow * 60000);
    const closeToNight = expectedNapsLeft <= 1 && minutesBetween(now, nightTarget) < adjustedWindow + 40;

    if (hasRefusal) {
      action = 'refuses_sleep';
    } else if (overtired) {
      action = 'overtired_act_now';
    } else if (hasTiredSign && awake > expectedWindow * 0.5) {
      action = 'signs_now';
    } else if (closeToNight && (napsSoFar >= Math.floor(baseline.expectedNaps) || minutesToNight < 90)) {
      action = 'go_to_night';
      isNightSuggestion = true;
    } else if (awake < adjustedWindow * 0.7) {
      action = 'maintain_window';
    } else if (awake < adjustedWindow) {
      action = 'approaching_window';
    } else if (awake < adjustedWindow * 1.25) {
      action = 'window_open';
    } else {
      action = 'late_window';
    }

    if (!isNightSuggestion) {
      nextWindowStart = new Date((stats.lastWakeTime || now).getTime() + adjustedWindow * 0.85 * 60000);
      nextWindowEnd = new Date((stats.lastWakeTime || now).getTime() + adjustedWindow * 1.15 * 60000);
    }
  }

  // ---- si está durmiendo: hora estimada de despertar ----
  // Ancla la estimación al momento en que se durmió (fijo), no a "ahora":
  // si solo usáramos "ahora + tiempo restante" la hora estimada iría
  // corriéndose para adelante en cada actualización del reloj.
  let predictedWakeStart = null, predictedWakeEnd = null;
  let nextNapAfterWake = null, nextNapAfterWakeNote = null;
  if (stats.currentState === 'asleep') {
    const isNight = stats.currentSleepSubtype === 'night';
    const nightDurationBaseline = clamp(650 - months * 4, 480, 660); // heurística orientativa por edad
    const typicalDuration = isNight
      ? (pattern.individualNightDuration ?? nightDurationBaseline)
      : (pattern.individualNapDuration ?? 45);
    const sleepStart = isNight ? (stats.nightSleepOnset || stats.lastSleepTime || now) : (stats.lastSleepTime || now);
    const typicalWakeTime = new Date(sleepStart.getTime() + typicalDuration * 60000);
    const marginMin = Math.max(15, typicalDuration * 0.25);
    predictedWakeStart = new Date(typicalWakeTime.getTime() - marginMin * 60000);
    predictedWakeEnd = new Date(typicalWakeTime.getTime() + marginMin * 60000);
    if (predictedWakeEnd <= now) {
      // ya durmió más de lo típico: podría despertar en cualquier momento
      predictedWakeStart = now;
      predictedWakeEnd = new Date(now.getTime() + 30 * 60000);
    } else if (predictedWakeStart < now) {
      // ya estamos dentro de la ventana prevista
      predictedWakeStart = now;
    }

    // ---- proyección de la siguiente siesta, después de que despierte de esta ----
    if (!isNight && expectedNapsLeft > 0) {
      const projectedWake = new Date((predictedWakeStart.getTime() + predictedWakeEnd.getTime()) / 2);
      const projWindow = clamp(baseNapWindow, baseline.midWindow * 0.6, baseline.midWindow * 1.4);
      nextNapAfterWake = {
        start: new Date(projectedWake.getTime() + projWindow * 0.85 * 60000),
        end: new Date(projectedWake.getTime() + projWindow * 1.15 * 60000),
      };
    } else if (isNight) {
      nextNapAfterWakeNote = 'Se calcula mañana, después de que se despierte.';
    } else {
      nextNapAfterWakeNote = 'Ya cumplió las siestas esperadas para su edad; probablemente no haga otra hoy.';
    }
  }

  // ---- próxima mamadera: hora y volumen sugeridos (siempre disponible) ----
  const feedInterval = pattern.individualFeedInterval ?? 180;
  const feedBaseTime = stats.lastFeeding ? new Date(stats.lastFeeding.time) : now;
  let nextFeedingTime = new Date(feedBaseTime.getTime() + feedInterval * 60000);
  if (nextFeedingTime < now) nextFeedingTime = new Date(now.getTime() + Math.min(feedInterval, 60) * 60000 * 0.3);
  const avgMl = pattern.individualFeedMl ?? (stats.feedings.length ? stats.totalMl / stats.feedings.length : null);
  const nextFeeding = {
    time: nextFeedingTime,
    volumeMin: avgMl ? Math.round((avgMl * 0.85) / 10) * 10 : null,
    volumeMax: avgMl ? Math.round((avgMl * 1.15) / 10) * 10 : null,
    hasData: avgMl != null,
  };

  // ---- predicción nocturna ----
  let nightBiasMin = learningBias?.nightBiasMinutes || 0;
  const predictedNightStart = new Date(nightTarget.getTime() + nightBiasMin * 60000 - 20 * 60000);
  const predictedNightEnd = new Date(nightTarget.getTime() + nightBiasMin * 60000 + 20 * 60000);

  // ---- confianza ----
  let confidence = 0.28;
  confidence += Math.min(pattern.daysWithData, 10) * 0.045;
  confidence += Math.min(stats.segments.length, 8) * 0.02;
  if (napQualityLabel) confidence += 0.05;
  if (hasTiredSign || hasRefusal) confidence -= 0.05;
  confidence = clamp(confidence, 0.1, 0.95);
  const confidenceLabel = confidence >= 0.72 ? 'alta' : confidence >= 0.45 ? 'media' : 'baja';

  return {
    months, baseline, ratio, baseNapWindow, baseNightWindow,
    adjustedWindow, napAdjustmentFactor, napQualityLabel,
    sleepPressure, overtired, hasTiredSign, hasRefusal,
    action, isNightSuggestion, nextWindowStart, nextWindowEnd,
    predictedWakeStart, predictedWakeEnd, nextFeeding,
    nextNapAfterWake, nextNapAfterWakeNote,
    predictedNightStart, predictedNightEnd, nightTarget,
    expectedNapsLeft, napsSoFar, minutesToNight, confidence, confidenceLabel,
  };
}

/* ======================================================================
   4. ASISTENTE DE LENGUAJE — convierte la decisión en texto humano
   ====================================================================== */

function humanTime(d) { return fmtTime(d); }

function buildReasoning(stats, dec, pattern) {
  const r = [];
  if (stats.currentState === 'asleep') {
    const isNight = stats.currentSleepSubtype === 'night';
    r.push(`Está durmiendo ${isNight ? 'de noche' : 'una siesta'}; la estimación usa ${isNight ? (pattern.individualNightDuration ? 'la duración nocturna promedio registrada' : 'una referencia por edad, todavía sin suficientes noches propias registradas') : (pattern.individualNapDuration ? 'la duración promedio de sus siestas' : 'una duración de referencia, todavía sin suficientes siestas propias')}.`);
    if (isNight && stats.nightWakingsCount > 0) {
      r.push(`Se despertó ${stats.nightWakingsCount} vez${stats.nightWakingsCount === 1 ? '' : 'es'} en el medio de la noche (probablemente para tomas) y volvió a dormirse; el cálculo del inicio del próximo día se ancla al comienzo real de la noche (${humanTime(stats.nightSleepOnset)}), no a la última vez que se durmió.`);
    }
    if (dec.nextNapAfterWake) {
      r.push(`La siguiente siesta se proyecta sumando la ventana de vigilia esperada a partir de la hora estimada de despertar; es una doble estimación (despertar + ventana), así que tiene más margen de error que las demás.`);
    } else if (dec.nextNapAfterWakeNote) {
      r.push(dec.nextNapAfterWakeNote);
    }
    if (pattern.individualFeedInterval) {
      r.push(`El horario de la próxima mamadera se calcula con el intervalo promedio entre tomas de los últimos días (${fmtDurationMin(pattern.individualFeedInterval)}).`);
    } else {
      r.push(`Todavía no hay suficiente historial de mamaderas para calcular un intervalo propio, así que se usa un valor de referencia.`);
    }
    return r;
  }
  if (stats.lastNapDurationMinutes != null) {
    r.push(`La última siesta duró ${fmtDurationMin(stats.lastNapDurationMinutes)}, lo que se considera ${dec.napQualityLabel === 'corta' ? 'corta' : dec.napQualityLabel === 'larga' ? 'larga' : 'dentro de lo habitual'} para su patrón.`);
  }
  if (stats.awakeDurationMinutes != null) {
    r.push(`Lleva despierta ${fmtDurationMin(stats.awakeDurationMinutes)}, sobre una ventana esperada de referencia de ${fmtDurationMin(dec.adjustedWindow)}.`);
  }
  r.push(`Hoy acumuló ${fmtDurationMin(stats.dailyNapSleep)} de sueño diurno en ${stats.napCount} siesta${stats.napCount === 1 ? '' : 's'}.`);
  if (pattern.daysWithData >= 3) {
    r.push(`Se está usando un ${Math.round(blendRatio(pattern.daysWithData).individual * 100)}% de peso del patrón propio del bebé y ${Math.round(blendRatio(pattern.daysWithData).age * 100)}% de referencia por edad (${pattern.daysWithData} día${pattern.daysWithData === 1 ? '' : 's'} de datos).`);
  } else {
    r.push(`Todavía hay pocos días registrados, así que se está usando mayormente la referencia por edad (${dec.baseline.label}).`);
  }
  if (dec.hasTiredSign) r.push('Se registraron señales de sueño en los últimos minutos, lo que adelanta la recomendación por sobre la ventana calculada.');
  if (dec.overtired) r.push('Los indicadores muestran presión de sueño alta: conviene actuar antes de que aparezca el sobrecansancio.');
  if (dec.isNightSuggestion) r.push(`Falta poco para el objetivo nocturno (${humanTime(dec.nightTarget)}) y ya se cumplieron las siestas esperadas para la edad, por lo que conviene orientar hacia la rutina nocturna.`);
  return r;
}

function buildRecommendation(stats, dec, profile) {
  const name = profile.name || 'el bebé';
  switch (dec.action) {
    case 'sleeping': {
      const asleep = fmtDurationMin(stats.asleepDurationMinutes);
      const isNight = stats.currentSleepSubtype === 'night';
      const wakeRange = dec.predictedWakeStart ? `${humanTime(dec.predictedWakeStart)}–${humanTime(dec.predictedWakeEnd)}` : null;
      const feedText = dec.nextFeeding?.hasData
        ? `${isNight ? 'La próxima toma de la noche' : 'La próxima mamadera'}, por su patrón, rondaría las ${humanTime(dec.nextFeeding.time)} con unos ${dec.nextFeeding.volumeMin}–${dec.nextFeeding.volumeMax} ml (orientativo, no es una indicación médica).`
        : `Todavía no hay suficientes mamaderas registradas para sugerir horario y volumen de la próxima.`;
      const wakeText = wakeRange
        ? (isNight
            ? `Calculando con su patrón, su día debería arrancar entre las ${wakeRange}. Si se despierta antes de eso, probablemente sea solo para una toma, no el final de la noche.`
            : `Calculando con su patrón, podría despertarse entre las ${wakeRange}.`)
        : '';
      const napText = dec.nextNapAfterWake
        ? `Después de esta, la siguiente siesta probablemente caiga entre las ${humanTime(dec.nextNapAfterWake.start)} y las ${humanTime(dec.nextNapAfterWake.end)}.`
        : (dec.nextNapAfterWakeNote || '');
      return `Está durmiendo hace ${asleep}. Por ahora no hay nada que hacer más que dejarla descansar. ${wakeText} ${napText} ${feedText}`;
    }
    case 'refuses_sleep':
      return `Registraste que está mostrando sueño pero se resiste a dormirse. Es común: probá bajar estímulos, ambiente tranquilo y en penumbra, y darle unos minutos más sin forzar. Si sigue sin dormirse, no pasa nada — seguimos observando y ajustamos la próxima ventana.`;
    case 'overtired_act_now':
      return `Los números indican que ${name} está acumulando bastante presión de sueño — riesgo de sobrecansancio. Yo empezaría la rutina para dormir ahora mismo, aunque no sea el horario "ideal" calculado: en este punto, antes es mejor que después.`;
    case 'signs_now':
      return `Aunque la ventana calculada todavía no se cumplió del todo, ya está mostrando señales claras de sueño. La ventana es una referencia, no una obligación — yo empezaría a bajar el ritmo ahora.`;
    case 'go_to_night':
      return `Por la hora y las siestas que ya hizo hoy, esto pinta para ser el último tramo antes de la noche. El objetivo nocturno está calculado para alrededor de las ${humanTime(dec.predictedNightStart)}–${humanTime(dec.predictedNightEnd)}. Yo iría orientando la rutina nocturna en vez de sumar otra siesta larga.`;
    case 'maintain_window':
      return `Todavía es temprano dentro de esta ventana de vigilia. Por ahora yo la dejaría jugar tranquila y volvería a mirar esto en un rato.`;
    case 'approaching_window':
      return `Se está acercando el momento. Yo empezaría a bajar el ritmo y observar señales de sueño; si aparecen antes de lo calculado, no hace falta esperar. Ventana estimada: ${dec.nextWindowStart ? `${humanTime(dec.nextWindowStart)}–${humanTime(dec.nextWindowEnd)}` : '—'}.`;
    case 'window_open':
      return `La ventana ideal ya está abierta. Es un buen momento para intentar la siesta si ves señales, entre ${dec.nextWindowStart ? `${humanTime(dec.nextWindowStart)} y ${humanTime(dec.nextWindowEnd)}` : '—'}.`;
    case 'late_window':
      return `Ya se pasó un poco la ventana calculada. No es grave, pero yo no esperaría mucho más para evitar que se pase de cansada — buscá señales y arrancá la rutina en breve.`;
    default:
      return `Estoy analizando el día para darte una recomendación.`;
  }
}

/* ======================================================================
   5. MOTOR COMPLETO — junta las 4 capas y devuelve el estado estructurado
   ====================================================================== */

function runSleepEngine({ profile, todayEvents, historyDays, now, learningBias }) {
  const stats = Math1.dayStats(todayEvents, profile.nightCutoffHour, now);
  const pattern = buildIndividualPattern(historyDays, profile.nightCutoffHour, fmtDateISO(now));
  const dec = decisionEngine({ profile, stats, pattern, now, learningBias });
  const reasoning = buildReasoning(stats, dec, pattern);
  const recommendation = buildRecommendation(stats, dec, profile);

  return {
    currentState: stats.currentState,
    lastWakeTime: stats.lastWakeTime,
    awakeDurationMinutes: stats.awakeDurationMinutes,
    asleepDurationMinutes: stats.asleepDurationMinutes,
    lastNapDurationMinutes: stats.lastNapDurationMinutes,
    sleepPressure: dec.sleepPressure,
    nextNapWindow: dec.nextWindowStart ? { start: dec.nextWindowStart, end: dec.nextWindowEnd } : null,
    predictedWake: dec.predictedWakeStart ? { start: dec.predictedWakeStart, end: dec.predictedWakeEnd } : null,
    nextNapAfterWake: dec.nextNapAfterWake,
    nextNapAfterWakeNote: dec.nextNapAfterWakeNote,
    nextFeeding: dec.nextFeeding,
    predictedNightSleep: { start: dec.predictedNightStart, end: dec.predictedNightEnd },
    confidence: dec.confidence,
    confidenceLabel: dec.confidenceLabel,
    action: dec.action,
    recommendation,
    reasoning,
    stats, dec, pattern,
  };
}

/* ======================================================================
   6. PARSER DE LENGUAJE NATURAL (chat / registro rápido)
   ====================================================================== */

function extractTime(text, now) {
  const m = text.match(/(\d{1,2})[:h](\d{2})/i);
  if (m) {
    const h = clamp(parseInt(m[1], 10), 0, 23);
    const mi = clamp(parseInt(m[2], 10), 0, 59);
    const d = new Date(now);
    d.setHours(h, mi, 0, 0);
    return d;
  }
  const m2 = text.match(/\bahora\b/i);
  if (m2) return new Date(now);
  return null;
}

function extractMl(text) {
  const m = text.match(/(\d{2,4})\s*ml/i);
  return m ? Number(m[1]) : null;
}

const TIRED_KEYWORDS = ['con sueño', 'bosteza', 'bostezando', 'irritable', 'llorando', 'restregando', 'restriega', 'ojos rojos', 'se frota', 'se duerme en brazos', 'quejosa', 'inquieta'];
const REFUSE_KEYWORDS = ['no duerme', 'no quiere dormir', 'no se duerme', 'se resiste'];
const ACTIVE_KEYWORDS = ['muy activa', 'jugando', 'despierta y activa'];

function parseMessage(text, now) {
  const lower = text.toLowerCase();
  const time = extractTime(text, now) || now;

  // pregunta pura
  const isQuestion = /\?|cuánto|cuanto|a qué hora|a que hora|puede hacer|cómo viene|como viene|tomó suficiente|tomo suficiente/i.test(lower) &&
    !/despert|durm|mamadera|toma|biber/i.test(lower);

  if (isQuestion) return { kind: 'question', text };

  if (REFUSE_KEYWORDS.some((k) => lower.includes(k))) {
    return { kind: 'event', event: { type: 'sign', time: time.toISOString(), data: { subtype: 'refuses_sleep', note: text } } };
  }
  if (lower.includes('ml') || /mamadera|tom[oó]|biber[oó]n/i.test(lower)) {
    const ml = extractMl(text);
    return { kind: 'event', event: { type: 'feeding', time: time.toISOString(), data: { ml, note: text } } };
  }
  if (/despert/i.test(lower)) {
    const cry = /llorando|llora/i.test(lower);
    return { kind: 'event', event: { type: 'wake', time: time.toISOString(), data: { note: text, crying: cry } } };
  }
  if (/durm|duerme|se durmió|se duerme/i.test(lower) && !REFUSE_KEYWORDS.some((k) => lower.includes(k))) {
    return { kind: 'event', event: { type: 'sleep', time: time.toISOString(), data: { note: text } } };
  }
  if (TIRED_KEYWORDS.some((k) => lower.includes(k))) {
    return { kind: 'event', event: { type: 'sign', time: time.toISOString(), data: { subtype: 'tired', note: text } } };
  }
  if (ACTIVE_KEYWORDS.some((k) => lower.includes(k))) {
    return { kind: 'event', event: { type: 'sign', time: time.toISOString(), data: { subtype: 'active', note: text } } };
  }
  return { kind: 'unknown', text };
}

// Parser para IMPORTAR historial pegado como texto (una línea por evento).
// Reutiliza las mismas palabras clave del chat, pero además entiende una
// fecha opcional al principio de la línea (dd/mm o dd/mm/aaaa) para poder
// pegar varios días de una sola vez. Si una línea es solo una fecha, cambia
// el "día actual" para las líneas siguientes.
function parseImportLine(line, currentDateISO) {
  let rest = line.trim();
  if (!rest) return { kind: 'empty' };

  let dateISO = currentDateISO;
  const dateMatch = rest.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s*[:\-,]?\s*/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date(currentDateISO + 'T12:00:00').getFullYear();
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      dateISO = `${year}-${pad2(month)}-${pad2(day)}`;
      rest = rest.slice(dateMatch[0].length).trim();
    }
  }
  if (!rest) return { kind: 'date-switch', dateISO };

  const lower = rest.toLowerCase();
  const timeMatch = rest.match(/(\d{1,2})[:h](\d{2})/i);
  if (!timeMatch) return { kind: 'skip', line };

  const h = clamp(parseInt(timeMatch[1], 10), 0, 23);
  const mi = clamp(parseInt(timeMatch[2], 10), 0, 59);
  const time = new Date(dateISO + 'T00:00:00');
  time.setHours(h, mi, 0, 0);

  let event = null;
  if (REFUSE_KEYWORDS.some((k) => lower.includes(k))) {
    event = { type: 'sign', time: time.toISOString(), data: { subtype: 'refuses_sleep', note: rest } };
  } else if (lower.includes('ml') || /mamadera|tom[oó]|biber[oó]n/i.test(lower)) {
    event = { type: 'feeding', time: time.toISOString(), data: { ml: extractMl(rest), note: rest } };
  } else if (/despert/i.test(lower)) {
    event = { type: 'wake', time: time.toISOString(), data: { note: rest, crying: /llorando|llora/i.test(lower) } };
  } else if (/durm|duerme/i.test(lower)) {
    event = { type: 'sleep', time: time.toISOString(), data: { note: rest } };
  } else if (TIRED_KEYWORDS.some((k) => lower.includes(k))) {
    event = { type: 'sign', time: time.toISOString(), data: { subtype: 'tired', note: rest } };
  } else if (ACTIVE_KEYWORDS.some((k) => lower.includes(k))) {
    event = { type: 'sign', time: time.toISOString(), data: { subtype: 'active', note: rest } };
  }

  if (!event) return { kind: 'skip', line };
  return { kind: 'event', event, dateISO };
}

function parseImportText(text, defaultDateISO) {
  const lines = text.split('\n');
  let currentDateISO = defaultDateISO;
  const events = [];
  const skipped = [];
  for (const raw of lines) {
    const r = parseImportLine(raw, currentDateISO);
    if (r.kind === 'date-switch') currentDateISO = r.dateISO;
    else if (r.kind === 'event') { currentDateISO = r.dateISO; events.push(r.event); }
    else if (r.kind === 'skip') skipped.push(raw.trim());
  }
  return { events, skipped };
}

function answerQuestion(text, engineOut, profile) {
  const lower = text.toLowerCase();
  const s = engineOut.stats, d = engineOut.dec;
  if (/cuánto lleva despierta|cuanto lleva despierta/i.test(lower)) {
    if (s.currentState !== 'awake') return 'En este momento está durmiendo, no despierta.';
    return `Lleva despierta ${fmtDurationMin(s.awakeDurationMinutes)}, desde las ${humanTime(s.lastWakeTime)}.`;
  }
  if (/a qué hora debería dormir|a que hora deberia dormir|a qué hora duerme|a que hora duerme/i.test(lower)) {
    if (engineOut.nextNapWindow) return `Calculando con lo registrado hoy, una ventana razonable sería entre las ${humanTime(engineOut.nextNapWindow.start)} y las ${humanTime(engineOut.nextNapWindow.end)}.`;
    return `Para la noche, el rango estimado es ${humanTime(engineOut.predictedNightSleep.start)}–${humanTime(engineOut.predictedNightSleep.end)}.`;
  }
  if (/puede hacer otra siesta|otra siesta/i.test(lower)) {
    if (d.expectedNapsLeft <= 0) return `Ya cumplió el número de siestas esperado para su edad (${d.baseline.label}: ~${Math.round(d.baseline.expectedNaps)}). Todavía puede hacer una siesta corta si lo necesita, pero cuidado con que no le quite presión de sueño a la noche.`;
    return `Sí, por su edad y por cómo viene el día, todavía se espera ${d.expectedNapsLeft > 1 ? 'más de una siesta' : 'al menos una siesta más'} hoy.`;
  }
  if (/cómo viene el día|como viene el dia/i.test(lower)) {
    return `Hoy acumuló ${fmtDurationMin(s.dailyNapSleep)} de sueño diurno en ${s.napCount} siesta${s.napCount === 1 ? '' : 's'}, y ${s.feedings.length} mamadera${s.feedings.length === 1 ? '' : 's'} por un total de ${s.totalMl || 0} ml. ${engineOut.recommendation}`;
  }
  if (/tomó suficiente|tomo suficiente/i.test(lower)) {
    return `Hoy lleva ${s.totalMl || 0} ml en ${s.feedings.length} toma${s.feedings.length === 1 ? '' : 's'}. No puedo decirte si es "suficiente" — eso depende de indicaciones de su pediatra — pero puedo mostrarte cómo se compara con otros días si querés.`;
  }
  return engineOut.recommendation;
}

/* ======================================================================
   7. ESTILOS
   ====================================================================== */

const Styles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap');

    .sa-root {
      --bg-deep: #1B2140; --bg-deep2: #2B2F5C; --bg-deep3: #363A6B;
      --surface: #FBF8F1; --surface-soft: #F1EBDB; --surface-line: #E3DAC2;
      --ink: #241F3D; --ink-soft: #6E6785; --ink-faint: #A39CB8;
      --gold: #E3A94D; --gold-deep: #C6862B;
      --sage: #7C9885; --sage-deep: #5C7863;
      --alert: #A6503F; --alert-soft: #F2DCD4;
      --star: #F5EFD9;
      --app-max-width: 480px;
      font-family: 'Inter', sans-serif;
      color: var(--ink);
      background: linear-gradient(180deg, var(--bg-deep) 0%, var(--bg-deep2) 45%, var(--bg-deep3) 100%);
      min-height: 100vh;
      width: 100%;
      max-width: var(--app-max-width);
      margin: 0 auto;
      position: relative;
      padding-bottom: 84px;
      box-sizing: border-box;
      transition: max-width 0.15s ease;
    }
    .sa-root * { box-sizing: border-box; }
    .sa-serif { font-family: 'Fraunces', serif; }

    /* Tablet: la app usa más ancho pero conserva proporciones legibles */
    @media (min-width: 640px) {
      .sa-root { --app-max-width: 600px; }
      .sa-grid2 { grid-template-columns: repeat(3, 1fr); }
    }
    /* Escritorio: layout más ancho, tarjetas en más columnas */
    @media (min-width: 1024px) {
      .sa-root { --app-max-width: 760px; }
      .sa-grid2 { grid-template-columns: repeat(4, 1fr); }
      .sa-hero-big { font-size: 46px; }
    }
    @media (min-width: 640px) {
      .sa-header { padding: 32px 28px 24px; }
      .sa-content { padding: 0 24px; }
    }

    .sa-stars {
      position: absolute; top: 0; left: 0; right: 0; height: 210px;
      overflow: hidden; pointer-events: none;
    }
    .sa-stars span {
      position: absolute; width: 3px; height: 3px; background: var(--star);
      border-radius: 50%; opacity: 0.55;
    }

    .sa-header { position: relative; padding: 28px 20px 20px; color: var(--star); z-index: 1; }
    .sa-header-top { display: flex; align-items: center; justify-content: space-between; }
    .sa-brand { display: flex; align-items: center; gap: 10px; }
    .sa-brand-icon {
      width: 38px; height: 38px; border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, var(--gold), var(--gold-deep));
      display: flex; align-items: center; justify-content: center; color: #2B1E08;
      flex-shrink: 0;
    }
    .sa-brand-name { font-family: 'Fraunces', serif; font-size: 19px; font-weight: 600; letter-spacing: 0.2px; }
    .sa-brand-sub { font-size: 12px; color: #C9C4E0; margin-top: 1px; }

    .sa-content { position: relative; z-index: 1; padding: 0 16px; }

    .sa-card {
      background: var(--surface); border-radius: 20px; padding: 20px;
      margin-bottom: 14px; box-shadow: 0 8px 24px rgba(15,12,40,0.18);
    }
    .sa-card-soft { background: var(--surface-soft); }

    .sa-hero { padding: 24px 20px; }
    .sa-hero-state { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .sa-state-badge {
      display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
      font-weight: 600; padding: 5px 12px; border-radius: 20px;
      background: var(--surface-soft); color: var(--ink-soft);
    }
    .sa-hero-title { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 600; line-height: 1.2; margin: 8px 0 4px; }
    .sa-hero-meta { font-size: 14px; color: var(--ink-soft); }
    .sa-hero-big { font-family: 'Fraunces', serif; font-size: 40px; font-weight: 600; margin: 10px 0 2px; color: var(--gold-deep); }
    .sa-hero-big-label { font-size: 12px; text-transform: none; color: var(--ink-soft); letter-spacing: 0.2px; }

    .sa-sleep-predictions { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
    .sa-sleep-pred-item {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      background: var(--surface-soft); border-radius: 12px; padding: 9px 12px;
    }
    .sa-sleep-pred-label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink-soft); font-weight: 600; }
    .sa-sleep-pred-value { font-size: 13px; color: var(--ink); font-weight: 700; text-align: right; }

    .sa-reco-box {
      margin-top: 16px; padding: 16px; border-radius: 14px;
      background: linear-gradient(135deg, #FFF6E4, #FBEBCF);
      border: 1px solid #F0DBA8;
    }
    .sa-reco-label { font-size: 12px; font-weight: 700; color: var(--gold-deep); letter-spacing: 0.3px; margin-bottom: 6px; display:flex; align-items:center; gap:6px; }
    .sa-reco-text { font-size: 15px; line-height: 1.5; color: var(--ink); }

    .sa-confidence { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; margin-top: 10px; color: var(--ink-soft); }
    .sa-dot { width: 8px; height: 8px; border-radius: 50%; }
    .sa-dot-alta { background: var(--sage-deep); }
    .sa-dot-media { background: var(--gold); }
    .sa-dot-baja { background: var(--alert); }

    .sa-why-btn {
      margin-top: 10px; background: none; border: none; color: var(--ink-soft);
      font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 4px;
      cursor: pointer; padding: 0;
    }
    .sa-why-box { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--surface-line); }
    .sa-why-item { font-size: 13px; color: var(--ink-soft); margin-bottom: 6px; line-height: 1.45; display:flex; gap:8px;}
    .sa-why-item::before { content:'—'; flex-shrink:0; }

    .sa-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .sa-mini-card { background: var(--surface); border-radius: 16px; padding: 16px; box-shadow: 0 6px 16px rgba(15,12,40,0.14); }
    .sa-mini-icon { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; margin-bottom: 10px; }
    .sa-mini-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink-faint); font-weight: 700; margin-bottom: 3px; }
    .sa-mini-value { font-family: 'Fraunces', serif; font-size: 18px; font-weight: 600; }
    .sa-mini-sub { font-size: 12px; color: var(--ink-soft); margin-top: 2px; }

    .sa-section-title { font-family: 'Fraunces', serif; font-size: 17px; font-weight: 600; margin: 22px 0 10px; color: var(--star); display: flex; align-items: center; gap: 8px; }

    .sa-quick-row { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 6px; }
    .sa-quick-btn {
      flex-shrink: 0; display: flex; align-items: center; gap: 6px;
      background: var(--surface); border: none; border-radius: 24px; padding: 10px 15px;
      font-size: 13px; font-weight: 600; color: var(--ink); cursor: pointer;
      box-shadow: 0 4px 10px rgba(15,12,40,0.16);
    }
    .sa-quick-btn:active { transform: scale(0.97); }

    .sa-input-row { display: flex; gap: 8px; margin-top: 10px; }
    .sa-text-input {
      flex: 1; border-radius: 14px; border: 1px solid var(--surface-line);
      padding: 12px 14px; font-size: 14px; font-family: 'Inter', sans-serif; background: var(--surface);
      color: var(--ink);
    }
    .sa-text-input:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
    .sa-send-btn {
      width: 46px; height: 46px; border-radius: 14px; border: none;
      background: var(--gold-deep); color: white; display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0;
    }
    .sa-send-btn:disabled { opacity: 0.5; }

    .sa-timeline { display: flex; flex-direction: column; }
    .sa-tl-item { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--surface-line); }
    .sa-tl-item:last-child { border-bottom: none; }
    .sa-tl-time { font-family: 'Fraunces', serif; font-weight: 600; font-size: 14px; width: 48px; flex-shrink: 0; color: var(--ink); }
    .sa-tl-icon { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .sa-tl-body { flex: 1; min-width: 0; }
    .sa-tl-label { font-size: 13.5px; font-weight: 600; }
    .sa-tl-sub { font-size: 12px; color: var(--ink-soft); margin-top: 1px; }
    .sa-tl-actions { display: flex; gap: 6px; }
    .sa-tl-actions button { border: none; background: none; color: var(--ink-faint); cursor: pointer; padding: 3px; }

    .sa-tabbar {
      position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
      width: 100%; max-width: var(--app-max-width, 480px); background: rgba(27,33,64,0.96); backdrop-filter: blur(8px);
      display: flex; justify-content: space-around; padding: 10px 6px 14px; z-index: 10;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .sa-tab { display: flex; flex-direction: column; align-items: center; gap: 3px; background: none; border: none; color: #8781A6; cursor: pointer; font-size: 10.5px; font-weight: 600; padding: 4px 10px; }
    .sa-tab.active { color: var(--gold); }

    .sa-chat-wrap { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 12px; }
    .sa-msg { max-width: 82%; padding: 11px 14px; border-radius: 16px; font-size: 14px; line-height: 1.45; }
    .sa-msg-user { align-self: flex-end; background: var(--gold); color: #2B1E08; border-bottom-right-radius: 4px; }
    .sa-msg-assistant { align-self: flex-start; background: var(--surface); color: var(--ink); border-bottom-left-radius: 4px; box-shadow: 0 4px 10px rgba(15,12,40,0.12); }

    .sa-empty { text-align: center; padding: 40px 20px; color: #C9C4E0; }

    .sa-form-label { font-size: 13px; font-weight: 600; color: var(--ink-soft); margin: 14px 0 6px; display: block; }
    .sa-form-input {
      width: 100%; border-radius: 12px; border: 1px solid var(--surface-line); padding: 12px 14px;
      font-size: 14px; font-family: 'Inter', sans-serif; background: white; color: var(--ink);
    }
    .sa-btn-primary {
      width: 100%; padding: 14px; border-radius: 14px; border: none; background: var(--gold-deep);
      color: white; font-weight: 700; font-size: 15px; cursor: pointer; margin-top: 18px;
    }
    .sa-btn-secondary {
      width: 100%; padding: 12px; border-radius: 14px; border: 1px solid var(--surface-line); background: transparent;
      color: var(--ink-soft); font-weight: 600; font-size: 13px; cursor: pointer; margin-top: 8px;
    }

    .sa-modal-backdrop { position: fixed; inset: 0; background: rgba(20,16,45,0.55); display: flex; align-items: flex-end; justify-content: center; z-index: 50; }
    .sa-modal { background: var(--surface); width: 100%; max-width: 480px; border-radius: 24px 24px 0 0; padding: 22px 20px 30px; max-height: 85vh; overflow-y: auto; }

    .sa-day-picker { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 8px; margin-bottom: 6px; }
    .sa-day-chip { flex-shrink: 0; padding: 8px 14px; border-radius: 14px; background: var(--surface); font-size: 12.5px; font-weight: 600; color: var(--ink-soft); cursor: pointer; border: 1px solid transparent; }
    .sa-day-chip.active { background: var(--gold); color: #2B1E08; }

    .sa-stat-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--surface-line); font-size: 13.5px; }
    .sa-stat-row:last-child { border-bottom: none; }
    .sa-stat-row span:first-child { color: var(--ink-soft); }
    .sa-stat-row span:last-child { font-weight: 600; }

    .sa-disclaimer { font-size: 11.5px; color: var(--ink-faint); text-align: center; padding: 18px 24px 4px; line-height: 1.5; }

    .sa-spin { animation: sa-spin-anim 1s linear infinite; }
    @keyframes sa-spin-anim { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  `}</style>
);

/* ======================================================================
   8. COMPONENTES DE UI
   ====================================================================== */

function StarField() {
  const stars = useMemo(() => Array.from({ length: 22 }, () => ({
    top: Math.random() * 100, left: Math.random() * 100, delay: Math.random() * 3,
  })), []);
  return (
    <div className="sa-stars">
      {stars.map((s, i) => (
        <span key={i} style={{ top: `${s.top}%`, left: `${s.left}%` }} />
      ))}
    </div>
  );
}

function ConfidenceBadge({ label, value }) {
  return (
    <div className="sa-confidence">
      <span className={`sa-dot sa-dot-${label}`} />
      Confianza {label} ({Math.round(value * 100)}%)
    </div>
  );
}

function WhatToDoNow({ engineOut, profile, onOpenChat }) {
  const [showWhy, setShowWhy] = useState(false);
  const s = engineOut.stats;
  const isAwake = s.currentState === 'awake';

  return (
    <div className="sa-card sa-hero">
      <div className="sa-hero-state">
        <span className="sa-state-badge">
          {isAwake ? <Sun size={14} /> : <Moon size={14} />}
          {isAwake ? 'Despierta' : 'Durmiendo'}
        </span>
      </div>
      <div className="sa-hero-title">¿Qué hacer ahora?</div>
      {isAwake ? (
        <>
          <div className="sa-hero-meta">Se despertó a las {s.lastWakeTime ? humanTime(s.lastWakeTime) : '—'}</div>
          <div className="sa-hero-big">{fmtDurationMin(s.awakeDurationMinutes)}</div>
          <div className="sa-hero-big-label">lleva despierta</div>
        </>
      ) : (
        <>
          <div className="sa-hero-meta">Se durmió a las {s.lastSleepTime ? humanTime(s.lastSleepTime) : '—'}</div>
          <div className="sa-hero-big">{fmtDurationMin(s.asleepDurationMinutes)}</div>
          <div className="sa-hero-big-label">durmiendo</div>
          <div className="sa-sleep-predictions">
            <div className="sa-sleep-pred-item">
              <span className="sa-sleep-pred-label"><Sun size={12} /> {s.currentSleepSubtype === 'night' ? 'Inicio del próximo día' : 'Despertar estimado'}</span>
              <span className="sa-sleep-pred-value">{engineOut.predictedWake ? `${humanTime(engineOut.predictedWake.start)}–${humanTime(engineOut.predictedWake.end)}` : '—'}</span>
            </div>
            {s.currentSleepSubtype !== 'night' && (
              <div className="sa-sleep-pred-item">
                <span className="sa-sleep-pred-label"><Moon size={12} /> Próxima siesta</span>
                <span className="sa-sleep-pred-value">
                  {engineOut.nextNapAfterWake
                    ? `${humanTime(engineOut.nextNapAfterWake.start)}–${humanTime(engineOut.nextNapAfterWake.end)}`
                    : (engineOut.nextNapAfterWakeNote || '—')}
                </span>
              </div>
            )}
            <div className="sa-sleep-pred-item">
              <span className="sa-sleep-pred-label"><Milk size={12} /> {s.currentSleepSubtype === 'night' ? 'Próxima toma nocturna' : 'Próxima mamadera'}</span>
              <span className="sa-sleep-pred-value">
                {humanTime(engineOut.nextFeeding.time)}
                {engineOut.nextFeeding.hasData ? ` · ${engineOut.nextFeeding.volumeMin}–${engineOut.nextFeeding.volumeMax} ml` : ' (sin datos de volumen aún)'}
              </span>
            </div>
          </div>
        </>
      )}

      <div className="sa-reco-box">
        <div className="sa-reco-label"><Sparkles size={13} /> RECOMENDACIÓN</div>
        <div className="sa-reco-text">{engineOut.recommendation}</div>
        <ConfidenceBadge label={engineOut.confidenceLabel} value={engineOut.confidence} />
        <button className="sa-why-btn" onClick={() => setShowWhy((v) => !v)}>
          {showWhy ? <ChevronDown size={14} /> : <ChevronRight size={14} />} ¿Por qué esta recomendación?
        </button>
        {showWhy && (
          <div className="sa-why-box">
            {engineOut.reasoning.map((r, i) => <div className="sa-why-item" key={i}>{r}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryGrid({ engineOut }) {
  const { stats, nextNapWindow, predictedWake, predictedNightSleep, nextFeeding, dec } = engineOut;
  const isAsleep = stats.currentState === 'asleep';
  const isNightSleep = isAsleep && stats.currentSleepSubtype === 'night';
  return (
    <div className="sa-grid2">
      <div className="sa-mini-card">
        <div className="sa-mini-icon" style={{ background: '#F1EBDB' }}>{isAsleep ? <Sun size={16} color="#C6862B" /> : <Moon size={16} color="#C6862B" />}</div>
        <div className="sa-mini-label">{isNightSleep ? 'Inicio del próximo día' : (isAsleep ? 'Despertar estimado' : 'Próximo sueño')}</div>
        <div className="sa-mini-value">
          {isAsleep
            ? (predictedWake ? `${humanTime(predictedWake.start)}–${humanTime(predictedWake.end)}` : '—')
            : (nextNapWindow ? `${humanTime(nextNapWindow.start)}–${humanTime(nextNapWindow.end)}` : (dec.isNightSuggestion ? 'Rutina nocturna' : '—'))}
        </div>
        <div className="sa-mini-sub">{isAsleep ? (isNightSleep ? 'Puede haber tomas antes de esto' : 'Siesta en curso') : (dec.napQualityLabel ? `Última siesta: ${dec.napQualityLabel}` : 'Estimado del día')}</div>
      </div>
      <div className="sa-mini-card">
        <div className="sa-mini-icon" style={{ background: '#E7EEE9' }}><Moon size={16} color="#5C7863" /></div>
        <div className="sa-mini-label">Noche</div>
        <div className="sa-mini-value">{humanTime(predictedNightSleep.start)}–{humanTime(predictedNightSleep.end)}</div>
        <div className="sa-mini-sub">Objetivo: {humanTime(dec.nightTarget)}</div>
      </div>
      <div className="sa-mini-card">
        <div className="sa-mini-icon" style={{ background: '#F3E7E2' }}><Milk size={16} color="#A6503F" /></div>
        <div className="sa-mini-label">{isNightSleep ? 'Próxima toma nocturna' : 'Próxima mamadera'}</div>
        <div className="sa-mini-value">{humanTime(nextFeeding.time)}</div>
        <div className="sa-mini-sub">{nextFeeding.hasData ? `${nextFeeding.volumeMin}–${nextFeeding.volumeMax} ml aprox.` : 'Sin datos de volumen aún'}</div>
      </div>
      <div className="sa-mini-card">
        <div className="sa-mini-icon" style={{ background: '#EAE7F3' }}><TrendingUp size={16} color="#5C5589" /></div>
        <div className="sa-mini-label">Sueño hoy</div>
        <div className="sa-mini-value">{fmtDurationMin(stats.totalDaySleep)}</div>
        <div className="sa-mini-sub">{stats.napCount} siesta{stats.napCount === 1 ? '' : 's'} · {fmtDurationMin(stats.dailyNapSleep)} diurno</div>
      </div>
    </div>
  );
}

const QUICK_ACTIONS = [
  { key: 'wake', label: 'Se despertó', icon: Sun },
  { key: 'sleep', label: 'Se durmió', icon: Moon },
  { key: 'feeding', label: '+ Mamadera', icon: Milk },
  { key: 'sign', label: '+ Señal de sueño', icon: Sparkles },
];

function QuickLog({ onOpenEventModal, onOpenFeedingModal, onOpenSignModal }) {
  return (
    <div className="sa-quick-row">
      {QUICK_ACTIONS.map((a) => {
        const Icon = a.icon;
        return (
          <button key={a.key} className="sa-quick-btn" onClick={() => {
            if (a.key === 'feeding') onOpenFeedingModal();
            else if (a.key === 'sign') onOpenSignModal();
            else onOpenEventModal(a.key);
          }}>
            <Icon size={15} /> {a.label}
          </button>
        );
      })}
    </div>
  );
}

const EVENT_META = {
  wake: { icon: Sun, bg: '#FBEBCF', color: '#C6862B', label: 'Despertó' },
  sleep: { icon: Moon, bg: '#E3E6F5', color: '#4D5599', label: 'Se durmió' },
  feeding: { icon: Milk, bg: '#F3E7E2', color: '#A6503F', label: 'Mamadera' },
  sign: { icon: Sparkles, bg: '#EAE7F3', color: '#5C5589', label: 'Señal' },
};

function TimelineList({ events, onEdit, onDelete }) {
  const sorted = [...events].sort((a, b) => new Date(a.time) - new Date(b.time));
  if (sorted.length === 0) return <div className="sa-empty" style={{ color: 'var(--ink-soft)', padding: '20px 0' }}>Sin eventos registrados todavía.</div>;
  return (
    <div className="sa-timeline">
      {sorted.map((ev) => {
        const meta = EVENT_META[ev.type];
        const Icon = meta.icon;
        let sub = ev.data?.note || '';
        if (ev.type === 'feeding' && ev.data?.ml) sub = `${ev.data.ml} ml`;
        return (
          <div className="sa-tl-item" key={ev.id}>
            <div className="sa-tl-time">{fmtTime(new Date(ev.time))}</div>
            <div className="sa-tl-icon" style={{ background: meta.bg }}><Icon size={13} color={meta.color} /></div>
            <div className="sa-tl-body">
              <div className="sa-tl-label">{meta.label}{ev.data?.subtype === 'refuses_sleep' ? ' — se resiste' : ''}</div>
              {sub && <div className="sa-tl-sub">{sub}</div>}
            </div>
            <div className="sa-tl-actions">
              <button onClick={() => onEdit(ev)}><Edit2 size={13} /></button>
              <button onClick={() => onDelete(ev)}><Trash2 size={13} /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const DEMO_EVENTS = [
  { type: 'wake', hm: '13:30' },
  { type: 'sleep', hm: '16:07' },
  { type: 'wake', hm: '16:50' },
  { type: 'feeding', hm: '17:20', ml: 150 },
  { type: 'sleep', hm: '20:30' },
  { type: 'wake', hm: '21:50' },
  { type: 'sleep', hm: '00:45' },
];

function HomeScreen({ engineOut, profile, todayEvents, onOpenEventModal, onOpenFeedingModal, onOpenSignModal, onEditEvent, onDeleteEvent, onAddDemoEvent, demoStep }) {
  return (
    <>
      <WhatToDoNow engineOut={engineOut} profile={profile} />
      <SummaryGrid engineOut={engineOut} />
      <div className="sa-section-title"><Plus size={16} /> Registrar rápido</div>
      <QuickLog onOpenEventModal={onOpenEventModal} onOpenFeedingModal={onOpenFeedingModal} onOpenSignModal={onOpenSignModal} />
      <div className="sa-section-title"><CalendarDays size={16} /> Hoy</div>
      <div className="sa-card">
        <TimelineList events={todayEvents} onEdit={onEditEvent} onDelete={onDeleteEvent} />
      </div>
      {todayEvents.length === 0 && demoStep < DEMO_EVENTS.length && (
        <button className="sa-btn-secondary" onClick={onAddDemoEvent}>
          Probar con un día de ejemplo, evento por evento ({demoStep}/{DEMO_EVENTS.length})
        </button>
      )}
      {todayEvents.length > 0 && demoStep > 0 && demoStep < DEMO_EVENTS.length && (
        <button className="sa-btn-secondary" onClick={onAddDemoEvent}>
          Siguiente evento del ejemplo → ({demoStep}/{DEMO_EVENTS.length})
        </button>
      )}
    </>
  );
}

function ChatScreen({ messages, onSend, engineOut }) {
  const [text, setText] = useState('');
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const handleSend = () => {
    if (!text.trim()) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <div className="sa-card" style={{ display: 'flex', flexDirection: 'column', minHeight: '60vh' }}>
      <div className="sa-chat-wrap" style={{ flex: 1 }}>
        {messages.length === 0 && (
          <div className="sa-empty" style={{ color: 'var(--ink-soft)' }}>
            Contame qué acaba de pasar — por ejemplo "se despertó 16:50" o "tomó mamadera 150 ml" — o preguntame algo como "¿cuánto lleva despierta?".
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`sa-msg sa-msg-${m.role}`}>{m.text}</div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="sa-input-row">
        <input
          className="sa-text-input"
          placeholder="Escribí un mensaje..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
        />
        <button className="sa-send-btn" onClick={handleSend} disabled={!text.trim()}><Send size={17} /></button>
      </div>
    </div>
  );
}

function HistoryScreen({ allDays, selectedDate, onSelectDate, events, profile, nightCutoffHour, onEditEvent, onDeleteEvent, onOpenImport }) {
  return (
    <>
      <div className="sa-section-title"><CalendarDays size={16} /> Historial</div>
      <div className="sa-day-picker">
        {allDays.map((d) => (
          <div key={d} className={`sa-day-chip ${d === selectedDate ? 'active' : ''}`} onClick={() => onSelectDate(d)}>
            {new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
          </div>
        ))}
      </div>
      <div className="sa-card">
        <div style={{ fontWeight: 600, marginBottom: 10, textTransform: 'capitalize', fontSize: 14 }}>{fmtDateHuman(selectedDate)}</div>
        <TimelineList events={events} onEdit={onEditEvent} onDelete={onDeleteEvent} />
      </div>
      <button className="sa-btn-secondary" onClick={onOpenImport}>Importar historial (pegar texto)</button>
    </>
  );
}

function StatsScreen({ allDaysData, profile }) {
  const days = Object.entries(allDaysData).sort((a, b) => new Date(b[0]) - new Date(a[0])).slice(0, 14);
  const withStats = days.map(([date, events]) => {
    const st = Math1.dayStats(events, profile.nightCutoffHour, new Date(date + 'T23:59:00'));
    return { date, st };
  });
  const last7 = withStats.slice(0, 7);
  const avg = (arr, sel) => { const v = arr.map(sel).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  return (
    <>
      <div className="sa-section-title"><BarChart3 size={16} /> Estadísticas (últimos 7 días)</div>
      <div className="sa-card">
        <div className="sa-stat-row"><span>Sueño total promedio</span><span>{fmtDurationMin(avg(last7, (d) => d.st.totalDaySleep))}</span></div>
        <div className="sa-stat-row"><span>Sueño diurno promedio</span><span>{fmtDurationMin(avg(last7, (d) => d.st.dailyNapSleep))}</span></div>
        <div className="sa-stat-row"><span>Sueño nocturno promedio</span><span>{fmtDurationMin(avg(last7, (d) => d.st.nightSleep))}</span></div>
        <div className="sa-stat-row"><span>Siestas por día (prom.)</span><span>{avg(last7, (d) => d.st.napCount)?.toFixed(1) ?? '—'}</span></div>
        <div className="sa-stat-row"><span>Duración promedio de siesta</span><span>{fmtDurationMin(avg(last7, (d) => d.st.avgNapDuration))}</span></div>
        <div className="sa-stat-row"><span>Mamaderas por día (prom.)</span><span>{avg(last7, (d) => d.st.feedings.length)?.toFixed(1) ?? '—'}</span></div>
        <div className="sa-stat-row"><span>ml diarios promedio</span><span>{Math.round(avg(last7, (d) => d.st.totalMl) || 0)} ml</span></div>
        <div className="sa-stat-row"><span>Intervalo promedio entre mamaderas</span><span>{fmtDurationMin(avg(last7, (d) => d.st.avgFeedInterval))}</span></div>
      </div>
      <div className="sa-section-title"><TrendingUp size={16} /> Tendencia diaria (sueño total)</div>
      <div className="sa-card">
        {withStats.slice().reverse().map(({ date, st }) => (
          <div className="sa-stat-row" key={date}>
            <span>{new Date(date + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span>
            <span>{fmtDurationMin(st.totalDaySleep)}</span>
          </div>
        ))}
        {withStats.length === 0 && <div className="sa-empty" style={{ color: 'var(--ink-soft)', padding: 10 }}>Todavía no hay suficientes días registrados.</div>}
      </div>
    </>
  );
}

/* ---- Modales ---- */

const PROFILE_COLORS = ['#E3A94D', '#7C9885', '#5C7A9E', '#A6503F', '#9B7FB8', '#C97B9B'];

function DailyCheckInModal({ now, babyName, onFinish, onSkip }) {
  const [step, setStep] = useState(1);
  const [wakeTime, setWakeTime] = useState(fmtTime(now));
  const [naps, setNaps] = useState([{ start: '', end: '' }]);

  const setWakeOffset = (mins) => setWakeTime(fmtTime(new Date(now.getTime() - mins * 60000)));

  const updateNap = (i, field, value) => {
    setNaps((prev) => prev.map((n, idx) => (idx === i ? { ...n, [field]: value } : n)));
  };
  const addNapRow = () => setNaps((prev) => (prev.length >= 4 ? prev : [...prev, { start: '', end: '' }]));
  const removeNapRow = (i) => setNaps((prev) => prev.filter((_, idx) => idx !== i));

  const finishWithNaps = () => {
    const validNaps = naps.filter((n) => n.start);
    onFinish(wakeTime, validNaps);
  };
  const finishNoNaps = () => onFinish(wakeTime, []);

  return (
    <div className="sa-modal-backdrop">
      <div className="sa-modal">
        {step === 1 && (
          <>
            <div className="sa-hero-title" style={{ color: 'var(--ink)', fontSize: 20 }}>¿Cómo viene el día{babyName ? ` de ${babyName}` : ''}?</div>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>Empecemos por lo básico: ¿a qué hora se despertó hoy?</div>
            <div className="sa-quick-row" style={{ marginTop: 14 }}>
              {TIME_OFFSETS.map((o) => (
                <button key={o.label} className="sa-quick-btn" onClick={() => setWakeOffset(o.mins)}>{o.label}</button>
              ))}
            </div>
            <label className="sa-form-label">O la hora exacta</label>
            <input className="sa-form-input" type="time" value={wakeTime} onChange={(e) => setWakeTime(e.target.value)} />
            <button className="sa-btn-primary" onClick={() => setStep(2)}>Continuar</button>
            <button className="sa-btn-secondary" onClick={onSkip}>Prefiero cargarlo manualmente</button>
          </>
        )}
        {step === 2 && (
          <>
            <div className="sa-hero-title" style={{ color: 'var(--ink)', fontSize: 20 }}>¿Ya hizo alguna siesta hoy?</div>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>Se despertó a las {wakeTime}. Si ya durmió alguna siesta antes de ahora, contámelo para arrancar con el día completo.</div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button className="sa-btn-primary" style={{ marginTop: 0 }} onClick={() => setStep(3)}>Sí, ya durmió</button>
              <button className="sa-btn-secondary" style={{ marginTop: 0 }} onClick={finishNoNaps}>No, todavía no</button>
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <div className="sa-hero-title" style={{ color: 'var(--ink)', fontSize: 20 }}>Contame esas siestas</div>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>Hora en que se durmió y en que se despertó. Si todavía sigue durmiendo esa siesta, dejá la hora de despertar vacía.</div>
            {naps.map((n, i) => (
              <div key={i} style={{ marginTop: 14, padding: 12, background: 'var(--surface-soft)', borderRadius: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-soft)' }}>Siesta {i + 1}</span>
                  {naps.length > 1 && <button onClick={() => removeNapRow(i)} style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer' }}><Trash2 size={14} /></button>}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label className="sa-form-label" style={{ marginTop: 0 }}>Se durmió</label>
                    <input className="sa-form-input" type="time" value={n.start} onChange={(e) => updateNap(i, 'start', e.target.value)} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="sa-form-label" style={{ marginTop: 0 }}>Se despertó</label>
                    <input className="sa-form-input" type="time" value={n.end} onChange={(e) => updateNap(i, 'end', e.target.value)} />
                  </div>
                </div>
              </div>
            ))}
            {naps.length < 4 && <button className="sa-btn-secondary" onClick={addNapRow}>+ Agregar otra siesta</button>}
            <button className="sa-btn-primary" onClick={finishWithNaps}>Listo</button>
          </>
        )}
      </div>
    </div>
  );
}


function ProfileSetupModal({ onSave, onCancel, title, subtitle, saveLabel }) {
  const [name, setName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [nightTarget, setNightTarget] = useState('20:00');
  const todayISOStr = fmtDateISO(new Date());
  const isFutureDate = birthDate && birthDate > todayISOStr;

  return (
    <div className="sa-modal-backdrop">
      <div className="sa-modal">
        <div className="sa-hero-title" style={{ color: 'var(--ink)' }}>{title || 'Antes de empezar'}</div>
        <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>{subtitle || 'Contame un poco sobre el bebé para calibrar las primeras predicciones.'}</div>
        <label className="sa-form-label">Nombre del bebé</label>
        <input className="sa-form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Mía" />
        <label className="sa-form-label">Fecha de nacimiento</label>
        <input className="sa-form-input" type="date" max={todayISOStr} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
        {isFutureDate && (
          <div style={{ fontSize: 12.5, color: 'var(--alert)', marginTop: 6 }}>
            La fecha de nacimiento no puede ser en el futuro.
          </div>
        )}
        <label className="sa-form-label">Hora objetivo para dormir de noche</label>
        <input className="sa-form-input" type="time" value={nightTarget} onChange={(e) => setNightTarget(e.target.value)} />
        <button
          className="sa-btn-primary"
          disabled={!birthDate || !name || isFutureDate}
          onClick={() => onSave({ name, birthDate, nightTarget, nightCutoffHour: 18 })}
        >{saveLabel || 'Empezar a registrar'}</button>
        {onCancel && <button className="sa-btn-secondary" onClick={onCancel}>Cancelar</button>}
        <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 14, textAlign: 'center', lineHeight: 1.5 }}>
          Las recomendaciones son orientativas y se basan en los datos registrados y en patrones de sueño. No sustituyen el consejo de un profesional de la salud.
        </div>
      </div>
    </div>
  );
}

function SelectProfileScreen({ profiles, onSelect, onAddNew }) {
  const initials = (n) => (n || '?').trim().slice(0, 2).toUpperCase();
  return (
    <div className="sa-content" style={{ paddingTop: 10 }}>
      <div className="sa-hero-title" style={{ color: 'var(--star)', fontSize: 22, textAlign: 'center', margin: '10px 0 4px' }}>¿A quién estás siguiendo?</div>
      <div style={{ fontSize: 13, color: '#C9C4E0', textAlign: 'center', marginBottom: 22 }}>Elegí un perfil para ver sus predicciones.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
        {profiles.map((p, i) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
          >
            <div style={{
              width: 64, height: 64, borderRadius: '50%',
              background: PROFILE_COLORS[i % PROFILE_COLORS.length],
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#2B1E08', fontWeight: 700, fontSize: 20,
              boxShadow: '0 6px 16px rgba(0,0,0,0.25)',
            }}>
              {initials(p.name)}
            </div>
            <span style={{ fontSize: 13, color: '#F1EEFA', fontWeight: 600, textAlign: 'center' }}>{p.name}</span>
          </button>
        ))}
        <button
          onClick={onAddNew}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
        >
          <div style={{
            width: 64, height: 64, borderRadius: '50%', border: '1.5px dashed #7A749E',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#C9C4E0',
          }}>
            <Plus size={22} />
          </div>
          <span style={{ fontSize: 13, color: '#C9C4E0', fontWeight: 600 }}>Agregar</span>
        </button>
      </div>
    </div>
  );
}


function ProfileBar({ profiles, activeProfileId, onSwitch, onAddNew }) {
  const initials = (n) => (n || '?').trim().slice(0, 2).toUpperCase();
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 2 }}>
      {profiles.map((p, i) => {
        const active = p.id === activeProfileId;
        return (
          <button
            key={p.id}
            onClick={() => onSwitch(p.id)}
            style={{
              flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              background: 'none', border: 'none', cursor: 'pointer', padding: 0, opacity: active ? 1 : 0.55,
            }}
          >
            <div style={{
              width: 40, height: 40, borderRadius: '50%',
              background: PROFILE_COLORS[i % PROFILE_COLORS.length],
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#2B1E08', fontWeight: 700, fontSize: 14,
              border: active ? '2px solid #F5EFD9' : '2px solid transparent',
            }}>
              {initials(p.name)}
            </div>
            <span style={{ fontSize: 10.5, color: '#E4E0F2', maxWidth: 48, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
          </button>
        );
      })}
      <button
        onClick={onAddNew}
        style={{
          flexShrink: 0, width: 40, height: 40, borderRadius: '50%', border: '1.5px dashed #6B6595',
          background: 'none', color: '#C9C4E0', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        }}
      ><Plus size={17} /></button>
    </div>
  );
}


const TIME_OFFSETS = [
  { label: 'Ahora', mins: 0 },
  { label: 'Hace 5 min', mins: 5 },
  { label: 'Hace 15 min', mins: 15 },
  { label: 'Hace 30 min', mins: 30 },
  { label: 'Hace 1 h', mins: 60 },
  { label: 'Hace 2 h', mins: 120 },
];

function EventTimeModal({ type, now, onSave, onClose }) {
  const [time, setTime] = useState(fmtTime(now));
  const meta = EVENT_META[type];
  const Icon = meta.icon;

  return (
    <div className="sa-modal-backdrop" onClick={onClose}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sa-hero-title" style={{ color: 'var(--ink)', fontSize: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon size={18} color={meta.color} /> {meta.label}
        </div>
        <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 2 }}>¿A qué hora pasó?</div>
        <div className="sa-quick-row" style={{ marginTop: 12 }}>
          {TIME_OFFSETS.map((o) => (
            <button
              key={o.label}
              className="sa-quick-btn"
              onClick={() => setTime(fmtTime(new Date(now.getTime() - o.mins * 60000)))}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="sa-form-label">O elegí la hora exacta</label>
        <input className="sa-form-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <button className="sa-btn-primary" onClick={() => { onSave(time); onClose(); }}>Guardar</button>
        <button className="sa-btn-secondary" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

function FeedingModal({ now, onSave, onClose }) {
  const [time, setTime] = useState(fmtTime(now));
  const [ml, setMl] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="sa-modal-backdrop" onClick={onClose}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sa-hero-title" style={{ color: 'var(--ink)', fontSize: 20 }}>Registrar mamadera</div>
        <label className="sa-form-label">Hora</label>
        <input className="sa-form-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <label className="sa-form-label">Cantidad (ml)</label>
        <input className="sa-form-input" type="number" value={ml} onChange={(e) => setMl(e.target.value)} placeholder="Ej: 150" />
        <label className="sa-form-label">Observación (opcional)</label>
        <input className="sa-form-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej: tomó con ganas" />
        <button className="sa-btn-primary" onClick={() => { onSave(time, ml, note); onClose(); }}>Guardar</button>
        <button className="sa-btn-secondary" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

const SIGN_OPTIONS = [
  { key: 'tired', label: 'Está con sueño / bosteza' },
  { key: 'crying', label: 'Está irritable o llorando' },
  { key: 'refuses_sleep', label: 'Muestra sueño pero no se duerme' },
  { key: 'active', label: 'Está muy activa' },
];

function SignModal({ now, onSave, onClose }) {
  return (
    <div className="sa-modal-backdrop" onClick={onClose}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sa-hero-title" style={{ color: 'var(--ink)', fontSize: 20 }}>¿Qué está mostrando?</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          {SIGN_OPTIONS.map((o) => (
            <button key={o.key} className="sa-quick-btn" style={{ justifyContent: 'flex-start' }} onClick={() => { onSave(o.key, o.label); onClose(); }}>
              {o.label}
            </button>
          ))}
        </div>
        <button className="sa-btn-secondary" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

function EditEventModal({ event, onSave, onClose }) {
  const [time, setTime] = useState(fmtTime(new Date(event.time)));
  const [ml, setMl] = useState(event.data?.ml || '');
  return (
    <div className="sa-modal-backdrop" onClick={onClose}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sa-hero-title" style={{ color: 'var(--ink)', fontSize: 20 }}>Editar evento — {EVENT_META[event.type].label}</div>
        <label className="sa-form-label">Hora</label>
        <input className="sa-form-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        {event.type === 'feeding' && (
          <>
            <label className="sa-form-label">Cantidad (ml)</label>
            <input className="sa-form-input" type="number" value={ml} onChange={(e) => setMl(e.target.value)} />
          </>
        )}
        <button className="sa-btn-primary" onClick={() => { onSave(time, ml); onClose(); }}>Guardar cambios</button>
        <button className="sa-btn-secondary" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

function ImportModal({ onImport, onClose, todayISO }) {
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayISO);
  const [result, setResult] = useState(null);

  const preview = () => {
    const r = parseImportText(text, date);
    setResult(r);
  };

  const confirmImport = () => {
    const r = result || parseImportText(text, date);
    onImport(r.events);
    onClose();
  };

  return (
    <div className="sa-modal-backdrop" onClick={onClose}>
      <div className="sa-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sa-hero-title" style={{ color: 'var(--ink)', fontSize: 20 }}>Importar historial</div>
        <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4, lineHeight: 1.5 }}>
          Pegá una lista de eventos, uno por línea. Ej: <em>"13:30 despertó"</em>, <em>"17:20 mamadera 150 ml"</em>, <em>"20:30 se durmió"</em>. Si son de varios días, poné una línea con la fecha (ej. <em>"05/09"</em>) antes de esos eventos.
        </div>
        <label className="sa-form-label">Fecha por defecto para las líneas sin fecha</label>
        <input className="sa-form-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <label className="sa-form-label">Texto a importar</label>
        <textarea
          className="sa-form-input"
          style={{ minHeight: 160, fontFamily: 'inherit', resize: 'vertical' }}
          value={text}
          onChange={(e) => { setText(e.target.value); setResult(null); }}
          placeholder={'13:30 despertó\n16:07 se durmió\n16:50 despertó\n17:20 mamadera 150 ml\n20:30 se durmió'}
        />
        {result && (
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--ink-soft)' }}>
            Se reconocieron <strong>{result.events.length}</strong> eventos.
            {result.skipped.length > 0 && (
              <div style={{ marginTop: 6, color: 'var(--alert)' }}>
                No se entendieron {result.skipped.length} línea{result.skipped.length === 1 ? '' : 's'}: {result.skipped.slice(0, 3).join(' · ')}{result.skipped.length > 3 ? '…' : ''}
              </div>
            )}
          </div>
        )}
        {!result ? (
          <button className="sa-btn-primary" disabled={!text.trim()} onClick={preview}>Previsualizar</button>
        ) : (
          <button className="sa-btn-primary" disabled={result.events.length === 0} onClick={confirmImport}>Importar {result.events.length} evento{result.events.length === 1 ? '' : 's'}</button>
        )}
        <button className="sa-btn-secondary" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}

/* ======================================================================
   9. APP PRINCIPAL
   ====================================================================== */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState([]); // [{id, name, birthDate, nightTarget, nightCutoffHour}]
  const [activeProfileId, setActiveProfileId] = useState(null);
  const [entered, setEntered] = useState(false); // true una vez que se eligió un perfil en esta sesión
  const [dataByProfile, setDataByProfile] = useState({}); // { [profileId]: { days: {date:[events]}, learningBias: {...} } }
  const [tab, setTab] = useState('home');
  const [now, setNow] = useState(new Date());
  const [messages, setMessages] = useState([]);
  const [selectedHistoryDate, setSelectedHistoryDate] = useState(null);
  const [feedingModalOpen, setFeedingModalOpen] = useState(false);
  const [signModalOpen, setSignModalOpen] = useState(false);
  const [eventModalType, setEventModalType] = useState(null); // 'wake' | 'sleep' | null
  const [editingEvent, setEditingEvent] = useState(null);
  const [addProfileModalOpen, setAddProfileModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [checkInDismissed, setCheckInDismissed] = useState({}); // { "profileId:date": true }
  const [saveError, setSaveError] = useState(false);
  const [demoStep, setDemoStep] = useState(0);
  const demoBaseDateRef = useRef(null);
  const lastPredictionRef = useRef(null);

  const DEFAULT_BIAS = { napBiasMinutes: 0, nightBiasMinutes: 0 };

  // reloj vivo
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // carga inicial
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY, false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          setProfiles(parsed.profiles || []);
          setActiveProfileId(parsed.activeProfileId || (parsed.profiles?.[0]?.id ?? null));
          setDataByProfile(parsed.dataByProfile || {});
        }
      } catch (e) {
        // no hay datos guardados todavía
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const persist = useCallback(async (nextProfiles, nextActiveId, nextDataByProfile) => {
    try {
      const payload = { profiles: nextProfiles, activeProfileId: nextActiveId, dataByProfile: nextDataByProfile };
      const result = await window.storage.set(STORAGE_KEY, JSON.stringify(payload), false);
      if (!result) setSaveError(true); else setSaveError(false);
    } catch (e) {
      setSaveError(true);
    }
  }, []);

  const profile = useMemo(() => profiles.find((p) => p.id === activeProfileId) || null, [profiles, activeProfileId]);
  const profileData = (dataByProfile[activeProfileId]) || { days: {}, learningBias: DEFAULT_BIAS };
  const daysData = profileData.days || {};
  const learningBias = profileData.learningBias || DEFAULT_BIAS;

  const todayISO = resolveEventBucket(now, daysData, profile?.nightCutoffHour ?? 18);

  useEffect(() => { setSelectedHistoryDate(todayISO); }, [todayISO, activeProfileId]);

  const todayEvents = daysData[todayISO] || [];

  const checkInKey = activeProfileId ? `${activeProfileId}:${todayISO}` : null;
  const dailyCheckInOpen = !!(profile && entered && todayEvents.length === 0 && checkInKey && !checkInDismissed[checkInKey]);

  const historyDays = useMemo(() => {
    return Object.entries(daysData)
      .filter(([date]) => date !== todayISO)
      .map(([date, events]) => ({ date, events }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [daysData, todayISO]);

  const engineOut = useMemo(() => {
    if (!profile) return null;
    return runSleepEngine({ profile, todayEvents, historyDays, now, learningBias });
  }, [profile, todayEvents, historyDays, now, learningBias]);

  // aprendizaje: comparar predicción anterior con lo que realmente pasó
  useEffect(() => {
    if (!engineOut || !activeProfileId) return;
    const prev = lastPredictionRef.current;
    if (prev && prev.profileId === activeProfileId && prev.out.action !== 'sleeping' && engineOut.currentState === 'asleep' && prev.out.currentState === 'awake') {
      if (prev.out.nextNapWindow) {
        const predictedMid = new Date((prev.out.nextNapWindow.start.getTime() + prev.out.nextNapWindow.end.getTime()) / 2);
        const diffMin = minutesBetween(predictedMid, now);
        const clampedDiff = clamp(diffMin, -45, 45);
        setDataByProfile((prevData) => {
          const pd = prevData[activeProfileId] || { days: {}, learningBias: DEFAULT_BIAS };
          const nb = { ...pd.learningBias, napBiasMinutes: (pd.learningBias?.napBiasMinutes || 0) * 0.75 + clampedDiff * 0.25 };
          const next = { ...prevData, [activeProfileId]: { ...pd, learningBias: nb } };
          persist(profiles, activeProfileId, next);
          return next;
        });
      }
    }
    lastPredictionRef.current = { profileId: activeProfileId, out: engineOut };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineOut?.currentState, activeProfileId]);

  const mutateDays = useCallback((mutator) => {
    setDataByProfile((prev) => {
      const pd = prev[activeProfileId] || { days: {}, learningBias: DEFAULT_BIAS };
      const nextDays = mutator(pd.days || {});
      const next = { ...prev, [activeProfileId]: { ...pd, days: nextDays } };
      persist(profiles, activeProfileId, next);
      return next;
    });
  }, [activeProfileId, profiles, persist]);

  const addEvent = useCallback((event) => {
    const sd = resolveEventBucket(new Date(event.time), daysData, profile?.nightCutoffHour ?? 18);
    mutateDays((days) => {
      const list = days[sd] ? [...days[sd]] : [];
      list.push({ ...event, id: generateId() });
      return { ...days, [sd]: list };
    });
  }, [mutateDays, daysData, profile]);

  const addEventsBulk = useCallback((events) => {
    mutateDays((days) => {
      const next = { ...days };
      events.forEach((event) => {
        const sd = resolveEventBucket(new Date(event.time), next, profile?.nightCutoffHour ?? 18);
        const list = next[sd] ? [...next[sd]] : [];
        list.push({ ...event, id: generateId() });
        next[sd] = list;
      });
      return next;
    });
  }, [mutateDays, profile]);

  const updateEvent = useCallback((eventId, sd, patch) => {
    mutateDays((days) => ({ ...days, [sd]: (days[sd] || []).map((e) => (e.id === eventId ? { ...e, ...patch } : e)) }));
  }, [mutateDays]);

  const deleteEvent = useCallback((eventId, sd) => {
    mutateDays((days) => ({ ...days, [sd]: (days[sd] || []).filter((e) => e.id !== eventId) }));
  }, [mutateDays]);

  const handleCreateProfile = (p) => {
    if (p.birthDate && p.birthDate > fmtDateISO(new Date())) return; // no permitir nacimientos en el futuro
    const newProfile = { id: generateId(), ...p };
    const nextProfiles = [...profiles, newProfile];
    const nextData = { ...dataByProfile, [newProfile.id]: { days: {}, learningBias: DEFAULT_BIAS } };
    setProfiles(nextProfiles);
    setDataByProfile(nextData);
    setActiveProfileId(newProfile.id);
    setEntered(true);
    setAddProfileModalOpen(false);
    setMessages([]);
    setDemoStep(0);
    persist(nextProfiles, newProfile.id, nextData);
  };

  const handleSelectProfile = (id) => {
    setActiveProfileId(id);
    setEntered(true);
    setMessages([]);
    setDemoStep(0);
    persist(profiles, id, dataByProfile);
  };

  const handleSwitchProfile = (id) => {
    setActiveProfileId(id);
    setMessages([]);
    setDemoStep(0);
    persist(profiles, id, dataByProfile);
  };

  const handleSaveQuickEvent = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d.getTime() - now.getTime() > 5 * 60000) d.setDate(d.getDate() - 1);
    addEvent({ type: eventModalType, time: d.toISOString(), data: {} });
  };

  const handleSaveFeeding = (timeStr, ml, note) => {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(now); d.setHours(h, m, 0, 0);
    addEvent({ type: 'feeding', time: d.toISOString(), data: { ml: ml ? Number(ml) : null, note } });
  };

  const handleSaveSign = (subtype, label) => {
    addEvent({ type: 'sign', time: new Date().toISOString(), data: { subtype, note: label } });
  };

  const handleEditEvent = (ev) => setEditingEvent(ev);
  const handleSaveEditedEvent = (timeStr, ml) => {
    const [h, m] = timeStr.split(':').map(Number);
    const original = new Date(editingEvent.time);
    const d = new Date(original); d.setHours(h, m, 0, 0);
    const sdOld = findBucketForEvent(editingEvent.id, daysData) || sessionDateOf(original);
    const sdNew = resolveEventBucket(d, daysData, profile?.nightCutoffHour ?? 18);
    if (sdOld === sdNew) {
      updateEvent(editingEvent.id, sdOld, { time: d.toISOString(), data: { ...editingEvent.data, ml: ml !== '' ? Number(ml) : editingEvent.data?.ml } });
    } else {
      deleteEvent(editingEvent.id, sdOld);
      addEvent({ type: editingEvent.type, time: d.toISOString(), data: { ...editingEvent.data, ml: ml !== '' ? Number(ml) : editingEvent.data?.ml } });
    }
  };
  const handleDeleteEvent = (ev) => deleteEvent(ev.id, findBucketForEvent(ev.id, daysData) || sessionDateOf(new Date(ev.time)));

  const dismissCheckIn = () => {
    if (checkInKey) setCheckInDismissed((prev) => ({ ...prev, [checkInKey]: true }));
  };

  const buildTimeOnDate = (timeStr, baseDate) => {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(baseDate);
    d.setHours(h, m, 0, 0);
    return d;
  };

  const handleFinishCheckIn = (wakeTimeStr, naps) => {
    let wakeDate = buildTimeOnDate(wakeTimeStr, now);
    if (wakeDate.getTime() - now.getTime() > 5 * 60000) wakeDate = new Date(wakeDate.getTime() - 24 * 3600000);
    const events = [{ type: 'wake', time: wakeDate.toISOString(), data: {} }];
    naps.forEach((nap) => {
      if (!nap.start) return;
      const start = buildTimeOnDate(nap.start, wakeDate);
      events.push({ type: 'sleep', time: start.toISOString(), data: {} });
      if (nap.end) {
        let end = buildTimeOnDate(nap.end, wakeDate);
        if (end < start) end = new Date(end.getTime() + 24 * 3600000); // cruzó medianoche
        events.push({ type: 'wake', time: end.toISOString(), data: {} });
      }
    });
    addEventsBulk(events);
    dismissCheckIn();
  };

  const handleAddDemoEvent = () => {
    if (demoStep >= DEMO_EVENTS.length) return;
    if (!demoBaseDateRef.current) demoBaseDateRef.current = new Date(now);
    const spec = DEMO_EVENTS[demoStep];
    const [h, m] = spec.hm.split(':').map(Number);
    const d = new Date(demoBaseDateRef.current);
    if (h < 5) d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
    const data = spec.type === 'feeding' ? { ml: spec.ml, note: 'Ejemplo' } : { note: 'Ejemplo' };
    addEvent({ type: spec.type, time: d.toISOString(), data });
    setDemoStep((s) => s + 1);
  };

  const handleChatSend = (text) => {
    setMessages((m) => [...m, { role: 'user', text }]);
    const parsed = parseMessage(text, now);
    if (parsed.kind === 'event') {
      addEvent(parsed.event);
      setTimeout(() => {
        setMessages((m) => [...m, { role: 'assistant', text: `Anotado: ${EVENT_META[parsed.event.type]?.label?.toLowerCase() || parsed.event.type} a las ${fmtTime(new Date(parsed.event.time))}. ${engineOut ? engineOut.recommendation : ''}` }]);
      }, 150);
    } else if (parsed.kind === 'question') {
      const answer = engineOut ? answerQuestion(text, engineOut, profile) : 'Todavía estoy cargando los datos del bebé.';
      setMessages((m) => [...m, { role: 'assistant', text: answer }]);
    } else {
      setMessages((m) => [...m, { role: 'assistant', text: 'No estoy segura de haber entendido ese evento. Probá algo como "se despertó 16:50", "tomó mamadera 150 ml" o "está con sueño".' }]);
    }
  };

  const handleImportEvents = (events) => addEventsBulk(events);

  const allDaysList = useMemo(() => Object.keys(daysData).sort((a, b) => new Date(b) - new Date(a)), [daysData]);

  if (loading) {
    return (
      <div className="sa-root" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <Styles />
        <div style={{ color: 'var(--star)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <Loader2 className="sa-spin" size={26} />
          <span style={{ fontSize: 13 }}>Cargando...</span>
        </div>
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="sa-root">
        <Styles />
        <StarField />
        <div className="sa-header">
          <div className="sa-brand">
            <div className="sa-brand-icon"><Moon size={19} /></div>
            <div>
              <div className="sa-brand-name">Luna</div>
              <div className="sa-brand-sub">asistente de sueño para bebés</div>
            </div>
          </div>
        </div>
        <ProfileSetupModal onSave={handleCreateProfile} />
      </div>
    );
  }

  if (!entered) {
    return (
      <div className="sa-root">
        <Styles />
        <StarField />
        <div className="sa-header">
          <div className="sa-brand">
            <div className="sa-brand-icon"><Moon size={19} /></div>
            <div>
              <div className="sa-brand-name">Luna</div>
              <div className="sa-brand-sub">asistente de sueño para bebés</div>
            </div>
          </div>
        </div>
        <SelectProfileScreen profiles={profiles} onSelect={handleSelectProfile} onAddNew={() => setAddProfileModalOpen(true)} />
        {addProfileModalOpen && (
          <ProfileSetupModal
            title="Agregar otro bebé"
            subtitle="Cada perfil tiene su propio historial y predicciones, sin mezclarse."
            saveLabel="Crear perfil"
            onSave={handleCreateProfile}
            onCancel={() => setAddProfileModalOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="sa-root">
      <Styles />
      <StarField />
      <div className="sa-header">
        <div className="sa-header-top">
          <div className="sa-brand">
            <div className="sa-brand-icon"><Moon size={19} /></div>
            <div>
              <div className="sa-brand-name">Luna</div>
              <div className="sa-brand-sub">{profile ? `${Math.round((engineOut?.dec.months ?? 0) * 10) / 10} meses` : 'Elegí un perfil'}</div>
            </div>
          </div>
          {profiles.length > 1 && (
            <button
              onClick={() => setEntered(false)}
              style={{ background: 'none', border: 'none', color: '#C9C4E0', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >Cambiar</button>
          )}
        </div>
        <div style={{ marginTop: 16 }}>
          <ProfileBar profiles={profiles} activeProfileId={activeProfileId} onSwitch={handleSwitchProfile} onAddNew={() => setAddProfileModalOpen(true)} />
        </div>
      </div>

      <div className="sa-content">
        {saveError && (
          <div className="sa-card" style={{ background: 'var(--alert-soft)', color: 'var(--alert)', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
            <AlertTriangle size={16} /> No se pudo guardar el último cambio. Revisá tu conexión.
          </div>
        )}

        {profile && tab === 'home' && engineOut && (
          <HomeScreen
            engineOut={engineOut}
            profile={profile}
            todayEvents={todayEvents}
            onOpenEventModal={setEventModalType}
            onOpenFeedingModal={() => setFeedingModalOpen(true)}
            onOpenSignModal={() => setSignModalOpen(true)}
            onEditEvent={handleEditEvent}
            onDeleteEvent={handleDeleteEvent}
            onAddDemoEvent={handleAddDemoEvent}
            demoStep={demoStep}
          />
        )}

        {profile && tab === 'chat' && (
          <ChatScreen messages={messages} onSend={handleChatSend} engineOut={engineOut} />
        )}

        {profile && tab === 'history' && (
          <HistoryScreen
            allDays={allDaysList.length ? allDaysList : [todayISO]}
            selectedDate={selectedHistoryDate || todayISO}
            onSelectDate={setSelectedHistoryDate}
            events={daysData[selectedHistoryDate] || []}
            profile={profile}
            onEditEvent={handleEditEvent}
            onDeleteEvent={handleDeleteEvent}
            onOpenImport={() => setImportModalOpen(true)}
          />
        )}

        {profile && tab === 'stats' && (
          <StatsScreen allDaysData={{ ...daysData, [todayISO]: todayEvents }} profile={profile} />
        )}

        <div className="sa-disclaimer">
          Las recomendaciones son orientativas y se basan en los datos registrados y en patrones de sueño. No sustituyen el consejo de un profesional de la salud.
        </div>
      </div>

      <div className="sa-tabbar">
        <button className={`sa-tab ${tab === 'home' ? 'active' : ''}`} onClick={() => setTab('home')}><Home size={18} />Ahora</button>
        <button className={`sa-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}><MessageCircle size={18} />Chat</button>
        <button className={`sa-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}><CalendarDays size={18} />Historial</button>
        <button className={`sa-tab ${tab === 'stats' ? 'active' : ''}`} onClick={() => setTab('stats')}><BarChart3 size={18} />Stats</button>
      </div>

      {feedingModalOpen && <FeedingModal now={now} onSave={handleSaveFeeding} onClose={() => setFeedingModalOpen(false)} />}
      {signModalOpen && <SignModal now={now} onSave={handleSaveSign} onClose={() => setSignModalOpen(false)} />}
      {eventModalType && <EventTimeModal type={eventModalType} now={now} onSave={handleSaveQuickEvent} onClose={() => setEventModalType(null)} />}
      {editingEvent && <EditEventModal event={editingEvent} onSave={handleSaveEditedEvent} onClose={() => setEditingEvent(null)} />}
      {addProfileModalOpen && (
        <ProfileSetupModal
          title="Agregar otro bebé"
          subtitle="Cada perfil tiene su propio historial y predicciones, sin mezclarse."
          saveLabel="Crear perfil"
          onSave={handleCreateProfile}
          onCancel={() => setAddProfileModalOpen(false)}
        />
      )}
      {importModalOpen && <ImportModal todayISO={todayISO} onImport={handleImportEvents} onClose={() => setImportModalOpen(false)} />}
      {dailyCheckInOpen && (
        <DailyCheckInModal
          now={now}
          babyName={profile?.name}
          onFinish={handleFinishCheckIn}
          onSkip={dismissCheckIn}
        />
      )}
    </div>
  );
}
