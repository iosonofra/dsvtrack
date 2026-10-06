/**
 * Modulo per il parsing, validazione e scheduling di espressioni Cron standard a 5 campi
 * con supporto esplicito al fuso orario italiano (Europe/Rome).
 */

export const DEFAULT_TIMEZONE = 'Europe/Rome';

export const CRON_PRESETS = [
  {
    id: 'feriali-orario-ufficio',
    label: 'Feriali: ogni ora (08:00 - 19:00)',
    expression: '0 8-19 * * 1-5',
    description: 'Ogni ora dalle 08:00 alle 19:00, dal lunedì al venerdì',
  },
  {
    id: 'tre-volte-giorno',
    label: '3 volte al giorno (09:00, 14:00, 18:30)',
    expression: '0,30 9,14,18 * * 1-5',
    description: 'Alle 09:00, 14:00 e 18:30 nei giorni feriali (lun-ven)',
  },
  {
    id: 'mattina-pomeriggio',
    label: 'Tutti i giorni alle 08:30 e 15:30',
    expression: '30 8,15 * * *',
    description: 'Ogni giorno alle 08:30 e alle 15:30',
  },
  {
    id: 'ogni-30-min-feriali',
    label: 'Ogni 30 min in orario ufficio (08:00 - 18:30)',
    expression: '*/30 8-18 * * 1-5',
    description: 'Ogni 30 minuti dalle 08:00 alle 18:30, dal lunedì al venerdì',
  },
  {
    id: 'giornaliero-mattina',
    label: 'Una volta al giorno alle 08:00',
    expression: '0 8 * * *',
    description: 'Tutti i giorni alle 08:00 del mattino',
  },
];

const MONTH_NAMES = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DAY_NAMES = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

const ITALIAN_WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const ITALIAN_MONTHS = ['', 'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

function parseFieldPart(part, min, max, nameMap = {}) {
  const cleanPart = part.toUpperCase();
  const mapped = nameMap[cleanPart];
  if (mapped !== undefined) return mapped;

  const val = Number.parseInt(cleanPart, 10);
  if (Number.isNaN(val) || val < min || val > max) {
    throw new Error(`Valore non valido "${part}". Deve essere compreso tra ${min} e ${max}.`);
  }
  return val;
}

export function parseCronField(fieldStr, min, max, nameMap = {}) {
  const allowed = new Set();
  const subparts = String(fieldStr).trim().split(',');

  for (const sub of subparts) {
    if (!sub) throw new Error('Campo vuoto tra le virgole');

    if (sub === '*') {
      for (let i = min; i <= max; i++) allowed.add(i);
      continue;
    }

    if (sub.includes('/')) {
      const [rangePart, stepPart] = sub.split('/');
      const step = Number.parseInt(stepPart, 10);
      if (Number.isNaN(step) || step <= 0) {
        throw new Error(`Passo non valido "/${stepPart}"`);
      }

      let start = min;
      let end = max;
      if (rangePart && rangePart !== '*') {
        if (rangePart.includes('-')) {
          const [rStart, rEnd] = rangePart.split('-');
          start = parseFieldPart(rStart, min, max, nameMap);
          end = parseFieldPart(rEnd, min, max, nameMap);
        } else {
          start = parseFieldPart(rangePart, min, max, nameMap);
        }
      }
      for (let i = start; i <= end; i += step) {
        allowed.add(i);
      }
      continue;
    }

    if (sub.includes('-')) {
      const [rStart, rEnd] = sub.split('-');
      const start = parseFieldPart(rStart, min, max, nameMap);
      const end = parseFieldPart(rEnd, min, max, nameMap);
      if (start > end) {
        throw new Error(`Intervallo non valido "${sub}": l'inizio è maggiore della fine.`);
      }
      for (let i = start; i <= end; i++) {
        allowed.add(i);
      }
      continue;
    }

    const singleVal = parseFieldPart(sub, min, max, nameMap);
    allowed.add(singleVal);
  }

  return allowed;
}

export function parseCronExpression(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Un'espressione Cron standard richiede esattamente 5 campi separati da spazi (ricevuti: ${parts.length}). Formato: "min ora dom mese dow"`);
  }

  const [minStr, hourStr, domStr, monthStr, dowStr] = parts;

  const minutes = parseCronField(minStr, 0, 59);
  const hours = parseCronField(hourStr, 0, 23);
  const daysOfMonth = parseCronField(domStr, 1, 31);
  const months = parseCronField(monthStr, 1, 12, MONTH_NAMES);

  // Per il giorno della settimana: 0 e 7 rappresentano entrambi domenica
  const rawDow = parseCronField(dowStr, 0, 7, DAY_NAMES);
  const daysOfWeek = new Set();
  for (const d of rawDow) {
    daysOfWeek.add(d === 7 ? 0 : d);
  }

  return {
    raw: expression.trim(),
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    hasDomWildcard: domStr === '*',
    hasDowWildcard: dowStr === '*',
  };
}

export function validateCronExpression(expression) {
  try {
    const parsed = parseCronExpression(expression);
    const description = describeCronExpression(expression);
    return {
      valid: true,
      parsed,
      description,
    };
  } catch (err) {
    return {
      valid: false,
      error: err.message,
    };
  }
}

/**
 * Ottiene i componenti di data/ora nel fuso orario indicato.
 */
export function getDateTimePartsInTimeZone(date, timeZone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const values = {};
  for (const p of parts) {
    values[p.type] = p.value;
  }

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = Number.parseInt(values.hour, 10);
  if (hour === 24) hour = 0; // standard ISO / midnight normalize

  return {
    year: Number.parseInt(values.year, 10),
    month: Number.parseInt(values.month, 10),
    day: Number.parseInt(values.day, 10),
    hour,
    minute: Number.parseInt(values.minute, 10),
    second: Number.parseInt(values.second, 10),
    weekday: weekdayMap[values.weekday] ?? 0,
  };
}

