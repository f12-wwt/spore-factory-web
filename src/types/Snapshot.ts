/** 血统快照（GDD 4.4 SpeciesSnapshot）——死亡/通关时入库，供血统延续与结算 */
export interface SpeciesSnapshot {
  version: number;
  speciesName: string;
  era: string;
  morphology: Record<string, string>;
  networkSummary: string;
  cognitionTags: string[];
  behavior: {
    aggression: number;
    predation: number;
    social: number;
    migration: number;
    reproduction: number;
  };
  historicalScore: number;
  strategyTag: string;
}
