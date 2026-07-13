import type { CheapSharkDeal } from "./cheapSharkTypes.js";
import { cheapSharkPaidFreeEvidence } from "./steamFreeDetector.js";

export function hasCheapSharkPaidFreeEvidence(deals: CheapSharkDeal[]): boolean {
  return cheapSharkPaidFreeEvidence(deals) !== null;
}
