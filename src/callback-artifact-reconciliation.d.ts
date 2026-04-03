import type { BridgeRunStatus } from "./types";
export declare function mapCallbackEventToArtifactState(eventType?: string | null): {
  state: BridgeRunStatus["state"];
  lastEvent: BridgeRunStatus["lastEvent"];
  terminal: boolean;
} | null;
export declare function isTerminalArtifactState(state?: BridgeRunStatus["state"] | null): boolean;
export declare function reconcileRunArtifactSnapshotFromCallback(options: {
  current: BridgeRunStatus;
  eventType?: string | null;
  callbackAt?: string;
  callbackOk?: boolean;
  callbackStatus?: number;
  callbackBody?: string;
  callbackError?: string | undefined;
  includeStateConfidence?: boolean;
  includeRealState?: boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}): BridgeRunStatus | null;
