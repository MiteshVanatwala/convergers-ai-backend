// Admin data access — POC wraps the brain usage log. Provider/credential data
// access lives in admin-providers.service.ts.

import * as usageLog from "../brain/usageLog";

export function getStats() {
  return {
    ...usageLog.summary(),
    recent: usageLog.recent(10),
  };
}
