import { createContext, useContext } from "react";
import type { ProductionSummary } from "@clearframe/shared";

interface SlateValue {
  productions: ProductionSummary[];
  refreshSlate: () => Promise<void>;
}

export const WorkspaceContext = createContext<SlateValue>({
  productions: [],
  refreshSlate: async () => {},
});

export const useSlate = (): SlateValue => useContext(WorkspaceContext);
