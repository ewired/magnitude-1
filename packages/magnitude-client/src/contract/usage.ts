/**
 * AUTO-GENERATED — do not edit manually.
 */

import type { BillingWindowBudget, BillingWindowName } from "./errors"

export interface UsageWindowsResponse {
  readonly meta: {
    readonly generatedAt: string
  }
  readonly usageWindows: Record<BillingWindowName, BillingWindowBudget>
}
