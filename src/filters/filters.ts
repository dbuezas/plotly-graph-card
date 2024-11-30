import propose from "propose";
import { HomeAssistant } from "custom-card-helpers";
import {
  parseTimeDuration,
  TimeDurationStr,
  timeUnits,
} from "../duration/duration";
import { StatisticValue } from "../recorder-types";
import { HassEntity, YValue } from "../types";

import BaseRegression from "ml-regression-base";
import LinearRegression from "ml-regression-simple-linear";
import PolynomialRegression from "ml-regression-polynomial";
import PowerRegression from "ml-regression-power";
import ExponentialRegression from "ml-regression-exponential";
import TheilSenRegression from "ml-regression-theil-sen";
import { RobustPolynomialRegression } from "ml-regression-robust-polynomial";
import FFTRegression from "./fft-regression";

const castFloat = (y: any) => parseFloat(y);
const myEval = typeof window != "undefined" ? window.eval : global.eval;

type FilterData = {
  xs: Date[];
  ys: YValue[];
  states: HassEntity[];
  statistics: StatisticValue[];
  meta: HassEntity["attributes"];
  vars: Record<any, any>;
  hass: HomeAssistant;
};
export type FilterFn = (p: FilterData) => Partial<FilterData>;

type FilterParam<K extends keyof typeof filters> = Parameters<
  (typeof filters)[K]
>[0];

type CheckType<T, IfUndef, IfNonUndef> =
  | (T extends undefined ? IfUndef : never)
  | (T extends unknown ? IfNonUndef : never);

export type FilterInput = {
  [K in keyof typeof filters]: CheckType<
    FilterParam<K>,
    K,
    { [P in K]: Exclude<FilterParam<K>, undefined> }
  >;
}[keyof typeof filters];

const mapNumbers = (ys: YValue[], fn: (y: number, i: number) => number) =>
  ys.map((y, i) => {
    const n = castFloat(y);
    if (Number.isNaN(n)) return y;
    return fn(n, i);
  });

/**
 * Removes from all params the indexes for which ys is not numeric, and parses ys to numbers.
 * WARNING: when used inside a filter, it is important to return all arrays. Otherwise the lengths
 * between say ys and states won't be consistent
 */
const force_numeric: (p: FilterData) => { ys: number[] } & FilterData = ({
  xs,
  ys: ys2,
  states,
  statistics,
  ...rest
}) => {
  const ys = ys2.map((y) => castFloat(y));
  const mask = ys.map((y) => !isNaN(y));
  return {
    ys: ys.filter((_, i) => mask[i]),
    xs: xs.filter((_, i) => mask[i]),
    states: states.filter((_, i) => mask[i]),
    statistics: statistics.filter((_, i) => mask[i]),
    ...rest,
  };
};

