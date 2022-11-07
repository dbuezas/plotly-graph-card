import { HomeAssistant } from "custom-card-helpers";
import { compactRanges, subtractRanges } from "./date-ranges";
import fetchStatistics from "./fetch-statistics";
import fetchStates from "./fetch-states";
import {
  TimestampRange,
  isEntityIdAttrConfig,
  EntityConfig,
  isEntityIdStateConfig,
  isEntityIdStatisticsConfig,
  HistoryInRange,
  EntityState,
} from "../types";

export function mapValues<T, S>(
  o: Record<string, T>,
  fn: (value: T, key: string) => S
) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v, k)]));
}
async function fetchSingleRange(
  hass: HomeAssistant,
  entity: EntityConfig,
  [startT, endT]: number[],
  significant_changes_only: boolean,
  minimal_response: boolean
): Promise<HistoryInRange> {
  // We fetch slightly more than requested. The reason is the following:
  // When fetching data in a range `[startT,endT]`, Home Assistant adds a fictitious datapoint at
  // the start of the fetched period containing a copy of the first datapoint that occurred before
  // `startT`, except if there is actually one at `startT`.
  // We fetch slightly more than requested (`[startT-1,endT]`) and we mark the datapoint at
  // `startT-1` to be deleted (`fake_boundary_datapoint`). When merging the fetched data with the
  // cached one, we keep the fictitious datapoint only if it's placed at the start, otherwise it's
  // discarded. We don't really know whether the datapoint is fictitious or it's a real datapoint
  // that happened to be exactly at `startT-1`, therefore we purposely fetch it outside cached range
  // (which is `[startT,endT]`). Since it is not cached by our caching system, it will be requested
  // again in following fetches. If it's a real datapoint, it will be returned with new fetches,
  // otherwise it won't (which means that it was fictitious).
  //
  // Examples:
  //
  // * = fictitious
  // + = real
  // _ = fetched range
  //
  //       _________       1st fetch
  //       * +   +
  //       ^
  //       '-- point at the edge, kept
  //
  // _______               2nd fetch
  // *   + * +   +
  // ^     ^
  // |     '--- discarded as it was fictitious
  // '--- point at the edge, kept
  //
  //              ________ 3rd fetch
  // *   +   +   +*  +   +
  // ^            ^
  // |            '--- discarded as it is fictitious
  // '--- point at the edge, kept

  const start = new Date(startT - 1);
  endT = Math.min(endT, Date.now());
  const end = new Date(endT);
  let history: EntityState[];
  if (isEntityIdStatisticsConfig(entity)) {
    history = await fetchStatistics(hass, entity, [start, end]);
  } else {
    history = await fetchStates(
      hass,
      entity,
      [start, end],
      significant_changes_only,
      minimal_response
    );
  }

  let range: [number, number] = [startT, endT];
  if (history.length) {
    history[0].fake_boundary_datapoint = true;
  }
  return {
    range,
    history,
  };
}

export function getEntityKey(entity: EntityConfig) {
  if (isEntityIdAttrConfig(entity)) {
    return `${entity.entity}::${entity.attribute}`;
  } else if (isEntityIdStatisticsConfig(entity)) {
    return `${entity.entity}::statistics::${entity.statistic}::${entity.period}`;
  } else if (isEntityIdStateConfig(entity)) {
    return entity.entity;
  }
  throw new Error(`Entity malformed:${JSON.stringify(entity)}`);
}
export default class Cache {
  ranges: Record<string, TimestampRange[]> = {};
  histories: Record<string, EntityState[]> = {};
  busy = Promise.resolve(); // mutex

  add(entity: EntityConfig, states: EntityState[], range: [number, number]) {
    const entityKey = getEntityKey(entity);
    let h = (this.histories[entityKey] ??= []);
    h.push(...states);
    h.sort((a, b) => a.timestamp - b.timestamp);
    h = h.filter((x, i) => i == 0 || !x.fake_boundary_datapoint);
    h = h.filter((_, i) => h[i - 1]?.timestamp !== h[i].timestamp);
    this.histories[entityKey] = h;
    this.ranges[entityKey] ??= [];
    this.ranges[entityKey].push(range);
    this.ranges[entityKey] = compactRanges(this.ranges[entityKey]);
  }

  clearCache() {
    this.ranges = {};
    this.histories = {};
  }
  getHistory(entity: EntityConfig) {
    let key = getEntityKey(entity);
    return this.histories[key] || [];
  }
  async update(
    range: TimestampRange,
    removeOutsideRange: boolean,
    entities: EntityConfig[],
    hass: HomeAssistant,
    significant_changes_only: boolean,
    minimal_response: boolean
  ) {
    return (this.busy = this.busy
      .catch(() => {})
      .then(async () => {
        if (removeOutsideRange) {
          this.removeOutsideRange(range);
        }
        const promises = entities.flatMap(async (entity) => {
          const entityKey = getEntityKey(entity);
          this.ranges[entityKey] ??= [];
          const rangesToFetch = subtractRanges([range], this.ranges[entityKey]);
          for (const aRange of rangesToFetch) {
            const fetchedHistory = await fetchSingleRange(
              hass,
              entity,
              aRange,
              significant_changes_only,
              minimal_response
            );
            if (fetchedHistory === null) continue;
            this.add(entity, fetchedHistory.history, fetchedHistory.range);
          }
        });

        await Promise.all(promises);
      }));
  }

  removeOutsideRange(range: TimestampRange) {
    this.ranges = mapValues(this.ranges, (ranges) =>
      subtractRanges(ranges, [
        [Number.NEGATIVE_INFINITY, range[0] - 1],
        [range[1] + 1, Number.POSITIVE_INFINITY],
      ])
    );
    this.histories = mapValues(this.histories, (history) => {
      let first: EntityState | undefined;
      let last: EntityState | undefined;
      const newHistory = history.filter((datum) => {
        if (datum.timestamp <= range[0]) first = datum;
        else if (!last && datum.timestamp >= range[1]) last = datum;
        else return true;
        return false;
      });
      if (first) {
        newHistory.unshift(first);
      }
      if (last) {
        newHistory.push(last);
      }
      return newHistory;
    });
  }
}