/**
 * Calcola la prossima occorrenza valida dell'espressione Cron.
 */
export function getNextCronOccurrence(expression, fromDate = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;

  // Inizia dal minuto successivo esatto (secondi e millisecondi a zero)
  let currentMs = fromDate.getTime();
  // Arrotonda al minuto successivo
  currentMs = Math.floor(currentMs / 60000) * 60000 + 60000;

  // Limite massimo di ricerca: 5 anni
  const maxMs = currentMs + (5 * 366 * 24 * 3600 * 1000);

  while (currentMs < maxMs) {
    const candidateDate = new Date(currentMs);
    const parts = getDateTimePartsInTimeZone(candidateDate, timeZone);

    if (!parsed.months.has(parts.month)) {
      // Salta al prossimo mese per velocizzare la ricerca
      currentMs += 24 * 3600 * 1000;
      continue;
    }

    // Regola standard cron per giorno del mese vs giorno della settimana:
    // Se entrambi non sono wildcard, basta che uno dei due coincida.
    // Se uno è wildcard, deve coincidere l'altro.
    let dayMatch = false;
    if (parsed.hasDomWildcard && parsed.hasDowWildcard) {
      dayMatch = true;
    } else if (!parsed.hasDomWildcard && !parsed.hasDowWildcard) {
      dayMatch = parsed.daysOfMonth.has(parts.day) || parsed.daysOfWeek.has(parts.weekday);
    } else if (!parsed.hasDomWildcard) {
      dayMatch = parsed.daysOfMonth.has(parts.day);
    } else {
      dayMatch = parsed.daysOfWeek.has(parts.weekday);
    }

    if (!dayMatch) {
      // Salta al prossimo giorno (23 ore in avanti per evitare problemi di DST)
      currentMs += 23 * 3600 * 1000;
      // Arrotonda all'inizio dell'ora
      currentMs = Math.floor(currentMs / 3600000) * 3600000;
      continue;
    }

    if (!parsed.hours.has(parts.hour)) {
      // Salta alla prossima ora
      currentMs += 60000;
      continue;
    }

    if (!parsed.minutes.has(parts.minute)) {
      currentMs += 60000;
      continue;
    }

    // Trovata la combinazione valida!
    return candidateDate;
  }

  throw new Error('Nessuna occorrenza trovata entro l\'orizzonte di ricerca consentito.');
}

/**
 * Restituisce le prossime N occorrenze di una data espressione.
 */
export function getNextCronOccurrences(expression, count = 5, fromDate = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parsed = typeof expression === 'string' ? parseCronExpression(expression) : expression;
  const results = [];
  let cursor = fromDate;

  for (let i = 0; i < count; i++) {
    const next = getNextCronOccurrence(parsed, cursor, timeZone);
    results.push(next);
    cursor = next;
  }

  return results;
}

/**
 * Genera una descrizione testuale in italiano per l'espressione Cron.
 */
export function describeCronExpression(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) return 'Espressione cron non standard';

  // Controlla se corrisponde a un preset noto
  const matchingPreset = CRON_PRESETS.find((p) => p.expression === expression.trim());
  if (matchingPreset) return matchingPreset.description;

  const [minStr, hourStr, domStr, monthStr, dowStr] = parts;

  let timeDesc = '';
  if (minStr === '*' && hourStr === '*') {
    timeDesc = 'Ogni minuto';
  } else if (minStr.startsWith('*/') && hourStr === '*') {
    timeDesc = `Ogni ${minStr.slice(2)} minuti`;
  } else if (minStr === '0' && hourStr === '*') {
    timeDesc = 'All\'inizio di ogni ora';
  } else if (minStr === '0' && hourStr.includes('-')) {
    const [hStart, hEnd] = hourStr.split('-');
    timeDesc = `Ogni ora dalle ${hStart.padStart(2, '0')}:00 alle ${hEnd.padStart(2, '0')}:00`;
  } else if (hourStr.startsWith('*/')) {
    timeDesc = `Al minuto ${minStr} ogni ${hourStr.slice(2)} ore`;
  } else {
    const hours = hourStr.split(',').map((h) => `${h.padStart(2, '0')}:00`);
    if (minStr !== '0' && !minStr.includes(',')) {
      timeDesc = `Alle ore ${hourStr.split(',').map((h) => `${h.padStart(2, '0')}:${minStr.padStart(2, '0')}`).join(', ')}`;
    } else {
      timeDesc = `Alle ore ${hours.join(', ')}`;
    }
  }

  let dayDesc = '';
  if (dowStr === '1-5') {
    dayDesc = 'nei giorni feriali (lun-ven)';
  } else if (dowStr === '0,6' || dowStr === '6,0') {
    dayDesc = 'nel fine settimana (sab-dom)';
  } else if (dowStr !== '*') {
    const days = dowStr.split(',').map((d) => ITALIAN_WEEKDAYS[Number.parseInt(d, 10)] || d);
    dayDesc = `ogni ${days.join(', ')}`;
  } else if (domStr !== '*') {
    dayDesc = `il giorno ${domStr} del mese`;
  } else {
    dayDesc = 'tutti i giorni';
  }

  let monthDesc = '';
  if (monthStr !== '*') {
    const months = monthStr.split(',').map((m) => ITALIAN_MONTHS[Number.parseInt(m, 10)] || m);
    monthDesc = ` in ${months.join(', ')}`;
  }

  return `${timeDesc} ${dayDesc}${monthDesc}`.trim();
}
