export function canApplyVerifiedImportRow(row, { updateState = false, updateTracking = true, overwriteTracking = false } = {}) {
  return Boolean(row?.canApply) && (row.verification !== 'Tracking già presente' || Boolean(updateState) || (Boolean(updateTracking) && Boolean(overwriteTracking)));
}
