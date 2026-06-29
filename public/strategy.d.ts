export type Severity = "high" | "medium" | "low" | "good";
export interface Finding {
  id: string;
  severity: Severity;
  params: Record<string, string | number>;
}
export interface ChannelBreakdown {
  channels: { name: string; value: number }[];
}
export const STRATEGY: Record<string, number>;
export function analyzeSite(summary: Record<string, unknown>, detail?: ChannelBreakdown): Finding[];
