export enum TelemetryMode {
  MEASURED = 'measured',
  DERIVED = 'derived',
  UNAVAILABLE = 'unavailable',
}

export type TelemetryModeMap = Record<string, TelemetryMode>;
