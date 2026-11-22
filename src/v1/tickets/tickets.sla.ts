// B1 — SLA P1–P4 (BD-02): janela comercial 08:00–18:00 America/Sao_Paulo (UTC-3,
// sem DST desde 2019). Horas de SLA contam somente dentro da janela, dias úteis
// (seg–sex). Feriados nacionais ficam fora do v1 (decisão BD-02 não os menciona).

const SP_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3
const DAY_START_MIN = 8 * 60; // 08:00
const DAY_END_MIN = 18 * 60; // 18:00
const MINUTES_IN_DAY = 24 * 60;

/** Converte um instante para { dia local (epoch day), minutos do dia } em SP. */
function toSpParts(date: Date): { epochDay: number; minuteOfDay: number } {
  const spMs = date.getTime() - SP_OFFSET_MS;
  const epochDay = Math.floor(spMs / (MINUTES_IN_DAY * 60 * 1000));
  const minuteOfDay = Math.floor((spMs % (MINUTES_IN_DAY * 60 * 1000)) / 60000);
  return { epochDay, minuteOfDay };
}

/** Dia da semana local SP: 0=domingo .. 6=sábado. */
function spWeekday(epochDay: number): number {
  // epoch day 0 = quinta (1970-01-01); SP está atrás de UTC, mas para datas
  // >= epoch a diferença nunca cruza a meia-noite de forma relevante aqui
  // porque epochDay já é o dia local.
  const utcWeekday = (4 + epochDay) % 7; // 1970-01-01 era quinta
  return ((utcWeekday % 7) + 7) % 7;
}

function isBusinessDay(epochDay: number): boolean {
  const wd = spWeekday(epochDay);
  return wd >= 1 && wd <= 5; // seg–sex
}

/** Soma `hours` horas úteis (janela 08–18 SP, seg–sex) a `start`. */
export function addBusinessHours(start: Date, hours: number): Date {
  let remainingMin = hours * 60;
  let { epochDay, minuteOfDay } = toSpParts(start);

  // avança para o próximo dia útil se estiver fora da janela
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!isBusinessDay(epochDay)) {
      epochDay += 1;
      minuteOfDay = 0;
      continue;
    }
    if (minuteOfDay < DAY_START_MIN) {
      minuteOfDay = DAY_START_MIN; // antes das 08h → começa às 08h
    }
    if (minuteOfDay >= DAY_END_MIN) {
      epochDay += 1; // após 18h → próximo dia útil
      minuteOfDay = 0;
      continue;
    }
    const availableToday = DAY_END_MIN - minuteOfDay;
    if (remainingMin <= availableToday) {
      minuteOfDay += remainingMin;
      remainingMin = 0;
      break;
    }
    remainingMin -= availableToday;
    epochDay += 1;
    minuteOfDay = 0;
  }

  const spMidnightMs = epochDay * MINUTES_IN_DAY * 60 * 1000;
  return new Date(spMidnightMs + minuteOfDay * 60 * 1000 + SP_OFFSET_MS);
}

/** Metas v1 (BD-02): first response / resolution em horas úteis por prioridade.
 *  Números internos conservadores — nenhuma promessa externa até aprovação NDAAD. */
const SLA_HOURS: Record<
  "P1" | "P2" | "P3" | "P4",
  { first: number; resolution: number }
> = {
  P1: { first: 2, resolution: 8 },
  P2: { first: 4, resolution: 24 },
  P3: { first: 8, resolution: 48 },
  P4: { first: 16, resolution: 80 },
};

export interface SlaDueDates {
  firstResponseDueAt: string;
  resolutionDueAt: string;
}

export function computeSlaDueDates(
  priority: "P1" | "P2" | "P3" | "P4",
  start: Date,
): SlaDueDates {
  const meta = SLA_HOURS[priority];
  return {
    firstResponseDueAt: addBusinessHours(start, meta.first).toISOString(),
    resolutionDueAt: addBusinessHours(start, meta.resolution).toISOString(),
  };
}
