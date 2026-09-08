function isOlderHistoryBatch(mode, scrollDelta = 0) {
  return mode === 'ondemand_older'
    || mode === 'deep_backfill'
    || mode === 'bulk_full'
    || (mode === 'ondemand_viewport' && Number(scrollDelta) < 0);
}

module.exports = { isOlderHistoryBatch };