const filters = {
  force_numeric: () => force_numeric,
  add:
    (val: number) =>
    ({ ys }) => ({
      ys: mapNumbers(ys, (y) => y + val),
    }),
  multiply:
    (val: number) =>
    ({ ys }) => ({
      ys: mapNumbers(ys, (y) => y * val),
    }),
  calibrate_linear:
    (mappingStr: `${number} -> ${number}`[]) =>
    ({ ys, meta }) => {
      const mapping = mappingStr.map((str) => str.split("->").map(parseFloat));
      const regression = new LinearRegression(
        mapping.map(([x, _y]) => x),
        mapping.map(([_x, y]) => y),
      );
      return {
        ys: regression.predict(ys.map(castFloat)),
        meta: { ...meta, regression },
      };
    },
  deduplicate_adjacent:
    () =>
    ({ xs, ys, states, statistics }) => {
      const mask = ys.map((y, i) => y !== ys[i - 1]);
      return {
        ys: ys.filter((_, i) => mask[i]),
        xs: xs.filter((_, i) => mask[i]),
        states: states.filter((_, i) => mask[i]),
        statistics: statistics.filter((_, i) => mask[i]),
      };
    },
  delta:
    () =>
    ({ ys, meta, xs, statistics, states }) => {
      const last = {
        y: NaN,
      };
      return {
        meta: {
          ...meta,
          unit_of_measurement: `Δ${meta.unit_of_measurement}`,
        },
        ys: mapNumbers(ys, (y) => {
          const yDelta = y - last.y;
          last.y = y;
          return yDelta;
        }).slice(1),
        xs: xs.slice(1),
        statistics: statistics.slice(1),
        states: states.slice(1),
      };
    },
  derivate:
    (unit: keyof typeof timeUnits = "h") =>
    ({ xs, ys, meta }) => {
      const last = {
        x: +xs[0],
        y: NaN,
      };
      checkTimeUnits(unit);
      checkTimeUnits(unit);
      return {
        meta: {
          ...meta,
          unit_of_measurement: `${meta.unit_of_measurement}/${unit}`,
        },
        xs,
        ys: mapNumbers(ys, (y, i) => {
          const x = +xs[i];
          const dateDelta = (x - last.x) / timeUnits[unit];
          const yDeriv = (y - last.y) / dateDelta;
          last.y = y;
          last.x = x;
          return yDeriv;
        }),
      };
    },
  integrate: (
    unitOrObject:
      | keyof typeof timeUnits
      | {
          unit?: keyof typeof timeUnits;
          reset_every?: TimeDurationStr;
          offset?: TimeDurationStr;
        } = "h",
  ) => {
    const param =
      typeof unitOrObject == "string" ? { unit: unitOrObject } : unitOrObject;
    const unit = param.unit ?? "h";
    const reset_every = parseTimeDuration(param.reset_every ?? "0s");
    const offset = parseTimeDuration(param.offset ?? "0s");
    checkTimeUnits(unit);
    const date = new Date();
    date.setHours(0);
    date.setMinutes(0);
    date.setSeconds(0);
    const t0 = +date + offset;
    return ({ xs, ys, meta }) => {
      let yAcc = 0;
      let last = {
        x: NaN,
        laps: 0,
        y: 0,
      };
      return {
        meta: {
          ...meta,
          unit_of_measurement: `${meta.unit_of_measurement}${unit}`,
        },
        xs: xs,
        ys: mapNumbers(ys, (y, i) => {
          const x = +xs[i];
          if (reset_every > 0) {
            const laps = Math.floor((x - t0) / reset_every);
            if (laps !== last.laps) {
              yAcc = 0;
              last.laps = laps;
            }
          }
          const dateDelta = (x - last.x) / timeUnits[unit];
          const isFirst = isNaN(last.x);
          last.x = x;
          if (isFirst) return NaN;
          yAcc += last.y * dateDelta;
          last.y = y;
          return yAcc;
        }),
      };
    };
  },
  sliding_window_moving_average:
    ({
      window_size = 10,
      extended = false,
      centered = true,
    }: { window_size?: number; extended?: boolean; centered?: boolean } = {}) =>
    (params) => {
      const { xs, ys, ...rest } = force_numeric(params);
      const ys2: number[] = [];
      const xs2: Date[] = [];
      let acc = {
        y: 0,
        count: 0,
        x: 0,
      };
      for (let i = 0; i < ys.length + window_size; i++) {
        if (i < ys.length) {
          acc.x += +xs[i];
          acc.y += ys[i];
          acc.count++;
        }
        if (i >= window_size) {
          acc.x -= +xs[i - window_size];
          acc.y -= ys[i - window_size];
          acc.count--;
        }
        if ((i >= window_size && i < ys.length) || extended) {
          if (centered) xs2.push(new Date(acc.x / acc.count));
          else xs2.push(xs[i]);
          ys2.push(acc.y / acc.count);
        }
      }
      return { xs: xs2, ys: ys2, ...rest };
    },
  median:
    ({
      window_size = 10,
      extended = false,
      centered = true,
    }: { window_size?: number; extended?: boolean; centered?: boolean } = {}) =>
    (params) => {
      const { xs, ys, ...rest } = force_numeric(params);
      const ys2: number[] = [];
      const xs2: Date[] = [];
      let acc = {
        ys: [] as number[],
        x: 0,
      };
      for (let i = 0; i < ys.length + window_size; i++) {
        if (i < ys.length) {
          acc.x += +xs[i];
          acc.ys.push(ys[i]);
        }
        if (i >= window_size) {
          acc.x -= +xs[i - window_size];
          acc.ys.shift();
        }
        if ((i >= window_size && i < ys.length) || extended) {
          if (centered) xs2.push(new Date(acc.x / acc.ys.length));
          else xs2.push(xs[i]);
          const sorted = acc.ys.slice().sort();
          const mid1 = Math.floor(sorted.length / 2);
          const mid2 = Math.ceil(sorted.length / 2);
          ys2.push((sorted[mid1] + sorted[mid2]) / 2);
        }
      }
      return { ys: ys2, xs: xs2, ...rest };
    },
  exponential_moving_average:
    ({ alpha = 0.1 }: { alpha?: number } = {}) =>
    (params) => {
      const { ys, ...rest } = force_numeric(params);
      let last = ys[0];
      return {
        ys: ys.map((y) => (last = last * (1 - alpha) + y * alpha)),
        ...rest,
      };
    },
  map_y_numbers: (fnStr: string) => {
    const fn = myEval(
      `(i, x, y, state, statistic, xs, ys, states, statistics, meta, vars, hass) => ${fnStr}`,
    );
    return ({ xs, ys, states, statistics, meta, vars, hass }) => ({
      xs,
      ys: mapNumbers(ys, (_, i) =>
        // prettier-ignore
        fn(i, xs[i], ys[i], states[i], statistics[i], xs, ys, states, statistics, meta, vars, hass),
      ),
    });
  },
  map_y: (fnStr: string) => {
    const fn = myEval(
      `(i, x, y, state, statistic, xs, ys, states, statistics, meta, vars, hass) => ${fnStr}`,
    );
    return ({ xs, ys, states, statistics, meta, vars, hass }) => ({
      xs,
      ys: ys.map((_, i) =>
        // prettier-ignore
        fn(i, xs[i], ys[i], states[i], statistics[i], xs, ys, states, statistics, meta, vars, hass),
      ),
    });
  },
  map_x: (fnStr: string) => {
    const fn = myEval(
      `(i, x, y, state, statistic, xs, ys, states, statistics, meta, vars, hass) => ${fnStr}`,
    );
    return ({ xs, ys, states, statistics, meta, vars, hass }) => ({
      ys,
      xs: xs.map((_, i) =>
        // prettier-ignore
        fn(i, xs[i], ys[i], states[i], statistics[i], xs, ys, states, statistics, meta, vars, hass),
      ),
    });
  },
  resample:
    (intervalStr: TimeDurationStr = "5m") =>
    ({ xs, ys, states, statistics }) => {
      const data = {
        xs: [] as Date[],
        ys: [] as YValue[],
        states: [] as HassEntity[],
        statistics: [] as StatisticValue[],
      };
      const interval = parseTimeDuration(intervalStr);
      const x0 = Math.floor(+xs[0] / interval) * interval;
      const x1 = +xs[xs.length - 1];
      let i = 0;
      for (let x = x0; x < x1; x += interval) {
        while (+xs[i + 1] < x && i < xs.length - 1) {
          i++;
        }
        data.xs.push(new Date(x));
        data.ys.push(ys[i]);
        if (states[i]) data.states.push(states[i]);
        if (statistics[i]) data.statistics.push(statistics[i]);
      }
      return data;
    },
    resample_int:
    (intervalStr: TimeDurationStr = "5m") =>
    ({ xs, ys, states, statistics }) => {
      const data = {
        xs: [] as Date[],
        ys: [] as YValue[],
        states: [] as HassEntity[],
        statistics: [] as StatisticValue[],
      };
      const interval = parseTimeDuration(intervalStr);
      const x0 = Math.floor(+xs[0] / interval) * interval;
      const x1 = +xs[xs.length - 1];
      let i = 0;
      for (let x = x0; x < x1; x += interval) {
        while (+xs[i + 1] < x && i < xs.length - 1) {
          i++;
        }
        data.xs.push(new Date(x));
        data.ys.push( ys[i] + (ys[i+1]-ys[i])/(xs[i+1]-xs[i])*(x-xs[i]) ); //linear interpolation between xs[i] and xs[i+1] at time x
        if (states[i]) data.states.push(states[i]);
        if (statistics[i]) data.statistics.push(statistics[i]);
      }
      return data;
    },
  load_var:
    (var_name: string) =>
    ({ vars }) =>
      vars[var_name],
  store_var:
    (var_name: string) =>
    ({ vars, xs, ys, states, statistics, meta }) => ({
      vars: { ...vars, [var_name]: { xs, ys, states, statistics, meta } },
    }),
  trendline: (p3: TrendlineType | Partial<TrendlineParam> = "linear") => {
    let p2: Partial<TrendlineParam> = {};
    if (typeof p3 == "string") {
      p2 = { type: p3 };
    } else p2 = { ...p3 };
    p2.type ??= "linear";
    p2.forecast ??= "0s";
    p2.show_formula ??= false;
    p2.show_r2 ??= false;
    p2.degree ??= 2;
    const p = p2 as TrendlineParam;
    const forecast = parseTimeDuration(p.forecast);
    return (data) => {
      const { xs, ys, meta, ...rest } = force_numeric(data);
      const t0 = +xs[0] - 0.1; // otherwise the power series doesn't work
      const t1 = +xs[xs.length - 1];
      const xs_numbers = xs.map((x) => +x - t0);
      let RegressionClass = trendlineTypes[p.type];
      if (!RegressionClass) {
        throw new Error(
          `Trendline '${p.type}' doesn't exist. Did you mean <b>${propose(
            p.type,
            Object.keys(trendlineTypes),
          )}<b>?\nOthers: ${Object.keys(trendlineTypes)}`,
        );
      }
      const regression: BaseRegression = new RegressionClass(
        xs_numbers,
        ys,
        p.degree,
      );
      let extras: string[] = [];
      if (p.show_r2)
        extras.push(
          `r²=${maxDecimals(regression.score(xs_numbers, ys).r2, 2)}`,
        );

      if (forecast > 0) {
        const N = Math.round(
          (xs_numbers.length /
            (xs_numbers[xs_numbers.length - 1] - xs_numbers[0])) *
            forecast,
        );
        xs_numbers.push(
          ...Array.from({ length: N }).map(
            (_, i) => t1 - t0 + (forecast / N) * i,
          ),
        );
      }
      const ys_out = regression.predict(xs_numbers);

      if (p.show_formula) extras.push(regression.toString(2));
      return {
        ...rest,
        xs: xs_numbers.map((x) => new Date(x + t0)),
        ys: ys_out,
        meta: {
          ...meta,
          friendly_name:
            "Trend" + (extras.length ? ` (${extras.join(", ")})` : ""),
        },
      };
    };
  },
  fn: (fnStr: string) => myEval(fnStr),
  /*
      example: fn("({xs, ys, states, statistics }) => ({xs: ys})")
    */
  filter: (fnStr: string) => {
    const fn = myEval(
      `(i, x, y, state, statistic, xs, ys, states, statistics, meta, vars, hass) => ${fnStr}`,
    );
    return ({ xs, ys, states, statistics, meta, vars, hass }) => {
      const mask = ys.map((_, i) =>
        // prettier-ignore
        fn(i, xs[i], ys[i], states[i], statistics[i], xs, ys, states, statistics, meta, vars, hass),
      );
      return {
        ys: ys.filter((_, i) => mask[i]),
        xs: xs.filter((_, i) => mask[i]),
        states: states.filter((_, i) => mask[i]),
        statistics: statistics.filter((_, i) => mask[i]),
      };
    };
  },
} satisfies Record<string, (...args: any[]) => FilterFn>;
export default filters;
function checkTimeUnits(unit: string) {
  if (!timeUnits[unit]) {
    throw new Error(
      `Unit '${unit}' is not valid, use ${Object.keys(timeUnits)}`,
    );
  }
}
const trendlineTypes = {
  linear: LinearRegression,
  polynomial: PolynomialRegression,
  power: PowerRegression,
  exponential: ExponentialRegression,
  theil_sen: TheilSenRegression,
  robust_polynomial: RobustPolynomialRegression,
  fft: FFTRegression,
};
type TrendlineType = keyof typeof trendlineTypes;
type TrendlineParam = {
  type: TrendlineType;
  forecast: TimeDurationStr;
  show_formula: boolean;
  show_r2: boolean;
  degree: number;
};
function maxDecimals(n: number, decimals: number) {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}
