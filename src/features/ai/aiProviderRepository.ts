import type { AiProvider, AiRoutePreference } from "./providerTypes.js";

export interface AiProviderSettingsRepository {
  getPreference(guildId: string): Promise<AiRoutePreference>;
  setPreference(guildId: string, preference: AiRoutePreference): Promise<void>;
}

export type AiTokenReservationStatus = "pending" | "settled" | "released";

export type AiUsageSnapshot = {
  orgTargetTokens: number;
  botReportedTokens: number;
};

export type AiTokenReservation = {
  reservationId: string;
  provider: AiProvider;
  usageDate: string;
  reservedTokens: number;
  status: AiTokenReservationStatus;
  actualTokens: number | null;
};

export type AiTokenReservationRequest = {
  reservationId: string;
  provider: AiProvider;
  usageDate: string;
  reservedTokens: number;
  threshold: number;
  snapshot: AiUsageSnapshot;
};

export type AiTokenReservationResult = {
  allowed: boolean;
  duplicate: boolean;
  effectiveTokens: number;
  reason?: "threshold_exceeded" | "reservation_released";
  reservation?: AiTokenReservation;
};

export interface AiProviderBudgetRepository {
  tryReserve(input: AiTokenReservationRequest): Promise<AiTokenReservationResult>;
  settle(reservationId: string, actualTokens: number): Promise<AiTokenReservation | null>;
  consumeEstimate(reservationId: string): Promise<AiTokenReservation | null>;
  release(reservationId: string): Promise<AiTokenReservation | null>;
}
